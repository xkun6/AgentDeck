//! Desktop environment diagnostics.
//!
//! Checks: data/log directories, the Node sidecar status, the effective PATH
//! and optional CLI tools. Checks are read-only; a missing tool may carry a
//! one-click install plan from a hard-coded whitelist (winget / brew / npm),
//! which only runs when the user triggers `environment_install` for that id.

use serde::Serialize;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::process::sidecar::{SidecarStatus, SidecarStatusPayload};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EnvironmentCheckStatus {
    Ok,
    Warning,
    Error,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EnvironmentCheckCategory {
    Core,
    Runtime,
    Tools,
    Browser,
    Paths,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentCheckItem {
    pub id: String,
    pub category: EnvironmentCheckCategory,
    pub label: String,
    pub status: EnvironmentCheckStatus,
    pub required: bool,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommendation: Option<String>,
    /// 一键安装方案：仅在该项「未找到」且当前平台有白名单方案时给出。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install: Option<EnvironmentInstallHint>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentInstallHint {
    /// 展示给用户的完整命令行。
    pub command: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentInstallResult {
    pub ok: bool,
    pub exit_code: Option<i32>,
    /// stdout + stderr 末尾（最多 INSTALL_OUTPUT_MAX_CHARS 个字符）。
    pub output: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentCheckResult {
    pub generated_at_ms: u64,
    pub platform: String,
    pub arch: String,
    pub data_dir: String,
    pub log_dir: String,
    pub items: Vec<EnvironmentCheckItem>,
}

#[derive(Debug, Clone)]
pub struct EnvironmentCheckInput {
    pub data_dir: PathBuf,
    pub log_dir: PathBuf,
    pub sidecar: SidecarStatusPayload,
}

impl EnvironmentCheckInput {
    pub fn from_state(inner: &crate::state::AppStateInner) -> Self {
        Self {
            data_dir: inner.data_dir.clone(),
            log_dir: inner.log_dir.clone(),
            sidecar: inner.sidecar_status.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct CommandProbe {
    pub(crate) found: bool,
    pub(crate) path: Option<PathBuf>,
    pub(crate) version: Option<String>,
    pub(crate) error: Option<String>,
}

trait EnvironmentPathValue {
    fn to_environment_path_string(&self) -> String;
}

impl EnvironmentPathValue for &Path {
    fn to_environment_path_string(&self) -> String {
        self.to_string_lossy().to_string()
    }
}

impl EnvironmentPathValue for &PathBuf {
    fn to_environment_path_string(&self) -> String {
        self.to_string_lossy().to_string()
    }
}

impl EnvironmentPathValue for PathBuf {
    fn to_environment_path_string(&self) -> String {
        self.to_string_lossy().to_string()
    }
}

impl EnvironmentPathValue for String {
    fn to_environment_path_string(&self) -> String {
        self.clone()
    }
}

impl EnvironmentPathValue for &str {
    fn to_environment_path_string(&self) -> String {
        (*self).to_string()
    }
}

impl EnvironmentCheckItem {
    fn new(
        id: &str,
        category: EnvironmentCheckCategory,
        label: &str,
        status: EnvironmentCheckStatus,
        required: bool,
        summary: impl Into<String>,
    ) -> Self {
        Self {
            id: id.to_string(),
            category,
            label: label.to_string(),
            status,
            required,
            summary: summary.into(),
            version: None,
            path: None,
            details: None,
            recommendation: None,
            install: None,
        }
    }

    fn version(mut self, version: Option<String>) -> Self {
        self.version = version;
        self
    }

    fn path(mut self, path: Option<impl EnvironmentPathValue>) -> Self {
        self.path = path.map(|p| p.to_environment_path_string());
        self
    }

    fn details(mut self, details: Option<impl Into<String>>) -> Self {
        self.details = details.map(Into::into);
        self
    }

    fn recommendation(mut self, recommendation: Option<impl Into<String>>) -> Self {
        self.recommendation = recommendation.map(Into::into);
        self
    }

    fn install(mut self, install: Option<EnvironmentInstallHint>) -> Self {
        self.install = install;
        self
    }
}

pub async fn collect_environment_check(input: EnvironmentCheckInput) -> EnvironmentCheckResult {
    let mut items = vec![
        check_writable_item(WritableCheck {
            id: "data-dir",
            category: EnvironmentCheckCategory::Core,
            label: "数据目录",
            required: true,
            path: &input.data_dir,
            ok_summary: "数据目录可写",
            fail_summary: "数据目录不可写，界面状态与会话元数据无法保存",
            recommendation: Some("检查目录权限，或设置 AGENTDECK_HOME 指向可写目录"),
        }),
        check_writable_item(WritableCheck {
            id: "log-dir",
            category: EnvironmentCheckCategory::Core,
            label: "日志目录",
            required: true,
            path: &input.log_dir,
            ok_summary: "日志目录可写",
            fail_summary: "日志目录不可写，sidecar 日志无法写入",
            recommendation: Some("检查数据目录权限后重启应用"),
        }),
        sidecar_item(&input.sidecar),
    ];

    items.push(tool_item(ToolCheck {
        id: "git",
        label: "Git",
        commands: &["git"],
        version_args: &["--version"],
        required: false,
        ok_summary: "Git 可用，用于源码更新、部分技能和仓库操作",
        missing_summary: "Git 未找到；大多数基础功能可用，但源码/仓库相关能力会受限",
        recommendation: Some(
            "安装 Git：macOS 可运行 xcode-select --install，Windows 安装 Git for Windows",
        ),
    }));
    items.push(tool_item(ToolCheck {
        id: "bash",
        label: "Bash / Git Bash",
        commands: bash_candidates().as_slice(),
        version_args: &["--version"],
        required: false,
        ok_summary: "Bash 可用，终端工具可执行 POSIX shell 命令",
        missing_summary: "Bash 未找到；Windows 上终端工具通常需要 Git Bash",
        recommendation: Some("Windows 请安装 Git for Windows；macOS/Linux 通常系统自带 bash"),
    }));
    items.push(check_node_item());
    items.push(tool_item(ToolCheck {
        id: "npm",
        label: "npm",
        commands: npm_candidates().as_slice(),
        version_args: &["--version"],
        required: false,
        ok_summary: "npm 可用，可安装浏览器工具等 Node 依赖",
        missing_summary: "npm 未找到；浏览器工具或部分扩展能力可能无法安装",
        recommendation: Some("安装 Node.js LTS，或确认 npm 所在目录已加入 PATH"),
    }));
    items.push(tool_item(ToolCheck {
        id: "ripgrep",
        label: "ripgrep (rg)",
        commands: &["rg"],
        version_args: &["--version"],
        required: false,
        ok_summary: "ripgrep 可用，文件搜索会更快",
        missing_summary: "ripgrep 未找到；文件搜索会退回较慢实现或部分能力不可用",
        recommendation: Some(
            "安装 ripgrep：brew install ripgrep / winget install BurntSushi.ripgrep.MSVC",
        ),
    }));
    items.push(tool_item(ToolCheck {
        id: "ffmpeg",
        label: "ffmpeg",
        commands: &["ffmpeg"],
        version_args: &["-version"],
        required: false,
        ok_summary: "ffmpeg 可用，音视频处理能力可用",
        missing_summary: "ffmpeg 未找到；音视频转码、部分语音/媒体能力会受限",
        recommendation: Some("安装 ffmpeg：brew install ffmpeg / winget install Gyan.FFmpeg"),
    }));
    let mut agent_browser = tool_item(ToolCheck {
        id: "agent-browser",
        label: "agent-browser",
        commands: agent_browser_candidates().as_slice(),
        version_args: &["--version"],
        required: false,
        ok_summary: "agent-browser CLI 可用，浏览器自动化能力更完整",
        missing_summary: "agent-browser 未找到；浏览器自动化工具可能不可用",
        recommendation: Some("安装 Node.js 后运行 npm install -g agent-browser"),
    });
    agent_browser.category = EnvironmentCheckCategory::Browser;
    items.push(agent_browser);
    // 编程Agent CLI（P-047 委派可视化的检测基本盘）。这里只做 PATH 快检；
    // 额外安装点与登录态的深度检测在 coding_agents.rs（「编程Agent」设置页）。
    items.push(tool_item(ToolCheck {
        id: "claude-code",
        label: "Claude Code CLI",
        commands: &["claude"],
        version_args: &["--version"],
        required: false,
        ok_summary: "Claude Code 可用，可在 AgentDeck 中创建 Claude Code 会话",
        missing_summary: "Claude Code 未找到；无法创建 Claude Code 会话",
        recommendation: Some(
            "安装 Claude Code：npm install -g @anthropic-ai/claude-code，安装后运行 claude 完成登录",
        ),
    }));
    items.push(tool_item(ToolCheck {
        id: "codex",
        label: "Codex CLI",
        commands: &["codex"],
        version_args: &["--version"],
        required: false,
        ok_summary: "Codex CLI 可用，可在 AgentDeck 中创建 Codex 会话",
        missing_summary: "Codex CLI 未找到；无法创建 Codex 会话",
        recommendation: Some(
            "安装 Codex CLI：npm install -g @openai/codex，安装后运行 codex login 完成登录",
        ),
    }));
    items.push(effective_path_item(
        &crate::path_resolver::snapshot(),
        crate::path_resolver::runtime_path_stale(),
    ));

    EnvironmentCheckResult {
        generated_at_ms: now_ms(),
        platform: current_platform_label(),
        arch: std::env::consts::ARCH.to_string(),
        data_dir: input.data_dir.to_string_lossy().to_string(),
        log_dir: input.log_dir.to_string_lossy().to_string(),
        items,
    }
}

fn sidecar_item(sidecar: &SidecarStatusPayload) -> EnvironmentCheckItem {
    let (status, summary, recommendation) = match sidecar.status {
        SidecarStatus::Ready => (
            EnvironmentCheckStatus::Ok,
            "sidecar 运行中，Agent 会话可用".to_string(),
            None,
        ),
        SidecarStatus::Starting => (
            EnvironmentCheckStatus::Unknown,
            "sidecar 正在启动".to_string(),
            Some("等待启动完成；如长时间不变，请重启 sidecar"),
        ),
        SidecarStatus::Failed => (
            EnvironmentCheckStatus::Error,
            "sidecar 启动失败，Agent 会话不可用".to_string(),
            Some("确认已安装 Node.js 后重启 sidecar；详情见日志目录中的 sidecar.log"),
        ),
        SidecarStatus::Stopped => (
            EnvironmentCheckStatus::Warning,
            "sidecar 未运行".to_string(),
            Some("重启 sidecar"),
        ),
    };
    EnvironmentCheckItem::new(
        "sidecar",
        EnvironmentCheckCategory::Runtime,
        "Node sidecar",
        status,
        true,
        summary,
    )
    .version(sidecar.version.clone())
    .path((!sidecar.ws_url.is_empty()).then(|| sidecar.ws_url.clone()))
    .details(sidecar.error.clone())
    .recommendation(recommendation)
}

struct WritableCheck<'a> {
    id: &'a str,
    category: EnvironmentCheckCategory,
    label: &'a str,
    required: bool,
    path: &'a Path,
    ok_summary: &'a str,
    fail_summary: &'a str,
    recommendation: Option<&'a str>,
}

fn check_writable_item(check: WritableCheck<'_>) -> EnvironmentCheckItem {
    match check_writable_dir(check.path) {
        Ok(()) => EnvironmentCheckItem::new(
            check.id,
            check.category,
            check.label,
            EnvironmentCheckStatus::Ok,
            check.required,
            check.ok_summary,
        )
        .path(Some(check.path)),
        Err(err) => EnvironmentCheckItem::new(
            check.id,
            check.category,
            check.label,
            EnvironmentCheckStatus::Error,
            check.required,
            check.fail_summary,
        )
        .path(Some(check.path))
        .details(Some(err))
        .recommendation(check.recommendation),
    }
}

fn check_writable_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    let probe = path.join(format!(".agentdeck-env-check-{}", std::process::id()));
    fs::write(&probe, b"ok").map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&probe);
    Ok(())
}

struct ToolCheck<'a> {
    id: &'a str,
    label: &'a str,
    commands: &'a [&'a str],
    version_args: &'a [&'a str],
    required: bool,
    ok_summary: &'a str,
    missing_summary: &'a str,
    recommendation: Option<&'a str>,
}

fn tool_item(check: ToolCheck<'_>) -> EnvironmentCheckItem {
    let probe = probe_commands(check.commands, check.version_args);
    if probe.found {
        let status = if probe.error.is_some() {
            EnvironmentCheckStatus::Warning
        } else {
            EnvironmentCheckStatus::Ok
        };
        EnvironmentCheckItem::new(
            check.id,
            EnvironmentCheckCategory::Tools,
            check.label,
            status,
            check.required,
            check.ok_summary,
        )
        .path(probe.path.as_ref())
        .version(probe.version)
        .details(probe.error)
        .recommendation(
            (status == EnvironmentCheckStatus::Warning)
                .then_some("命令存在但版本探测失败，请确认它可以在终端中正常运行"),
        )
    } else {
        EnvironmentCheckItem::new(
            check.id,
            EnvironmentCheckCategory::Tools,
            check.label,
            if check.required {
                EnvironmentCheckStatus::Error
            } else {
                EnvironmentCheckStatus::Warning
            },
            check.required,
            check.missing_summary,
        )
        .details(probe.error)
        .recommendation(check.recommendation.map(missing_tool_recommendation))
        .install(current_install_hint(check.id))
    }
}

/// Shared remediation suffix: detection now follows the login-shell /
/// registry PATH, so a fresh install only needs a re-check — and a sidecar
/// restart for agents the running sidecar spawns itself.
fn missing_tool_recommendation(base: &str) -> String {
    format!("{base}；安装后点「刷新检查」即可重新探测，若 sidecar 已在运行需重启 sidecar 生效")
}

fn check_node_item() -> EnvironmentCheckItem {
    let probe = probe_commands(&["node"], &["--version"]);
    if !probe.found {
        return EnvironmentCheckItem::new(
            "node",
            EnvironmentCheckCategory::Tools,
            "Node.js",
            EnvironmentCheckStatus::Warning,
            false,
            "Node.js 未找到；浏览器工具和部分扩展能力可能不可用",
        )
        .details(probe.error)
        .recommendation(Some(missing_tool_recommendation(
            "安装 Node.js LTS 20.19+ 或 22.12+",
        )))
        .install(current_install_hint("node"));
    }

    let version_text = probe.version.clone().unwrap_or_default();
    let ok_version = node_satisfies_build(&version_text);
    EnvironmentCheckItem::new(
        "node",
        EnvironmentCheckCategory::Tools,
        "Node.js",
        if ok_version {
            EnvironmentCheckStatus::Ok
        } else {
            EnvironmentCheckStatus::Warning
        },
        false,
        if ok_version {
            "Node.js 版本满足桌面端与浏览器工具构建要求"
        } else {
            "Node.js 版本偏旧，浏览器工具或本地构建可能失败"
        },
    )
    .path(probe.path.as_ref())
    .version(probe.version)
    .details(probe.error)
    .recommendation((!ok_version).then_some("升级到 Node.js 20.19+ 或 22.12+"))
}

fn effective_path_item(
    snapshot: &crate::path_resolver::EffectivePath,
    runtime_stale: bool,
) -> EnvironmentCheckItem {
    use crate::path_resolver::ShellProbeOutcome;

    let entry_count = snapshot.entries.len();
    let (mut status, summary) = match &snapshot.probe {
        ShellProbeOutcome::Ok { shell } => (
            EnvironmentCheckStatus::Ok,
            format!("已合并登录 shell（{shell}）PATH，共 {entry_count} 个目录"),
        ),
        ShellProbeOutcome::Timeout { shell } => (
            EnvironmentCheckStatus::Warning,
            format!("登录 shell（{shell}）PATH 读取超时，当前仅使用进程 PATH 和常见安装目录"),
        ),
        ShellProbeOutcome::Failed { shell, error } => (
            EnvironmentCheckStatus::Warning,
            format!(
                "登录 shell（{shell}）PATH 读取失败（{error}），当前仅使用进程 PATH 和常见安装目录"
            ),
        ),
        ShellProbeOutcome::Disabled => (
            EnvironmentCheckStatus::Ok,
            format!(
                "已按 AGENTDECK_DISABLE_SHELL_PATH 跳过登录 shell 导入，共 {entry_count} 个目录"
            ),
        ),
        ShellProbeOutcome::NotApplicable => (
            EnvironmentCheckStatus::Ok,
            format!("已合并注册表系统/用户 PATH，共 {entry_count} 个目录"),
        ),
    };
    let mut recommendation: Option<String> = None;
    if runtime_stale {
        status = EnvironmentCheckStatus::Warning;
        recommendation = Some(
            "PATH 自 sidecar 启动后发生变化，请重启 sidecar 让它拉起的 Agent 看到新 PATH"
                .to_string(),
        );
    }

    const MAX_DETAIL_ENTRIES: usize = 15;
    let mut lines: Vec<String> = snapshot
        .entries
        .iter()
        .take(MAX_DETAIL_ENTRIES)
        .map(|(path, source)| format!("{}（{}）", path.display(), path_source_label(*source)))
        .collect();
    if entry_count > MAX_DETAIL_ENTRIES {
        lines.push(format!("… 共 {entry_count} 项"));
    }

    EnvironmentCheckItem::new(
        "effective-path",
        EnvironmentCheckCategory::Paths,
        "PATH 解析",
        status,
        false,
        summary,
    )
    .details((!lines.is_empty()).then(|| lines.join("\n")))
    .recommendation(recommendation)
}

fn path_source_label(source: crate::path_resolver::PathSource) -> &'static str {
    use crate::path_resolver::PathSource;
    match source {
        PathSource::Process => "进程",
        PathSource::LoginShell => "登录 shell",
        PathSource::RegistryMachine => "系统注册表",
        PathSource::RegistryUser => "用户注册表",
        PathSource::WellKnown => "常见目录",
    }
}

pub(crate) fn probe_commands(commands: &[&str], version_args: &[&str]) -> CommandProbe {
    let mut missing = Vec::new();
    for command in commands {
        match find_on_path(command) {
            Some(path) => {
                let version_probe = run_version_command(&path, version_args);
                return CommandProbe {
                    found: true,
                    path: Some(path),
                    version: version_probe.version,
                    error: version_probe.error,
                };
            }
            None => missing.push(*command),
        }
    }
    CommandProbe {
        found: false,
        path: None,
        version: None,
        error: Some(format!("未在 PATH 中找到 {}", missing.join(" / "))),
    }
}

fn run_version_command(command: &Path, args: &[&str]) -> CommandProbe {
    let mut cmd = Command::new(command);
    cmd.args(args).env("GIT_TERMINAL_PROMPT", "0");
    // 窗口子系统程序拉起控制台程序会闪窗（bash/node/npm.cmd 等版本探测），与 commands/git.rs 一致。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output();
    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let first = stdout
                .lines()
                .chain(stderr.lines())
                .find(|line| !line.trim().is_empty())
                .map(|line| line.trim().to_string());
            CommandProbe {
                found: true,
                path: Some(command.to_path_buf()),
                version: first,
                error: (!output.status.success()).then(|| {
                    format!(
                        "版本命令退出码 {}{}",
                        output.status,
                        if stderr.is_empty() {
                            String::new()
                        } else {
                            format!(": {}", stderr)
                        }
                    )
                }),
            }
        }
        Err(err) => CommandProbe {
            found: true,
            path: Some(command.to_path_buf()),
            version: None,
            error: Some(err.to_string()),
        },
    }
}

fn find_on_path(command: &str) -> Option<PathBuf> {
    let command_path = Path::new(command);
    if command_path.is_absolute() || command.contains(std::path::MAIN_SEPARATOR) {
        return command_path.is_file().then(|| command_path.to_path_buf());
    }

    find_in_entries(command, &crate::path_resolver::effective_entries())
}

pub(crate) fn find_in_entries(command: &str, entries: &[PathBuf]) -> Option<PathBuf> {
    let candidates = executable_candidates(command);
    for dir in entries {
        for candidate in &candidates {
            let path = dir.join(candidate);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

fn executable_candidates(command: &str) -> Vec<OsString> {
    #[cfg(target_os = "windows")]
    {
        let mut out = Vec::new();
        let has_ext = Path::new(command).extension().is_some();
        if has_ext {
            out.push(OsString::from(command));
            return out;
        }
        // Registry PATHEXT first: it survives the stale GUI env block.
        let pathext = crate::path_resolver::effective_pathext()
            .or_else(|| std::env::var("PATHEXT").ok())
            .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_string());
        for ext in pathext.split(';').filter(|s| !s.is_empty()) {
            out.push(OsString::from(format!("{}{}", command, ext)));
            out.push(OsString::from(format!(
                "{}{}",
                command,
                ext.to_ascii_lowercase()
            )));
        }
        out.push(OsString::from(command));
        out
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec![OsString::from(command)]
    }
}

fn bash_candidates() -> Vec<&'static str> {
    #[cfg(target_os = "windows")]
    {
        vec!["bash", "bash.exe"]
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec!["bash"]
    }
}

fn npm_candidates() -> Vec<&'static str> {
    #[cfg(target_os = "windows")]
    {
        vec!["npm.cmd", "npm.exe", "npm"]
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec!["npm"]
    }
}

fn agent_browser_candidates() -> Vec<&'static str> {
    #[cfg(target_os = "windows")]
    {
        vec!["agent-browser.cmd", "agent-browser.exe", "agent-browser"]
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec!["agent-browser"]
    }
}

fn node_satisfies_build(version: &str) -> bool {
    let Some((major, minor, _patch)) = parse_semverish(version) else {
        return false;
    };
    major > 22 || (major == 22 && minor >= 12) || (major == 20 && minor >= 19)
}

fn parse_semverish(version: &str) -> Option<(u64, u64, u64)> {
    let trimmed = version.trim().trim_start_matches('v');
    let mut nums = trimmed
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty());
    let major = nums.next()?.parse().ok()?;
    let minor = nums.next().unwrap_or("0").parse().ok()?;
    let patch = nums.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn current_platform_label() -> String {
    if cfg!(target_os = "windows") {
        "windows".to_string()
    } else if cfg!(target_os = "macos") {
        "macos".to_string()
    } else if cfg!(target_os = "linux") {
        "linux".to_string()
    } else {
        std::env::consts::OS.to_string()
    }
}

// ---------------------------------------------------------------------------
// 一键安装：方案只在这里写死（白名单），前端只传检测项 id，绝不接受任意命令。
// ---------------------------------------------------------------------------

/// winget 统一追加的非交互参数（`winget install --help`，v1.29 确认均有效）。
const WINGET_FLAGS: [&str; 4] = [
    "--accept-package-agreements",
    "--accept-source-agreements",
    "--disable-interactivity",
    "--silent",
];

/// winget 视为成功的非零退出码（winget-cli doc/windows/package-manager/winget/returnCodes.md）：
/// APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE（0x8A15002B，已是最新、无可用升级）、
/// APPINSTALLER_CLI_ERROR_PACKAGE_ALREADY_INSTALLED（0x8A150061，已安装）。
const WINGET_SUCCESS_CODES: [i32; 2] = [0x8A15_002B_u32 as i32, 0x8A15_0061_u32 as i32];

const INSTALL_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const INSTALL_OUTPUT_MAX_CHARS: usize = 4000;

static INSTALL_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InstallPlatform {
    Windows,
    Macos,
    Other,
}

impl InstallPlatform {
    fn current() -> Self {
        if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::Other
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Installer {
    Winget,
    Brew,
    Npm,
}

impl Installer {
    fn display_name(self) -> &'static str {
        match self {
            Self::Winget => "winget",
            Self::Brew => "brew",
            Self::Npm => "npm",
        }
    }

    fn candidates(self) -> Vec<&'static str> {
        match self {
            Self::Winget => vec!["winget"],
            Self::Brew => vec!["brew"],
            Self::Npm => npm_candidates(),
        }
    }

    fn missing_reason(self) -> &'static str {
        match self {
            Self::Winget => "未找到 winget，请从 Microsoft Store 安装“应用安装程序”",
            Self::Brew => "未找到 Homebrew，请先按 https://brew.sh 的说明安装",
            Self::Npm => "需先安装 Node.js（含 npm）",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InstallPlan {
    pub(crate) installer: Installer,
    pub(crate) args: Vec<&'static str>,
}

impl InstallPlan {
    fn command_line(&self) -> String {
        std::iter::once(self.installer.display_name())
            .chain(self.args.iter().copied())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

enum InstallSource {
    /// 系统包管理器：Windows 走 winget（包 id），macOS 走 brew（formula）。
    System {
        winget_id: &'static str,
        brew_formula: &'static str,
    },
    /// npm 全局包（Windows / macOS）。
    NpmGlobal(&'static str),
}

fn install_source(id: &str) -> Option<InstallSource> {
    let system = |winget_id, brew_formula| InstallSource::System {
        winget_id,
        brew_formula,
    };
    Some(match id {
        "git" | "bash" => system("Git.Git", "git"),
        "node" | "npm" => system("OpenJS.NodeJS.LTS", "node"),
        "ripgrep" => system("BurntSushi.ripgrep.MSVC", "ripgrep"),
        "ffmpeg" => system("Gyan.FFmpeg", "ffmpeg"),
        "agent-browser" => InstallSource::NpmGlobal("agent-browser"),
        "claude-code" => InstallSource::NpmGlobal("@anthropic-ai/claude-code"),
        "codex" => InstallSource::NpmGlobal("@openai/codex"),
        _ => return None,
    })
}

/// 白名单方案；未知 id 或当前平台无方案时返回中文错误。
pub(crate) fn install_plan(id: &str, platform: InstallPlatform) -> Result<InstallPlan, String> {
    let source = install_source(id).ok_or_else(|| format!("「{id}」不在一键安装白名单中"))?;
    let plan = match (source, platform) {
        (_, InstallPlatform::Other) => None,
        (InstallSource::System { winget_id, .. }, InstallPlatform::Windows) => {
            let mut args = vec!["install", "--id", winget_id, "-e"];
            args.extend(WINGET_FLAGS);
            Some(InstallPlan {
                installer: Installer::Winget,
                args,
            })
        }
        (InstallSource::System { brew_formula, .. }, InstallPlatform::Macos) => Some(InstallPlan {
            installer: Installer::Brew,
            args: vec!["install", brew_formula],
        }),
        (InstallSource::NpmGlobal(package), _) => Some(InstallPlan {
            installer: Installer::Npm,
            args: vec!["install", "-g", package],
        }),
    };
    plan.ok_or_else(|| format!("当前平台不提供「{id}」的一键安装"))
}

/// 安装器（winget / brew / npm）的绝对路径；找不到时返回中文原因。
fn resolve_installer(installer: Installer, entries: &[PathBuf]) -> Result<PathBuf, String> {
    installer
        .candidates()
        .into_iter()
        .find_map(|command| find_in_entries(command, entries))
        .ok_or_else(|| installer.missing_reason().to_string())
}

pub(crate) fn install_hint(
    id: &str,
    platform: InstallPlatform,
    entries: &[PathBuf],
) -> Option<EnvironmentInstallHint> {
    let plan = install_plan(id, platform).ok()?;
    let resolved = resolve_installer(plan.installer, entries);
    Some(EnvironmentInstallHint {
        command: plan.command_line(),
        available: resolved.is_ok(),
        unavailable_reason: resolved.err(),
    })
}

fn current_install_hint(id: &str) -> Option<EnvironmentInstallHint> {
    install_hint(
        id,
        InstallPlatform::current(),
        &crate::path_resolver::effective_entries(),
    )
}

/// 全局只允许一个安装任务；Drop 时释放。
struct InstallGuard;

impl InstallGuard {
    fn acquire() -> Result<Self, String> {
        INSTALL_RUNNING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| Self)
            .map_err(|_| "已有安装任务在进行".to_string())
    }
}

impl Drop for InstallGuard {
    fn drop(&mut self) {
        INSTALL_RUNNING.store(false, Ordering::SeqCst);
    }
}

fn is_install_success(installer: Installer, exit_code: Option<i32>) -> bool {
    match exit_code {
        Some(0) => true,
        Some(code) => installer == Installer::Winget && WINGET_SUCCESS_CODES.contains(&code),
        None => false,
    }
}

/// winget 用 `\r` 重绘进度条：每行只保留最后一次重绘的内容，避免进度帧挤占输出末尾。
fn collapse_carriage_returns(text: &str) -> String {
    text.lines()
        .map(|line| {
            line.split('\r')
                .rfind(|part| !part.trim().is_empty())
                .unwrap_or("")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 保留末尾 `max_chars` 个字符（按 char 计，不切断 UTF-8），截断时前缀「…」。
fn tail_chars(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        return text.to_string();
    }
    let tail: String = text.chars().skip(count - max_chars).collect();
    format!("…{tail}")
}

fn install_output(stdout: &[u8], stderr: &[u8]) -> String {
    let stdout = collapse_carriage_returns(&String::from_utf8_lossy(stdout));
    let stderr = collapse_carriage_returns(&String::from_utf8_lossy(stderr));
    let combined = [stdout.trim(), stderr.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    tail_chars(&combined, INSTALL_OUTPUT_MAX_CHARS)
}

fn install_command(program: &Path, plan: &InstallPlan) -> Command {
    // npm 在 Windows 上是 npm.cmd：Rust std（1.77.2+）对 .cmd 会经 cmd.exe 调用并安全转义参数；
    // 这里参数全部是白名单常量（无用户输入）。
    let mut cmd = Command::new(program);
    cmd.args(&plan.args)
        .env("PATH", crate::path_resolver::effective_path_os());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// 带超时的 `Command::output()`：stdin null、后台线程读取 stdout/stderr；超时后结束整棵
/// 进程树（npm.cmd 经 cmd.exe 拉起 node，只 kill 直接子进程会留下孙进程继续安装并占住管道）。
fn output_with_tree_kill(
    mut cmd: Command,
    timeout: Duration,
) -> std::io::Result<std::process::Output> {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::Instant;

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn()?;

    fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut buf);
            }
            buf
        })
    }
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());

    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(std::process::Output {
                status,
                stdout: stdout.join().unwrap_or_default(),
                stderr: stderr.join().unwrap_or_default(),
            });
        }
        if Instant::now() >= deadline {
            #[cfg(windows)]
            crate::process::sidecar::force_kill_process_tree(child.id());
            #[cfg(unix)]
            crate::process::sidecar::signal_process_group(child.id(), libc::SIGKILL);
            let _ = child.kill();
            let _ = child.wait();
            // 不 join 读取线程：未能结束的孙进程（如 UAC 提权后的安装器）可能仍持有管道。
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "安装命令超时，已终止",
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// 执行安装命令（stdin null、捕获输出、超时结束进程树）并判定结果。
fn execute_install(
    cmd: Command,
    installer: Installer,
    timeout: Duration,
) -> EnvironmentInstallResult {
    match output_with_tree_kill(cmd, timeout) {
        Ok(output) => {
            let exit_code = output.status.code();
            EnvironmentInstallResult {
                ok: is_install_success(installer, exit_code),
                exit_code,
                output: install_output(&output.stdout, &output.stderr),
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::TimedOut => EnvironmentInstallResult {
            ok: false,
            exit_code: None,
            output: format!("安装超时（超过 {} 秒），已终止", timeout.as_secs()),
        },
        Err(err) => EnvironmentInstallResult {
            ok: false,
            exit_code: None,
            output: format!("无法启动安装命令：{err}"),
        },
    }
}

/// `environment_install` 的阻塞实现：查白名单 → 占用全局锁 → 强制刷新 PATH →
/// 解析安装器 → 执行 → 再次强制刷新 PATH。winget 某些安装包会弹 UAC，属预期。
pub fn run_environment_install(id: &str) -> Result<EnvironmentInstallResult, String> {
    let plan = install_plan(id, InstallPlatform::current())?;
    let _guard = InstallGuard::acquire()?;
    crate::path_resolver::refresh_blocking(crate::path_resolver::SHELL_PROBE_TIMEOUT, true);
    let program = resolve_installer(plan.installer, &crate::path_resolver::effective_entries())?;
    let result = execute_install(
        install_command(&program, &plan),
        plan.installer,
        INSTALL_TIMEOUT,
    );
    crate::path_resolver::refresh_blocking(crate::path_resolver::SHELL_PROBE_TIMEOUT, true);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn node_version_policy_matches_vite_requirement() {
        assert!(!node_satisfies_build("v20.18.1"));
        assert!(node_satisfies_build("v20.19.0"));
        assert!(!node_satisfies_build("v22.11.0"));
        assert!(node_satisfies_build("v22.12.0"));
        assert!(node_satisfies_build("v23.0.0"));
    }

    #[test]
    fn semver_parser_accepts_common_version_lines() {
        assert_eq!(parse_semverish("v22.12.0"), Some((22, 12, 0)));
        assert_eq!(parse_semverish("node 20.19.1"), Some((20, 19, 1)));
        assert_eq!(parse_semverish("git version 2.54.0"), Some((2, 54, 0)));
        assert_eq!(parse_semverish("not a version"), None);
    }

    #[test]
    fn writable_dir_probe_creates_missing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("nested");
        check_writable_dir(&target).unwrap();
        assert!(target.is_dir());
    }

    #[test]
    fn find_in_entries_finds_executable_in_given_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let name = if cfg!(windows) {
            "mytool.exe"
        } else {
            "mytool"
        };
        fs::write(dir.path().join(name), b"#!/bin/sh\n").unwrap();

        let found = find_in_entries(
            "mytool",
            &[PathBuf::from("/nonexistent"), dir.path().to_path_buf()],
        );
        // On Windows the returned path may use PATHEXT-case (.EXE vs .exe).
        #[cfg(not(target_os = "windows"))]
        assert_eq!(found, Some(dir.path().join(name)));
        #[cfg(target_os = "windows")]
        assert!(
            found.is_some() && found.as_ref().unwrap().parent() == Some(dir.path()),
            "expected file in {} found {:?}",
            dir.path().display(),
            found
        );
        assert_eq!(
            find_in_entries("missing-tool", &[dir.path().to_path_buf()]),
            None
        );
    }

    #[test]
    fn find_on_path_absolute_path_short_circuits() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("tool");
        fs::write(&file, b"x").unwrap();
        assert_eq!(find_on_path(file.to_str().unwrap()), Some(file.clone()));
        assert_eq!(
            find_on_path(dir.path().join("absent").to_str().unwrap()),
            None
        );
    }

    #[test]
    fn effective_path_item_warns_when_runtime_stale() {
        use crate::path_resolver::{EffectivePath, PathSource, ShellProbeOutcome};
        let snapshot = EffectivePath {
            entries: vec![(PathBuf::from("/opt/homebrew/bin"), PathSource::LoginShell)],
            probe: ShellProbeOutcome::Ok {
                shell: "/bin/zsh".to_string(),
            },
            pathext: None,
        };

        let fresh = effective_path_item(&snapshot, false);
        assert_eq!(fresh.status, EnvironmentCheckStatus::Ok);
        assert!(fresh.recommendation.is_none());
        assert!(fresh.details.as_deref().unwrap().contains("登录 shell"));

        let stale = effective_path_item(&snapshot, true);
        assert_eq!(stale.status, EnvironmentCheckStatus::Warning);
        assert!(stale
            .recommendation
            .as_deref()
            .unwrap()
            .contains("重启 sidecar"));
    }

    #[test]
    fn effective_path_item_truncates_long_entry_lists() {
        use crate::path_resolver::{EffectivePath, PathSource, ShellProbeOutcome};
        let entries = (0..20)
            .map(|i| (PathBuf::from(format!("/dir{i}")), PathSource::Process))
            .collect();
        let snapshot = EffectivePath {
            entries,
            probe: ShellProbeOutcome::Disabled,
            pathext: None,
        };
        let item = effective_path_item(&snapshot, false);
        let details = item.details.unwrap();
        assert!(details.contains("… 共 20 项"));
        assert!(!details.contains("/dir15"));
    }

    #[test]
    fn missing_tool_recommendation_appends_recheck_hint() {
        let text = missing_tool_recommendation("安装 ripgrep");
        assert!(text.starts_with("安装 ripgrep；"));
        assert!(text.contains("刷新检查"));
        assert!(text.contains("重启 sidecar"));
    }

    fn plan_line(id: &str, platform: InstallPlatform) -> String {
        install_plan(id, platform).unwrap().command_line()
    }

    #[test]
    fn install_plan_maps_whitelist_per_platform() {
        let winget_tail = "-e --accept-package-agreements --accept-source-agreements --disable-interactivity --silent";
        for (id, package) in [
            ("git", "Git.Git"),
            ("bash", "Git.Git"),
            ("node", "OpenJS.NodeJS.LTS"),
            ("npm", "OpenJS.NodeJS.LTS"),
            ("ripgrep", "BurntSushi.ripgrep.MSVC"),
            ("ffmpeg", "Gyan.FFmpeg"),
        ] {
            assert_eq!(
                plan_line(id, InstallPlatform::Windows),
                format!("winget install --id {package} {winget_tail}")
            );
            assert_eq!(
                install_plan(id, InstallPlatform::Windows)
                    .unwrap()
                    .installer,
                Installer::Winget
            );
        }
        for (id, formula) in [
            ("git", "git"),
            ("bash", "git"),
            ("node", "node"),
            ("npm", "node"),
            ("ripgrep", "ripgrep"),
            ("ffmpeg", "ffmpeg"),
        ] {
            assert_eq!(
                plan_line(id, InstallPlatform::Macos),
                format!("brew install {formula}")
            );
        }
        for (id, package) in [
            ("agent-browser", "agent-browser"),
            ("claude-code", "@anthropic-ai/claude-code"),
            ("codex", "@openai/codex"),
        ] {
            for platform in [InstallPlatform::Windows, InstallPlatform::Macos] {
                assert_eq!(plan_line(id, platform), format!("npm install -g {package}"));
            }
        }
    }

    #[test]
    fn install_plan_rejects_unknown_ids_and_unsupported_platforms() {
        let err = install_plan("rm -rf /", InstallPlatform::Windows).unwrap_err();
        assert!(err.contains("不在一键安装白名单中"), "{err}");
        assert!(install_plan("sidecar", InstallPlatform::Macos).is_err());
        for id in ["git", "node", "ripgrep", "ffmpeg", "claude-code", "codex"] {
            let err = install_plan(id, InstallPlatform::Other).unwrap_err();
            assert!(err.contains("当前平台不提供"), "{err}");
            assert_eq!(install_hint(id, InstallPlatform::Other, &[]), None);
        }
        assert_eq!(
            install_hint("data-dir", InstallPlatform::Windows, &[]),
            None
        );

        let err = run_environment_install("not-whitelisted").unwrap_err();
        assert!(err.contains("不在一键安装白名单中"), "{err}");
    }

    #[test]
    fn install_hint_reports_missing_installer_with_reason() {
        let empty = tempfile::tempdir().unwrap();
        let entries = [empty.path().to_path_buf()];
        let cases = [
            ("git", InstallPlatform::Windows, "未找到 winget"),
            ("ffmpeg", InstallPlatform::Macos, "未找到 Homebrew"),
            (
                "codex",
                InstallPlatform::Windows,
                "需先安装 Node.js（含 npm）",
            ),
        ];
        for (id, platform, reason) in cases {
            let hint = install_hint(id, platform, &entries).unwrap();
            assert!(!hint.available, "{id}");
            assert!(
                hint.unavailable_reason.as_deref().unwrap().contains(reason),
                "{id}: {:?}",
                hint.unavailable_reason
            );
            assert_eq!(hint.command, plan_line(id, platform));
        }
    }

    #[test]
    fn install_hint_available_when_installer_on_path() {
        let dir = tempfile::tempdir().unwrap();
        let (winget, npm) = if cfg!(windows) {
            ("winget.exe", "npm.cmd")
        } else {
            ("winget", "npm")
        };
        fs::write(dir.path().join(winget), b"x").unwrap();
        fs::write(dir.path().join(npm), b"x").unwrap();
        let entries = [dir.path().to_path_buf()];

        for id in ["ripgrep", "claude-code"] {
            let hint = install_hint(id, InstallPlatform::Windows, &entries).unwrap();
            assert!(hint.available, "{id}");
            assert_eq!(hint.unavailable_reason, None);
        }
    }

    #[test]
    fn install_hint_serializes_camel_case_and_item_omits_absent_install() {
        let hint = EnvironmentInstallHint {
            command: "npm install -g @openai/codex".to_string(),
            available: false,
            unavailable_reason: Some("需先安装 Node.js（含 npm）".to_string()),
        };
        let value = serde_json::to_value(&hint).unwrap();
        assert_eq!(value["unavailableReason"], "需先安装 Node.js（含 npm）");
        let ok = EnvironmentInstallHint {
            available: true,
            unavailable_reason: None,
            ..hint.clone()
        };
        assert!(serde_json::to_value(&ok)
            .unwrap()
            .get("unavailableReason")
            .is_none());

        let item = EnvironmentCheckItem::new(
            "codex",
            EnvironmentCheckCategory::Tools,
            "Codex CLI",
            EnvironmentCheckStatus::Ok,
            false,
            "ok",
        );
        assert!(serde_json::to_value(&item)
            .unwrap()
            .get("install")
            .is_none());
        let missing = item.install(Some(hint));
        assert_eq!(
            serde_json::to_value(&missing).unwrap()["install"]["command"],
            "npm install -g @openai/codex"
        );

        let result = EnvironmentInstallResult {
            ok: true,
            exit_code: Some(0),
            output: String::new(),
        };
        assert_eq!(serde_json::to_value(&result).unwrap()["exitCode"], 0);
    }

    #[test]
    fn install_success_accepts_zero_and_winget_already_installed_codes() {
        assert!(is_install_success(Installer::Npm, Some(0)));
        assert!(is_install_success(Installer::Winget, Some(0)));
        assert!(is_install_success(
            Installer::Winget,
            Some(0x8A15_002B_u32 as i32)
        ));
        assert!(is_install_success(
            Installer::Winget,
            Some(0x8A15_0061_u32 as i32)
        ));
        assert!(!is_install_success(
            Installer::Npm,
            Some(0x8A15_0061_u32 as i32)
        ));
        assert!(!is_install_success(Installer::Winget, Some(1)));
        assert!(!is_install_success(Installer::Brew, Some(1)));
        assert!(!is_install_success(Installer::Winget, None));
    }

    #[test]
    fn install_output_keeps_tail_and_collapses_progress_frames() {
        assert_eq!(tail_chars("abc", 3), "abc");
        assert_eq!(tail_chars("你好世界", 2), "…世界");

        let long = "x".repeat(INSTALL_OUTPUT_MAX_CHARS + 100) + "END";
        let output = install_output(long.as_bytes(), b"");
        assert!(output.starts_with('…'));
        assert!(output.ends_with("END"));
        assert_eq!(output.chars().count(), INSTALL_OUTPUT_MAX_CHARS + 1);

        let output = install_output("  - \r  \\ \r 已成功安装\r\n".as_bytes(), b"warn\n");
        assert_eq!(output, "已成功安装\nwarn");
    }

    #[test]
    #[serial_test::serial]
    fn install_guard_allows_a_single_running_install() {
        let first = InstallGuard::acquire().unwrap();
        assert_eq!(
            InstallGuard::acquire().err().as_deref(),
            Some("已有安装任务在进行")
        );
        drop(first);
        let again = InstallGuard::acquire();
        assert!(again.is_ok());
    }

    /// 用临时脚本冒充安装器，走真实的 install_command / execute_install 路径（不执行任何真实安装）。
    fn fake_installer(dir: &Path, body: &str) -> PathBuf {
        #[cfg(windows)]
        {
            let path = dir.join("fake-installer.cmd");
            fs::write(&path, format!("@echo off\r\n{body}\r\n")).unwrap();
            path
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join("fake-installer");
            fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            path
        }
    }

    fn npm_like_plan() -> InstallPlan {
        install_plan("claude-code", InstallPlatform::Windows).unwrap()
    }

    #[test]
    fn execute_install_passes_fixed_args_and_reports_failure() {
        let dir = tempfile::tempdir().unwrap();
        let body = if cfg!(windows) {
            "echo args: %*\r\necho boom 1>&2\r\nexit /b 3"
        } else {
            "echo \"args: $*\"\necho boom 1>&2\nexit 3"
        };
        let program = fake_installer(dir.path(), body);
        let plan = npm_like_plan();
        let result = execute_install(
            install_command(&program, &plan),
            plan.installer,
            Duration::from_secs(30),
        );
        assert!(!result.ok);
        assert_eq!(result.exit_code, Some(3));
        assert!(
            result
                .output
                .contains("args: install -g @anthropic-ai/claude-code"),
            "{}",
            result.output
        );
        assert!(result.output.contains("boom"), "{}", result.output);
    }

    #[test]
    fn execute_install_reports_success() {
        let dir = tempfile::tempdir().unwrap();
        let program = fake_installer(dir.path(), "echo done");
        let plan = npm_like_plan();
        let result = execute_install(
            install_command(&program, &plan),
            plan.installer,
            Duration::from_secs(30),
        );
        assert_eq!(
            result,
            EnvironmentInstallResult {
                ok: true,
                exit_code: Some(0),
                output: "done".to_string(),
            }
        );
    }

    #[cfg(windows)]
    #[test]
    fn execute_install_treats_winget_already_installed_as_success() {
        let dir = tempfile::tempdir().unwrap();
        let program = fake_installer(dir.path(), "exit /b -1978335135");
        let plan = install_plan("git", InstallPlatform::Windows).unwrap();
        let result = execute_install(
            install_command(&program, &plan),
            plan.installer,
            Duration::from_secs(30),
        );
        assert_eq!(result.exit_code, Some(0x8A15_0061_u32 as i32));
        assert!(result.ok);
    }

    #[test]
    fn execute_install_kills_on_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let body = if cfg!(windows) {
            "ping -n 6 127.0.0.1 >nul"
        } else {
            "sleep 5"
        };
        let program = fake_installer(dir.path(), body);
        let plan = npm_like_plan();
        let result = execute_install(
            install_command(&program, &plan),
            plan.installer,
            Duration::from_millis(300),
        );
        assert!(!result.ok);
        assert_eq!(result.exit_code, None);
        assert!(result.output.contains("安装超时"), "{}", result.output);
    }
}
