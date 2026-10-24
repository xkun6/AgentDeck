//! 编程Agent CLI（Claude Code / Codex / DeepSeek Harness）的深度检测：安装状态、版本、登录态。
//!
//! 与 environment.rs 的声明式工具体检互补：那边只做 PATH 快检行，这里为
//! 「编程Agent」设置页提供更完整的状态——覆盖 PATH 之外的常见安装点
//! （~/.claude/local/claude、~/.local/bin），并探测登录态（凭据文件优先，
//! macOS 兜底查钥匙串条目的存在性）。
//!
//! 隐私边界：登录态探测**绝不读取 token 密文**——凭据文件只解析
//! `claudeAiOauth.expiresAt` 等元数据字段；macOS `security` 查询不带 `-w`
//! （只确认条目存在，不导出密码，也不会触发钥匙串 ACL 授权弹窗）。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::environment::{now_ms, probe_commands, CommandProbe};

pub const CLAUDE_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
pub const CODEX_KEYCHAIN_SERVICE: &str = "Codex Auth";

/// 「编程 Agent」页手动配置的可执行文件路径，存于 `<数据目录>/coding-agent-paths.json`
/// （design.md 5.1）。sidecar 每次解析 claude / codex 时重读同一文件，保存后无需重启即生效。
pub const CODING_AGENT_PATHS_FILE: &str = "coding-agent-paths.json";

/// `{ "claude"?: string, "codex"?: string }`；缺省或空字符串 = 自动查找。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodingAgentPaths {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex: Option<String>,
}

impl CodingAgentPaths {
    /// 去首尾空白，空字符串归为 None（= 自动查找）。
    fn normalized(self) -> Self {
        fn clean(value: Option<String>) -> Option<String> {
            value
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        }
        Self {
            claude: clean(self.claude),
            codex: clean(self.codex),
        }
    }
}

pub(crate) fn coding_agent_paths_file(data_dir: &Path) -> PathBuf {
    data_dir.join(CODING_AGENT_PATHS_FILE)
}

/// 读取配置；文件不存在或损坏时视为全部自动查找。
pub fn read_coding_agent_paths(data_dir: &Path) -> CodingAgentPaths {
    std::fs::read_to_string(coding_agent_paths_file(data_dir))
        .ok()
        .and_then(|raw| {
            serde_json::from_str::<CodingAgentPaths>(raw.trim_start_matches('\u{feff}')).ok()
        })
        .unwrap_or_default()
        .normalized()
}

/// 校验：非空值必须是绝对路径且文件存在，否则返回中文错误。
pub fn validate_coding_agent_paths(paths: CodingAgentPaths) -> Result<CodingAgentPaths, String> {
    let paths = paths.normalized();
    for (label, value) in [("Claude Code", &paths.claude), ("Codex", &paths.codex)] {
        let Some(value) = value else { continue };
        let path = Path::new(value);
        if !path.is_absolute() {
            return Err(format!("{label} 可执行文件路径必须是绝对路径：{value}"));
        }
        if !path.is_file() {
            return Err(format!("{label} 可执行文件不存在：{value}"));
        }
    }
    Ok(paths)
}

/// 校验后写入（临时文件 + rename），返回规范化后的配置。
pub fn save_coding_agent_paths(
    data_dir: &Path,
    paths: CodingAgentPaths,
) -> Result<CodingAgentPaths, String> {
    let paths = validate_coding_agent_paths(paths)?;
    std::fs::create_dir_all(data_dir).map_err(|err| format!("创建数据目录失败：{err}"))?;
    let target = coding_agent_paths_file(data_dir);
    let tmp = data_dir.join(format!("{CODING_AGENT_PATHS_FILE}.tmp"));
    let body =
        serde_json::to_string_pretty(&paths).map_err(|err| format!("序列化配置失败：{err}"))?;
    std::fs::write(&tmp, body).map_err(|err| format!("写入配置失败：{err}"))?;
    std::fs::rename(&tmp, &target).map_err(|err| {
        let _ = std::fs::remove_file(&tmp);
        format!("保存配置失败：{err}")
    })?;
    Ok(paths)
}

/// 配置了路径时只探测该路径（不回退自动查找）；否则按候选列表探测。
fn probe_agent_binary(configured: Option<&str>, candidates: &[String]) -> CommandProbe {
    match configured {
        Some(path) if !Path::new(path).is_file() => CommandProbe {
            found: false,
            path: None,
            version: None,
            error: Some(format!("配置的路径不存在：{path}")),
        },
        Some(path) => probe_commands(&[path], &["--version"]),
        None => {
            let refs: Vec<&str> = candidates.iter().map(String::as_str).collect();
            probe_commands(&refs, &["--version"])
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CodingAgentLoginState {
    LoggedIn,
    Expired,
    NotLoggedIn,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingAgentStatus {
    pub id: String,
    pub label: String,
    pub installed: bool,
    /// 版本号；未安装或版本命令失败时为原因说明（如「配置的路径不存在：…」）。
    pub version: Option<String>,
    /// 找到了可执行文件但版本命令失败（无法运行）的原因；能正常运行时省略。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_error: Option<String>,
    pub path: Option<String>,
    /// 「编程 Agent」页手动配置的路径（None = 自动查找）。
    pub configured_path: Option<String>,
    pub login_state: CodingAgentLoginState,
    /// 人话补充（过期时间、凭据位置等），不含任何秘密。
    pub login_detail: Option<String>,
    pub config_dir: String,
    /// 对应的委派技能名（用于设置页联动技能开关）。
    pub skill_name: String,
    pub install_hint: String,
    pub login_hint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingAgentsCheckResult {
    pub generated_at_ms: u64,
    pub platform: String,
    pub agents: Vec<CodingAgentStatus>,
}

// ── 纯函数（单测覆盖） ────────────────────────────────────────────────────

/// Claude Code 配置目录：CLAUDE_CONFIG_DIR 显式优先，否则 ~/.claude。
pub(crate) fn claude_config_dir(env_override: Option<&str>, home: &Path) -> PathBuf {
    match env_override.map(str::trim) {
        Some(value) if !value.is_empty() => PathBuf::from(value),
        _ => home.join(".claude"),
    }
}

/// Codex 配置目录：CODEX_HOME 显式优先，否则 ~/.codex。
pub(crate) fn codex_config_dir(env_override: Option<&str>, home: &Path) -> PathBuf {
    match env_override.map(str::trim) {
        Some(value) if !value.is_empty() => PathBuf::from(value),
        _ => home.join(".codex"),
    }
}

/// DeepSeek Harness 主目录：DSH_HOME 显式优先，否则 ~/.dsh。
pub(crate) fn dsh_home_dir(env_override: Option<&str>, home: &Path) -> PathBuf {
    match env_override.map(str::trim) {
        Some(value) if !value.is_empty() => PathBuf::from(value),
        _ => home.join(".dsh"),
    }
}

/// 找到了但版本命令失败 = 无法运行。
fn run_error(probe: &CommandProbe) -> Option<String> {
    if probe.found {
        probe.error.clone()
    } else {
        None
    }
}

/// 解析 ~/.claude/.credentials.json（只读元数据字段，不触碰 token 本体）。
pub(crate) fn parse_claude_credentials(
    raw: &str,
    now_ms: u64,
) -> (CodingAgentLoginState, Option<String>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return (
            CodingAgentLoginState::Unknown,
            Some("凭据文件无法解析".into()),
        );
    };
    let oauth = value
        .get("claudeAiOauth")
        .or_else(|| value.get("claude.ai_oauth"));
    let Some(oauth) = oauth else {
        return (
            CodingAgentLoginState::Unknown,
            Some("凭据文件存在但格式未知".into()),
        );
    };
    match oauth.get("expiresAt").and_then(serde_json::Value::as_u64) {
        Some(expires_at) if expires_at > now_ms => {
            let remain_h = (expires_at - now_ms) / 3_600_000;
            (
                CodingAgentLoginState::LoggedIn,
                Some(format!(
                    "OAuth 凭据有效（约 {remain_h} 小时后过期，可自动刷新）"
                )),
            )
        }
        Some(_) => (
            CodingAgentLoginState::Expired,
            Some("OAuth 凭据已过期，运行 claude 重新登录".into()),
        ),
        None => (
            CodingAgentLoginState::LoggedIn,
            Some("发现 OAuth 凭据（未含过期时间）".into()),
        ),
    }
}

/// 解析 ~/.codex/auth.json：OPENAI_API_KEY 或 tokens 任一存在即视为已登录。
pub(crate) fn parse_codex_auth(raw: &str) -> (CodingAgentLoginState, Option<String>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return (
            CodingAgentLoginState::Unknown,
            Some("auth.json 无法解析".into()),
        );
    };
    let has_api_key = value
        .get("OPENAI_API_KEY")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|s| !s.trim().is_empty());
    let has_tokens = value.get("tokens").is_some_and(|t| !t.is_null());
    if has_api_key || has_tokens {
        let detail = if has_tokens {
            "已通过 ChatGPT 账号登录"
        } else {
            "已配置 API Key"
        };
        (CodingAgentLoginState::LoggedIn, Some(detail.into()))
    } else {
        (
            CodingAgentLoginState::NotLoggedIn,
            Some("auth.json 存在但没有可用凭据".into()),
        )
    }
}

/// macOS 钥匙串条目存在性检查（不带 -w：不读密文、不触发 ACL 弹窗）。
/// 非 macOS 或执行失败返回 None（调用方归 Unknown/NotLoggedIn）。
fn keychain_entry_exists(service: &str) -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("security")
            .args(["find-generic-password", "-s", service])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        match output {
            Ok(status) => Some(status.success()),
            Err(_) => None,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = service;
        None
    }
}

fn detect_claude_login(config_dir: &Path) -> (CodingAgentLoginState, Option<String>) {
    let creds = config_dir.join(".credentials.json");
    if let Ok(raw) = std::fs::read_to_string(&creds) {
        return parse_claude_credentials(&raw, now_ms());
    }
    match keychain_entry_exists(CLAUDE_KEYCHAIN_SERVICE) {
        Some(true) => (
            CodingAgentLoginState::LoggedIn,
            Some("凭据保存在系统钥匙串".into()),
        ),
        Some(false) => (
            CodingAgentLoginState::NotLoggedIn,
            Some("未发现登录凭据（如使用 API Key 环境变量可忽略）".into()),
        ),
        None => (CodingAgentLoginState::Unknown, None),
    }
}

fn detect_codex_login(config_dir: &Path) -> (CodingAgentLoginState, Option<String>) {
    let auth = config_dir.join("auth.json");
    if let Ok(raw) = std::fs::read_to_string(&auth) {
        return parse_codex_auth(&raw);
    }
    match keychain_entry_exists(CODEX_KEYCHAIN_SERVICE) {
        Some(true) => (
            CodingAgentLoginState::LoggedIn,
            Some("凭据保存在系统钥匙串".into()),
        ),
        Some(false) => (
            CodingAgentLoginState::NotLoggedIn,
            Some("未发现登录凭据，运行 codex login 完成登录".into()),
        ),
        None => (CodingAgentLoginState::Unknown, None),
    }
}

/// PATH 之外的常见安装点（find_on_path 对含分隔符的路径直接短路判存在）。
fn claude_binary_candidates(home: &Path) -> Vec<String> {
    vec![
        "claude".to_string(),
        home.join(".claude/local/claude")
            .to_string_lossy()
            .into_owned(),
        home.join(".local/bin/claude")
            .to_string_lossy()
            .into_owned(),
    ]
}

fn codex_binary_candidates(home: &Path) -> Vec<String> {
    vec![
        "codex".to_string(),
        home.join(".local/bin/codex").to_string_lossy().into_owned(),
    ]
}

pub fn collect_coding_agents_check(data_dir: &Path) -> CodingAgentsCheckResult {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let configured = read_coding_agent_paths(data_dir);

    let claude_dir = claude_config_dir(std::env::var("CLAUDE_CONFIG_DIR").ok().as_deref(), &home);
    let codex_dir = codex_config_dir(std::env::var("CODEX_HOME").ok().as_deref(), &home);
    let dsh_dir = dsh_home_dir(std::env::var("DSH_HOME").ok().as_deref(), &home);

    let claude_probe = probe_agent_binary(
        configured.claude.as_deref(),
        &claude_binary_candidates(&home),
    );
    let (claude_login, claude_detail) = if claude_probe.found {
        detect_claude_login(&claude_dir)
    } else {
        (CodingAgentLoginState::Unknown, None)
    };

    let codex_probe =
        probe_agent_binary(configured.codex.as_deref(), &codex_binary_candidates(&home));
    let (codex_login, codex_detail) = if codex_probe.found {
        detect_codex_login(&codex_dir)
    } else {
        (CodingAgentLoginState::Unknown, None)
    };

    // dsh 没有登录概念：模型与 API Key 在 DeepSeek Harness 桌面端配置，登录态恒为 Unknown
    let dsh_probe = probe_commands(&["dsh"], &["--version"]);

    CodingAgentsCheckResult {
        generated_at_ms: now_ms(),
        platform: std::env::consts::OS.to_string(),
        agents: vec![
            CodingAgentStatus {
                id: "claude-code".into(),
                label: "Claude Code".into(),
                installed: claude_probe.found,
                run_error: run_error(&claude_probe),
                version: claude_probe.version.or(claude_probe.error),
                path: claude_probe.path.map(|p| p.to_string_lossy().into_owned()),
                configured_path: configured.claude,
                login_state: claude_login,
                login_detail: claude_detail,
                config_dir: claude_dir.to_string_lossy().into_owned(),
                skill_name: "claude-code".into(),
                install_hint: "npm install -g @anthropic-ai/claude-code".into(),
                login_hint: "运行 claude 按提示完成 OAuth 登录（或配置 ANTHROPIC_API_KEY）".into(),
            },
            CodingAgentStatus {
                id: "codex".into(),
                label: "Codex".into(),
                installed: codex_probe.found,
                run_error: run_error(&codex_probe),
                version: codex_probe.version.or(codex_probe.error),
                path: codex_probe.path.map(|p| p.to_string_lossy().into_owned()),
                configured_path: configured.codex,
                login_state: codex_login,
                login_detail: codex_detail,
                config_dir: codex_dir.to_string_lossy().into_owned(),
                skill_name: "codex".into(),
                install_hint: "npm install -g @openai/codex".into(),
                login_hint: "运行 codex login 完成登录（或在 ~/.codex/auth.json 配置 API Key）"
                    .into(),
            },
            CodingAgentStatus {
                id: "dsh".into(),
                label: "DeepSeek Harness".into(),
                installed: dsh_probe.found,
                run_error: run_error(&dsh_probe),
                version: dsh_probe.version.or(dsh_probe.error),
                path: dsh_probe.path.map(|p| p.to_string_lossy().into_owned()),
                configured_path: None,
                login_state: CodingAgentLoginState::Unknown,
                login_detail: None,
                config_dir: dsh_dir.to_string_lossy().into_owned(),
                skill_name: "dsh".into(),
                install_hint: "安装 DeepSeek Harness 桌面端，并在其设置中安装 dsh 命令".into(),
                login_hint: "模型与 API Key 在 DeepSeek Harness 桌面端中配置".into(),
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn claude_config_dir_prefers_env_override() {
        let home = Path::new("/home/u");
        assert_eq!(
            claude_config_dir(Some("/custom/claude"), home),
            PathBuf::from("/custom/claude")
        );
        assert_eq!(claude_config_dir(Some("  "), home), home.join(".claude"));
        assert_eq!(claude_config_dir(None, home), home.join(".claude"));
    }

    #[test]
    fn codex_config_dir_prefers_env_override() {
        let home = Path::new("/home/u");
        assert_eq!(
            codex_config_dir(Some("/custom/codex"), home),
            PathBuf::from("/custom/codex")
        );
        assert_eq!(codex_config_dir(None, home), home.join(".codex"));
    }

    #[test]
    fn dsh_home_dir_prefers_env_override() {
        let home = Path::new("/home/u");
        assert_eq!(
            dsh_home_dir(Some("/custom/dsh"), home),
            PathBuf::from("/custom/dsh")
        );
        assert_eq!(dsh_home_dir(Some(" "), home), home.join(".dsh"));
        assert_eq!(dsh_home_dir(None, home), home.join(".dsh"));
    }

    #[test]
    fn run_error_only_when_found_but_version_failed() {
        let probe = |found: bool, error: Option<&str>| CommandProbe {
            found,
            path: None,
            version: None,
            error: error.map(String::from),
        };
        assert_eq!(run_error(&probe(true, None)), None);
        assert_eq!(
            run_error(&probe(true, Some("版本命令退出码 1"))),
            Some("版本命令退出码 1".to_string())
        );
        // 未找到时 error 是「未在 PATH 中找到」，不算无法运行
        assert_eq!(run_error(&probe(false, Some("未在 PATH 中找到 dsh"))), None);
    }

    #[test]
    fn claude_credentials_valid_expired_and_unknown() {
        let now = 1_000_000_000_000u64;
        let valid = format!(r#"{{"claudeAiOauth":{{"expiresAt":{}}}}}"#, now + 7_200_000);
        let (state, detail) = parse_claude_credentials(&valid, now);
        assert_eq!(state, CodingAgentLoginState::LoggedIn);
        assert!(detail.unwrap().contains("小时"));

        let expired = format!(r#"{{"claudeAiOauth":{{"expiresAt":{}}}}}"#, now - 1_000);
        let (state, _) = parse_claude_credentials(&expired, now);
        assert_eq!(state, CodingAgentLoginState::Expired);

        let no_expiry = r#"{"claudeAiOauth":{"scopes":["user:inference"]}}"#;
        let (state, _) = parse_claude_credentials(no_expiry, now);
        assert_eq!(state, CodingAgentLoginState::LoggedIn);

        let (state, _) = parse_claude_credentials("not json", now);
        assert_eq!(state, CodingAgentLoginState::Unknown);

        let (state, _) = parse_claude_credentials(r#"{"other":{}}"#, now);
        assert_eq!(state, CodingAgentLoginState::Unknown);
    }

    #[test]
    fn codex_auth_states() {
        let (state, detail) = parse_codex_auth(r#"{"OPENAI_API_KEY":"sk-xxx"}"#);
        assert_eq!(state, CodingAgentLoginState::LoggedIn);
        assert!(detail.unwrap().contains("API Key"));

        let (state, detail) = parse_codex_auth(r#"{"tokens":{"id_token":"…"}}"#);
        assert_eq!(state, CodingAgentLoginState::LoggedIn);
        assert!(detail.unwrap().contains("ChatGPT"));

        let (state, _) = parse_codex_auth(r#"{"OPENAI_API_KEY":"", "tokens": null}"#);
        assert_eq!(state, CodingAgentLoginState::NotLoggedIn);

        let (state, _) = parse_codex_auth("{broken");
        assert_eq!(state, CodingAgentLoginState::Unknown);
    }

    #[test]
    fn detect_login_reads_files_from_config_dirs() {
        let dir = tempfile::TempDir::new().unwrap();
        let claude_dir = dir.path().join("claude-cfg");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::write(
            claude_dir.join(".credentials.json"),
            format!(
                r#"{{"claudeAiOauth":{{"expiresAt":{}}}}}"#,
                now_ms() + 3_600_000
            ),
        )
        .unwrap();
        let (state, _) = detect_claude_login(&claude_dir);
        assert_eq!(state, CodingAgentLoginState::LoggedIn);

        let codex_dir = dir.path().join("codex-cfg");
        std::fs::create_dir_all(&codex_dir).unwrap();
        std::fs::write(
            codex_dir.join("auth.json"),
            r#"{"tokens":{"access_token":"x"}}"#,
        )
        .unwrap();
        let (state, _) = detect_codex_login(&codex_dir);
        assert_eq!(state, CodingAgentLoginState::LoggedIn);
    }

    #[test]
    fn coding_agent_paths_read_defaults_and_normalizes() {
        let dir = tempfile::TempDir::new().unwrap();
        // 文件不存在 → 全部自动查找
        assert_eq!(
            read_coding_agent_paths(dir.path()),
            CodingAgentPaths::default()
        );

        let file = coding_agent_paths_file(dir.path());
        std::fs::write(
            &file,
            "\u{feff}{\"claude\":\"  /opt/claude  \",\"codex\":\"\"}",
        )
        .unwrap();
        assert_eq!(
            read_coding_agent_paths(dir.path()),
            CodingAgentPaths {
                claude: Some("/opt/claude".into()),
                codex: None,
            }
        );

        std::fs::write(&file, "{broken").unwrap();
        assert_eq!(
            read_coding_agent_paths(dir.path()),
            CodingAgentPaths::default()
        );
    }

    #[test]
    fn coding_agent_paths_validation_rejects_relative_and_missing() {
        let dir = tempfile::TempDir::new().unwrap();
        let exe = dir.path().join("claude.exe");
        std::fs::write(&exe, b"x").unwrap();
        let exe = exe.to_string_lossy().into_owned();

        let ok = validate_coding_agent_paths(CodingAgentPaths {
            claude: Some(format!(" {exe} ")),
            codex: Some("   ".into()),
        })
        .unwrap();
        assert_eq!(
            ok,
            CodingAgentPaths {
                claude: Some(exe.clone()),
                codex: None,
            }
        );

        let err = validate_coding_agent_paths(CodingAgentPaths {
            claude: Some("bin/claude".into()),
            codex: None,
        })
        .unwrap_err();
        assert!(err.contains("绝对路径"), "{err}");

        let missing = dir.path().join("codex.exe").to_string_lossy().into_owned();
        let err = validate_coding_agent_paths(CodingAgentPaths {
            claude: None,
            codex: Some(missing.clone()),
        })
        .unwrap_err();
        assert!(err.contains("不存在") && err.contains(&missing), "{err}");

        // 目录不算可执行文件
        let err = validate_coding_agent_paths(CodingAgentPaths {
            claude: Some(dir.path().to_string_lossy().into_owned()),
            codex: None,
        })
        .unwrap_err();
        assert!(err.contains("不存在"), "{err}");
    }

    #[test]
    fn coding_agent_paths_save_roundtrips_atomically() {
        let dir = tempfile::TempDir::new().unwrap();
        let data_dir = dir.path().join("data");
        let exe = dir.path().join("codex.exe");
        std::fs::write(&exe, b"x").unwrap();
        let exe = exe.to_string_lossy().into_owned();

        let saved = save_coding_agent_paths(
            &data_dir,
            CodingAgentPaths {
                claude: Some(String::new()),
                codex: Some(exe.clone()),
            },
        )
        .unwrap();
        assert_eq!(saved.codex.as_deref(), Some(exe.as_str()));
        assert_eq!(saved.claude, None);
        assert_eq!(read_coding_agent_paths(&data_dir), saved);
        // 未配置的键不写入文件；临时文件已被 rename 掉
        let raw = std::fs::read_to_string(coding_agent_paths_file(&data_dir)).unwrap();
        assert!(!raw.contains("claude"), "{raw}");
        assert!(!data_dir
            .join(format!("{CODING_AGENT_PATHS_FILE}.tmp"))
            .exists());

        // 清空 = 恢复自动查找
        let cleared = save_coding_agent_paths(&data_dir, CodingAgentPaths::default()).unwrap();
        assert_eq!(cleared, CodingAgentPaths::default());
        assert_eq!(
            std::fs::read_to_string(coding_agent_paths_file(&data_dir))
                .unwrap()
                .trim(),
            "{}"
        );

        // 校验失败不覆盖已有文件
        save_coding_agent_paths(
            &data_dir,
            CodingAgentPaths {
                claude: None,
                codex: Some(exe.clone()),
            },
        )
        .unwrap();
        assert!(save_coding_agent_paths(
            &data_dir,
            CodingAgentPaths {
                claude: Some("relative".into()),
                codex: None,
            },
        )
        .is_err());
        assert_eq!(read_coding_agent_paths(&data_dir).codex, Some(exe));
    }

    #[test]
    fn configured_path_is_probed_exclusively() {
        let dir = tempfile::TempDir::new().unwrap();
        let auto = dir.path().join("auto-claude");
        std::fs::write(&auto, b"x").unwrap();
        let auto_candidates = vec![auto.to_string_lossy().into_owned()];

        // 未配置：按候选探测
        let probe = probe_agent_binary(None, &auto_candidates);
        assert!(probe.found);
        assert_eq!(probe.path.as_deref(), Some(auto.as_path()));

        // 配置的路径存在：只用它
        let configured = dir.path().join("configured-claude");
        std::fs::write(&configured, b"x").unwrap();
        let configured_str = configured.to_string_lossy().into_owned();
        let probe = probe_agent_binary(Some(&configured_str), &auto_candidates);
        assert!(probe.found);
        assert_eq!(probe.path.as_deref(), Some(configured.as_path()));

        // 配置的路径不存在：不回退候选
        let missing = dir.path().join("missing").to_string_lossy().into_owned();
        let probe = probe_agent_binary(Some(&missing), &auto_candidates);
        assert!(!probe.found);
        assert_eq!(probe.path, None);
        assert_eq!(probe.error, Some(format!("配置的路径不存在：{missing}")));
    }

    #[test]
    fn collect_check_reports_configured_paths() {
        let dir = tempfile::TempDir::new().unwrap();
        let missing_claude = dir
            .path()
            .join("nope-claude.exe")
            .to_string_lossy()
            .into_owned();
        let missing_codex = dir
            .path()
            .join("nope-codex.exe")
            .to_string_lossy()
            .into_owned();
        std::fs::write(
            coding_agent_paths_file(dir.path()),
            serde_json::json!({ "claude": missing_claude, "codex": missing_codex }).to_string(),
        )
        .unwrap();

        let result = collect_coding_agents_check(dir.path());
        let claude = &result.agents[0];
        assert!(!claude.installed);
        assert_eq!(
            claude.configured_path.as_deref(),
            Some(missing_claude.as_str())
        );
        assert!(claude
            .version
            .as_deref()
            .unwrap()
            .contains("配置的路径不存在"));
        let codex = &result.agents[1];
        assert!(!codex.installed);
        assert_eq!(
            codex.configured_path.as_deref(),
            Some(missing_codex.as_str())
        );

        let json = serde_json::to_value(claude).unwrap();
        assert_eq!(json["configuredPath"], serde_json::json!(missing_claude));
        assert!(json.get("runError").is_none(), "{json}");

        let dsh = &result.agents[2];
        assert_eq!(dsh.id, "dsh");
        assert_eq!(dsh.configured_path, None);
        assert_eq!(dsh.login_state, CodingAgentLoginState::Unknown);
    }

    #[test]
    fn binary_candidates_include_known_install_points() {
        let home = Path::new("/home/u");
        let claude = claude_binary_candidates(home);
        assert!(claude.iter().any(|c| c.ends_with(".claude/local/claude")));
        let codex = codex_binary_candidates(home);
        assert_eq!(codex[0], "codex");
    }
}
