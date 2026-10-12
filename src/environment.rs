//! Desktop environment diagnostics.
//!
//! Read-only checks: data/log directories, the Node sidecar status, the
//! effective PATH and optional CLI tools. Nothing is installed or repaired.

use serde::Serialize;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

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
        )));
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
    let output = Command::new(command)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output();
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
}
