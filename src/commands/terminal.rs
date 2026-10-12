// 通用 PTY 终端：应用内终端（portable-pty）与外部系统终端。

use std::collections::{BTreeMap, HashMap};
use std::env;
#[cfg(target_os = "macos")]
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::process::Command as StdCommand;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const TERMINAL_EVENT: &str = "terminal-output";
const DEFAULT_COLS: u16 = 100;
const DEFAULT_ROWS: u16 = 30;
const MAX_COLS: u16 = 300;
const MAX_ROWS: u16 = 120;

static TERMINAL_SESSIONS: LazyLock<Mutex<HashMap<String, TerminalSession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStartInput {
    pub cwd: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub initial_input: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStartResult {
    pub terminal_id: String,
    pub cwd: String,
    pub shell: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWriteInput {
    pub terminal_id: String,
    pub data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResizeInput {
    pub terminal_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCloseInput {
    pub terminal_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenExternalInput {
    pub cwd: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenExternalResult {
    pub ok: bool,
    pub terminal: String,
    pub cwd: String,
    pub command: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEventPayload {
    pub terminal_id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[tauri::command]
pub async fn terminal_start(
    app: AppHandle,
    input: TerminalStartInput,
) -> Result<TerminalStartResult, String> {
    tauri::async_runtime::spawn_blocking(move || terminal_start_impl(app, input))
        .await
        .map_err(|e| format!("终端启动任务失败：{e}"))?
}

fn terminal_start_impl(
    app: AppHandle,
    input: TerminalStartInput,
) -> Result<TerminalStartResult, String> {
    let cols = normalize_size(input.cols, DEFAULT_COLS, MAX_COLS);
    let rows = normalize_size(input.rows, DEFAULT_ROWS, MAX_ROWS);
    let cwd = resolve_cwd(input.cwd.as_deref())?;
    let shell = default_shell_program();
    let terminal_id = new_terminal_id();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("无法打开终端：{e}"))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("无法读取终端输出：{e}"))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("无法写入终端：{e}"))?;

    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(&cwd);
    for (key, value) in build_terminal_env(&shell) {
        cmd.env(&key, &value);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("无法启动终端 Shell：{e}"))?;
    drop(pair.slave);

    if let Some(data) = input.initial_input.as_deref().filter(|v| !v.is_empty()) {
        writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("无法写入初始命令：{e}"))?;
        let _ = writer.flush();
    }

    {
        let mut sessions = TERMINAL_SESSIONS.lock().map_err(|e| e.to_string())?;
        sessions.insert(
            terminal_id.clone(),
            TerminalSession {
                master: pair.master,
                writer,
                child,
            },
        );
    }

    spawn_reader_thread(app, terminal_id.clone(), reader);

    Ok(TerminalStartResult {
        terminal_id,
        cwd: cwd.to_string_lossy().to_string(),
        shell,
    })
}

/// 在系统终端（Windows PowerShell / macOS Terminal.app）中打开 `cwd`。
#[tauri::command]
pub fn terminal_open_external(
    input: TerminalOpenExternalInput,
) -> Result<TerminalOpenExternalResult, String> {
    let cwd = resolve_cwd(input.cwd.as_deref())?;
    let shell_hint = external_terminal_shell_hint();
    let env_vars = build_terminal_env(shell_hint);
    let terminal = spawn_external_terminal(&cwd, &env_vars)?;

    Ok(TerminalOpenExternalResult {
        ok: true,
        terminal,
        cwd: cwd.to_string_lossy().to_string(),
        command: shell_hint.to_string(),
    })
}

#[tauri::command]
pub fn terminal_write(input: TerminalWriteInput) -> Result<bool, String> {
    let mut sessions = TERMINAL_SESSIONS.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&input.terminal_id)
        .ok_or_else(|| "终端会话已结束，请重新打开。".to_string())?;
    session
        .writer
        .write_all(input.data.as_bytes())
        .map_err(|e| format!("写入终端失败：{e}"))?;
    session
        .writer
        .flush()
        .map_err(|e| format!("刷新终端失败：{e}"))?;
    Ok(true)
}

#[tauri::command]
pub fn terminal_resize(input: TerminalResizeInput) -> Result<bool, String> {
    let cols = normalize_size(Some(input.cols), DEFAULT_COLS, MAX_COLS);
    let rows = normalize_size(Some(input.rows), DEFAULT_ROWS, MAX_ROWS);
    let sessions = TERMINAL_SESSIONS.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&input.terminal_id)
        .ok_or_else(|| "终端会话已结束，请重新打开。".to_string())?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("调整终端大小失败：{e}"))?;
    Ok(true)
}

#[tauri::command]
pub fn terminal_close(input: TerminalCloseInput) -> Result<bool, String> {
    let mut session = {
        let mut sessions = TERMINAL_SESSIONS.lock().map_err(|e| e.to_string())?;
        sessions.remove(&input.terminal_id)
    };

    if let Some(session) = session.as_mut() {
        let _ = session.child.kill();
    }
    Ok(true)
}

fn normalize_size(value: Option<u16>, fallback: u16, max: u16) -> u16 {
    value.unwrap_or(fallback).clamp(10, max)
}

fn default_shell_program() -> String {
    #[cfg(target_os = "windows")]
    {
        env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string())
    }

    #[cfg(not(target_os = "windows"))]
    {
        env::var("SHELL").unwrap_or_else(|_| {
            if Path::new("/bin/zsh").is_file() {
                "/bin/zsh".to_string()
            } else if Path::new("/bin/bash").is_file() {
                "/bin/bash".to_string()
            } else {
                "/bin/sh".to_string()
            }
        })
    }
}

/// 显式传入的目录必须存在；未传时用用户主目录。
fn resolve_cwd(requested: Option<&str>) -> Result<PathBuf, String> {
    if let Some(value) = requested.map(str::trim).filter(|v| !v.is_empty()) {
        let path = PathBuf::from(value);
        if path.is_dir() {
            return Ok(path);
        }
        return Err(format!("目录不存在：{value}"));
    }
    dirs::home_dir().ok_or_else(|| "无法确定终端工作目录。".to_string())
}

#[cfg(any(target_os = "macos", test))]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn build_terminal_env(shell: &str) -> BTreeMap<String, String> {
    let mut vars = BTreeMap::new();

    for (key, value) in env::vars() {
        if should_forward_env(&key) {
            vars.insert(key, value);
        }
    }

    vars.insert(
        "TERM".to_string(),
        env::var("TERM").unwrap_or_else(|_| "xterm-256color".to_string()),
    );
    vars.insert("COLORTERM".to_string(), "truecolor".to_string());
    vars.insert("CLICOLOR".to_string(), "1".to_string());
    vars.insert("CLICOLOR_FORCE".to_string(), "1".to_string());
    vars.insert("FORCE_COLOR".to_string(), "1".to_string());
    vars.insert("TERM_PROGRAM".to_string(), "AgentDeck".to_string());
    vars.insert("LSCOLORS".to_string(), "GxFxCxDxBxegedabagaced".to_string());
    vars.insert(
        "GREP_COLORS".to_string(),
        "mt=01;38;5;214:ms=01;38;5;214:mc=01;38;5;214:sl=:cx=:fn=38;5;81:ln=38;5;244:bn=38;5;144:se=38;5;244"
            .to_string(),
    );
    apply_color_prompt_env(&mut vars, shell);

    // Effective PATH so the in-app terminal matches the user's real one.
    // The shell is spawned non-login (no `-l`), so it will not rebuild PATH
    // from .zprofile itself — override the GUI-truncated process PATH.
    vars.insert(
        "PATH".to_string(),
        crate::path_resolver::effective_path_os()
            .to_string_lossy()
            .to_string(),
    );

    vars
}

fn apply_color_prompt_env(vars: &mut BTreeMap<String, String>, shell: &str) {
    let shell_name = Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(shell)
        .to_ascii_lowercase();

    if cfg!(target_os = "windows") {
        vars.insert("PROMPT".to_string(), "$E[38;5;214m$P$E[0m$G ".to_string());
    } else if shell_name.contains("zsh") {
        vars.insert(
            "PROMPT".to_string(),
            "%F{244}%n@%m%f %F{214}%1~%f %# ".to_string(),
        );
    } else if shell_name.contains("fish") {
        vars.insert("fish_color_cwd".to_string(), "yellow".to_string());
        vars.insert("fish_color_command".to_string(), "cyan".to_string());
        vars.insert("fish_color_param".to_string(), "normal".to_string());
    } else {
        vars.insert(
            "PS1".to_string(),
            "\\[\x1b[38;5;244m\\]\\u@\\h\\[\x1b[0m\\] \\[\x1b[38;5;214m\\]\\W\\[\x1b[0m\\] \\\\$ "
                .to_string(),
        );
    }
}

fn should_forward_env(key: &str) -> bool {
    key == "PATH"
        || key == "HOME"
        || key == "USER"
        || key == "USERNAME"
        || key == "LOGNAME"
        || key == "SHELL"
        || key == "LANG"
        || key == "TMPDIR"
        || key == "TEMP"
        || key == "TMP"
        || key == "SystemRoot"
        || key == "USERPROFILE"
        || key == "APPDATA"
        || key == "LOCALAPPDATA"
        || key == "ComSpec"
        || key == "PATHEXT"
        || key.starts_with("LC_")
}

fn external_terminal_shell_hint() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "powershell.exe"
    }

    #[cfg(target_os = "macos")]
    {
        "/bin/zsh"
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        "/bin/sh"
    }
}

#[cfg(target_os = "windows")]
fn spawn_external_terminal(
    cwd: &Path,
    env_vars: &BTreeMap<String, String>,
) -> Result<String, String> {
    StdCommand::new("powershell.exe")
        .args(["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass"])
        .current_dir(cwd)
        .envs(env_vars.iter())
        .spawn()
        .map_err(|e| format!("无法打开 PowerShell：{e}"))?;
    Ok("PowerShell".to_string())
}

#[cfg(target_os = "macos")]
fn spawn_external_terminal(
    cwd: &Path,
    env_vars: &BTreeMap<String, String>,
) -> Result<String, String> {
    let script_path = write_macos_terminal_script(cwd, env_vars)?;
    let source_command = macos_terminal_source_command(&script_path);
    let output = StdCommand::new("osascript")
        .arg("-e")
        .arg("tell application \"Terminal\"")
        .arg("-e")
        .arg("activate")
        .arg("-e")
        .arg(format!("do script {}", applescript_quote(&source_command)))
        .arg("-e")
        .arg("end tell")
        .output()
        .map_err(|e| format!("无法调用 macOS Terminal：{e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let message = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("osascript 退出码 {}", output.status)
        };
        return Err(format!("无法打开 macOS Terminal：{message}"));
    }

    Ok("Terminal.app".to_string())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn spawn_external_terminal(
    _cwd: &Path,
    _env_vars: &BTreeMap<String, String>,
) -> Result<String, String> {
    Err("当前平台暂不支持自动打开外部终端。".to_string())
}

#[cfg(any(target_os = "macos", test))]
fn macos_terminal_script(cwd: &Path, env_vars: &BTreeMap<String, String>) -> String {
    let mut lines = vec![
        "# AgentDeck external terminal bootstrap.".to_string(),
        format!("cd {}", shell_quote(&cwd.to_string_lossy())),
    ];
    for (key, value) in env_vars {
        if is_shell_env_key(key) {
            lines.push(format!("export {key}={}", shell_quote(value)));
        }
    }
    lines.join("\n")
}

#[cfg(target_os = "macos")]
fn write_macos_terminal_script(
    cwd: &Path,
    env_vars: &BTreeMap<String, String>,
) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;

    let dir = env::temp_dir().join("agentdeck-external-terminal");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建外部终端启动目录：{e}"))?;
    cleanup_old_macos_terminal_scripts(&dir);

    let path = dir.join(format!("open-{}.zsh", new_terminal_id()));
    let content = macos_terminal_script(cwd, env_vars);
    fs::write(&path, content).map_err(|e| format!("无法写入外部终端启动脚本：{e}"))?;
    let mut perms = fs::metadata(&path)
        .map_err(|e| format!("无法读取外部终端启动脚本权限：{e}"))?
        .permissions();
    perms.set_mode(0o600);
    fs::set_permissions(&path, perms).map_err(|e| format!("无法设置外部终端启动脚本权限：{e}"))?;
    Ok(path)
}

#[cfg(target_os = "macos")]
fn cleanup_old_macos_terminal_scripts(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let cutoff = SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(24 * 60 * 60))
        .unwrap_or(UNIX_EPOCH);
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.starts_with("open-term-") || !name.ends_with(".zsh") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata
            .modified()
            .map(|modified| modified < cutoff)
            .unwrap_or(false)
        {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn macos_terminal_source_command(script_path: &Path) -> String {
    format!(". {}", shell_quote(&script_path.to_string_lossy()))
}

#[cfg(any(target_os = "macos", test))]
fn is_shell_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(c) if c == '_' || c.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

#[cfg(any(target_os = "macos", test))]
fn applescript_quote(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");
    format!("\"{escaped}\"")
}

fn spawn_reader_thread(app: AppHandle, terminal_id: String, mut reader: Box<dyn Read + Send>) {
    thread::spawn(move || {
        let mut buf = [0_u8; 8192];
        // Carry buffer for a multi-byte UTF-8 sequence split across reads.
        // Without this, a chunk boundary inside e.g. a Chinese character would
        // be mangled into a `�` replacement char by lossy decoding.
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let data = drain_utf8(&mut pending);
                    if data.is_empty() {
                        // Only an incomplete trailing sequence so far; wait for
                        // the rest before emitting.
                        continue;
                    }
                    emit_terminal_event(
                        &app,
                        TerminalEventPayload {
                            terminal_id: terminal_id.clone(),
                            kind: "data".to_string(),
                            data: Some(data),
                            exit_code: None,
                            message: None,
                        },
                    );
                }
                Err(e) => {
                    emit_terminal_event(
                        &app,
                        TerminalEventPayload {
                            terminal_id: terminal_id.clone(),
                            kind: "error".to_string(),
                            data: None,
                            exit_code: None,
                            message: Some(e.to_string()),
                        },
                    );
                    break;
                }
            }
        }

        // Flush any trailing bytes (e.g. a truncated sequence left when the PTY
        // closed) so the final output isn't silently dropped.
        if !pending.is_empty() {
            emit_terminal_event(
                &app,
                TerminalEventPayload {
                    terminal_id: terminal_id.clone(),
                    kind: "data".to_string(),
                    data: Some(String::from_utf8_lossy(&pending).to_string()),
                    exit_code: None,
                    message: None,
                },
            );
        }

        let exit_code = {
            let mut session = TERMINAL_SESSIONS
                .lock()
                .ok()
                .and_then(|mut sessions| sessions.remove(&terminal_id));
            session
                .as_mut()
                .and_then(|session| session.child.wait().ok())
                .map(|status| status.exit_code() as i32)
        };

        emit_terminal_event(
            &app,
            TerminalEventPayload {
                terminal_id,
                kind: "exit".to_string(),
                data: None,
                exit_code,
                message: None,
            },
        );
    });
}

fn emit_terminal_event(app: &AppHandle, payload: TerminalEventPayload) {
    let _ = app.emit(TERMINAL_EVENT, payload);
}

/// Decode as much valid UTF-8 as possible from `pending`, leaving only an
/// incomplete trailing multi-byte sequence (at most 3 bytes) in the buffer for
/// the next read to complete. Genuinely invalid bytes are replaced with the
/// Unicode replacement character so the stream can't stall.
fn drain_utf8(pending: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(valid) => {
                out.push_str(valid);
                pending.clear();
                return out;
            }
            Err(err) => {
                let valid_up_to = err.valid_up_to();
                // Bytes before `valid_up_to` are guaranteed valid UTF-8.
                out.push_str(
                    std::str::from_utf8(&pending[..valid_up_to])
                        .expect("prefix up to valid_up_to is valid UTF-8"),
                );
                match err.error_len() {
                    // Incomplete sequence at the end — keep it for the next read.
                    None => {
                        pending.drain(..valid_up_to);
                        return out;
                    }
                    // Genuinely invalid bytes — emit a replacement char, skip
                    // them, and keep decoding the remainder.
                    Some(bad_len) => {
                        out.push('\u{FFFD}');
                        pending.drain(..valid_up_to + bad_len);
                    }
                }
            }
        }
    }
}

fn new_terminal_id() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    // A monotonic counter keeps IDs unique even when two terminals start in the
    // same millisecond; otherwise the HashMap insert would silently overwrite
    // (and leak) the earlier session's PTY/child.
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("term-{millis}-{}-{seq}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn drain_utf8_passes_through_ascii() {
        let mut pending = b"hello".to_vec();
        assert_eq!(drain_utf8(&mut pending), "hello");
        assert!(pending.is_empty());
    }

    #[test]
    fn drain_utf8_keeps_incomplete_trailing_sequence() {
        // "中" is 0xE4 0xB8 0xAD. Feed only the first two bytes.
        let full = "中".as_bytes();
        let mut pending = full[..2].to_vec();
        // Nothing decodable yet; both bytes are retained for the next read.
        assert_eq!(drain_utf8(&mut pending), "");
        assert_eq!(pending, full[..2].to_vec());

        // Supply the final byte: the full character now decodes.
        pending.push(full[2]);
        assert_eq!(drain_utf8(&mut pending), "中");
        assert!(pending.is_empty());
    }

    #[test]
    fn drain_utf8_splits_multibyte_across_chunk_boundary() {
        // A chunk that ends mid-character must not corrupt it.
        let text = "héllo世界";
        let bytes = text.as_bytes();
        let mut decoded = String::new();
        let mut pending = Vec::new();
        // Feed one byte at a time — the worst-case split.
        for &b in bytes {
            pending.push(b);
            decoded.push_str(&drain_utf8(&mut pending));
        }
        assert_eq!(decoded, text);
        assert!(pending.is_empty());
    }

    #[test]
    fn drain_utf8_replaces_invalid_bytes_without_stalling() {
        // 0xFF is never valid UTF-8; it must be replaced, not retained forever.
        let mut pending = vec![b'a', 0xFF, b'b'];
        assert_eq!(drain_utf8(&mut pending), "a\u{FFFD}b");
        assert!(pending.is_empty());
    }

    #[test]
    fn new_terminal_id_is_unique_within_same_millisecond() {
        let ids: Vec<String> = (0..1000).map(|_| new_terminal_id()).collect();
        let mut sorted = ids.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), ids.len(), "terminal ids must be unique");
    }

    #[test]
    fn macos_terminal_source_command_stays_short() {
        assert_eq!(
            macos_terminal_source_command(Path::new("/Users/alice/AgentDeck Scripts/open.zsh")),
            ". '/Users/alice/AgentDeck Scripts/open.zsh'"
        );
    }

    #[test]
    fn applescript_quote_escapes_terminal_script_literals() {
        assert_eq!(
            applescript_quote("echo \"hi\" && echo C:\\AgentDeck"),
            "\"echo \\\"hi\\\" && echo C:\\\\AgentDeck\""
        );
    }

    #[test]
    fn macos_terminal_script_sets_environment_and_cwd() {
        let mut env_vars = BTreeMap::new();
        env_vars.insert("PATH".to_string(), "/opt/homebrew/bin:/usr/bin".to_string());
        env_vars.insert("BAD-NAME".to_string(), "ignored".to_string());

        let script = macos_terminal_script(Path::new("/Users/alice/Work Dir"), &env_vars);

        assert!(script.contains("cd '/Users/alice/Work Dir'"));
        assert!(script.contains("export PATH='/opt/homebrew/bin:/usr/bin'"));
        assert!(!script.contains("BAD-NAME"));
    }

    // 终端以非登录方式启动，不会自己重建 PATH，缺了注入就只剩 GUI 精简 PATH。
    #[test]
    fn build_terminal_env_sets_effective_path() {
        let env_vars = build_terminal_env("/bin/zsh");

        let expected = crate::path_resolver::effective_path_os()
            .to_string_lossy()
            .to_string();
        assert_eq!(env_vars.get("PATH"), Some(&expected));
        assert_eq!(
            env_vars.get("TERM_PROGRAM").map(String::as_str),
            Some("AgentDeck")
        );
        assert!(!env_vars.keys().any(|key| key.starts_with("AGENTDECK_")));
    }

    #[test]
    fn resolve_cwd_rejects_missing_dir_and_defaults_to_home() {
        assert!(resolve_cwd(Some("/no/such/agentdeck-dir-404")).is_err());
        assert_eq!(resolve_cwd(None).ok(), dirs::home_dir());
        let dir = tempfile::TempDir::new().unwrap();
        assert_eq!(
            resolve_cwd(dir.path().to_str()).unwrap(),
            dir.path().to_path_buf()
        );
    }
}
