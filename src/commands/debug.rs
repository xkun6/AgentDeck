//! Debug 面板与诊断包（design.md 4.18）：`log_tail`、`debug_paths`、`export_debug_bundle`。

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::coding_agents::CODING_AGENT_PATHS_FILE;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const LOG_FILE: &str = "sidecar.log";
const DEFAULT_TAIL_BYTES: u64 = 256 * 1024;
const MAX_TAIL_BYTES: u64 = 2 * 1024 * 1024;
/// 诊断包里每个日志文件最多取最后 5 MB。
const BUNDLE_LOG_BYTES: u64 = 5 * 1024 * 1024;
/// 与 sidecar `redact.ts` 的 REDACTED 一致。
const REDACTED: &str = "***";
/// env 值长度达到该值才脱敏（4.7）。
const MIN_ENV_SECRET_LENGTH: usize = 6;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogTailInput {
    pub max_bytes: Option<u64>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogTailResult {
    pub path: String,
    pub text: String,
    pub truncated: bool,
    pub size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugPaths {
    pub data_dir: String,
    pub log_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webview_data_dir: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDebugBundleInput {
    pub diagnostics: String,
    pub frontend_events: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDebugBundleResult {
    pub ok: bool,
    pub canceled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn dirs_of(state: &State<'_, AppState>) -> AppResult<(PathBuf, PathBuf)> {
    let inner = state.inner.lock()?;
    Ok((inner.data_dir.clone(), inner.log_dir.clone()))
}

/// 读取文件尾部最多 `max_bytes` 字节；截断时从下一个换行之后开始；UTF-8 宽松解码。
fn read_tail(path: &Path, max_bytes: u64) -> std::io::Result<(String, bool, u64)> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok((String::new(), false, 0))
        }
        Err(err) => return Err(err),
    };
    let size = file.metadata()?.len();
    let truncated = size > max_bytes;
    let start = if truncated { size - max_bytes } else { 0 };
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity((size - start) as usize);
    file.take(max_bytes).read_to_end(&mut buf)?;
    let slice: &[u8] = if truncated {
        match buf.iter().position(|b| *b == b'\n') {
            Some(index) => &buf[index + 1..],
            None => &[],
        }
    } else {
        &buf
    };
    Ok((String::from_utf8_lossy(slice).into_owned(), truncated, size))
}

fn log_tail_in(log_dir: &Path, max_bytes: Option<u64>) -> std::io::Result<LogTailResult> {
    let max = max_bytes
        .unwrap_or(DEFAULT_TAIL_BYTES)
        .clamp(1, MAX_TAIL_BYTES);
    let path = log_dir.join(LOG_FILE);
    let (text, truncated, size) = read_tail(&path, max)?;
    Ok(LogTailResult {
        path: path.to_string_lossy().to_string(),
        text,
        truncated,
        size,
    })
}

#[tauri::command]
pub async fn log_tail(
    state: State<'_, AppState>,
    input: Option<LogTailInput>,
) -> AppResult<LogTailResult> {
    let (_, log_dir) = dirs_of(&state)?;
    let max_bytes = input.and_then(|i| i.max_bytes);
    tauri::async_runtime::spawn_blocking(move || log_tail_in(&log_dir, max_bytes))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(|e| AppError::FileError(e.to_string()))
}

fn webview_data_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os(crate::paths::DATA_DIR_ENV).filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(home).join("webview2"));
    }
    if cfg!(windows) {
        return dirs::data_local_dir()
            .map(|dir| dir.join("local.agentdeck.desktop").join("EBWebView"));
    }
    None
}

#[tauri::command]
pub fn debug_paths(state: State<'_, AppState>) -> AppResult<DebugPaths> {
    let (data_dir, log_dir) = dirs_of(&state)?;
    Ok(DebugPaths {
        data_dir: data_dir.to_string_lossy().to_string(),
        log_dir: log_dir.to_string_lossy().to_string(),
        webview_data_dir: webview_data_dir().map(|p| p.to_string_lossy().to_string()),
    })
}

fn redact_env_object(value: Option<&mut Value>) {
    if let Some(Value::Object(env)) = value {
        for entry in env.values_mut() {
            if let Value::String(text) = entry {
                if text.chars().count() >= MIN_ENV_SECRET_LENGTH {
                    *entry = Value::String(REDACTED.to_string());
                }
            }
        }
    }
}

/// providers.json 脱敏（4.7）：apiKey 一律；`env` 与 `settings.env` 中长度 ≥ 6 的值。
/// 解析失败返回 None（宁可不放，也不放原文）。
fn redact_providers_json(raw: &str) -> Option<String> {
    let mut root: Value = serde_json::from_str(raw).ok()?;
    if let Some(Value::Array(providers)) = root.get_mut("providers") {
        for profile in providers {
            let Some(profile) = profile.as_object_mut() else {
                continue;
            };
            if let Some(key) = profile.get_mut("apiKey") {
                if !key.is_null() && key.as_str() != Some("") {
                    *key = Value::String(REDACTED.to_string());
                }
            }
            redact_env_object(profile.get_mut("env"));
            if let Some(Value::Object(settings)) = profile.get_mut("settings") {
                redact_env_object(settings.get_mut("env"));
            }
        }
    }
    serde_json::to_string_pretty(&root).ok()
}

fn read_last_bytes(path: &Path, max_bytes: u64) -> Option<Vec<u8>> {
    let mut file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(size.saturating_sub(max_bytes)))
        .ok()?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// 把诊断包写入 `target`，返回 zip 字节数。
fn write_bundle(
    target: &Path,
    data_dir: &Path,
    log_dir: &Path,
    diagnostics: &str,
    frontend_events: &str,
) -> Result<u64, String> {
    let file = File::create(target).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut add = |name: &str, bytes: &[u8]| -> Result<(), String> {
        zip.start_file(name, options).map_err(|e| e.to_string())?;
        zip.write_all(bytes).map_err(|e| e.to_string())
    };

    add("diagnostics.json", diagnostics.as_bytes())?;
    add("frontend-events.jsonl", frontend_events.as_bytes())?;
    for (name, entry) in [
        ("logs/sidecar.log", LOG_FILE.to_string()),
        ("logs/sidecar.log.1", format!("{LOG_FILE}.1")),
    ] {
        if let Some(bytes) = read_last_bytes(&log_dir.join(entry), BUNDLE_LOG_BYTES) {
            add(name, &bytes)?;
        }
    }
    if let Some(redacted) = fs::read_to_string(data_dir.join("providers.json"))
        .ok()
        .and_then(|raw| redact_providers_json(&raw))
    {
        add("config/providers.json", redacted.as_bytes())?;
    }
    if let Ok(bytes) = fs::read(data_dir.join(CODING_AGENT_PATHS_FILE)) {
        add("config/coding-agent-paths.json", &bytes)?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    fs::metadata(target)
        .map(|m| m.len())
        .map_err(|e| e.to_string())
}

/// 当前 UTC 时间的 `yyyyMMdd-HHmmss`。
fn timestamp_label() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    format_timestamp(secs)
}

fn format_timestamp(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Howard Hinnant 的 civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}{:02}",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

async fn choose_bundle_path(
    app: tauri::AppHandle,
    file_name: String,
) -> AppResult<Option<PathBuf>> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("导出 AgentDeck 诊断包")
        .set_file_name(file_name)
        .add_filter("诊断包", &["zip"])
        .save_file(move |path| {
            let result = path.and_then(|p| p.as_path().map(|path| path.to_path_buf()));
            let _ = tx.send(result);
        });
    rx.await.map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command]
pub async fn export_debug_bundle(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    input: ExportDebugBundleInput,
) -> AppResult<ExportDebugBundleResult> {
    let (data_dir, log_dir) = dirs_of(&state)?;
    let file_name = format!("agentdeck-debug-{}.zip", timestamp_label());
    let Some(mut path) = choose_bundle_path(app, file_name).await? else {
        return Ok(ExportDebugBundleResult {
            ok: false,
            canceled: true,
            path: None,
            bytes: 0,
            error: None,
        });
    };
    if !path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
    {
        path.set_extension("zip");
    }

    let target = path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        write_bundle(
            &target,
            &data_dir,
            &log_dir,
            &input.diagnostics,
            &input.frontend_events,
        )
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;

    let path_text = path.to_string_lossy().to_string();
    Ok(match result {
        Ok(bytes) => ExportDebugBundleResult {
            ok: true,
            canceled: false,
            path: Some(path_text),
            bytes,
            error: None,
        },
        Err(error) => ExportDebugBundleResult {
            ok: false,
            canceled: false,
            path: Some(path_text),
            bytes: 0,
            error: Some(error),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    #[test]
    fn log_tail_missing_file_is_empty() {
        let dir = TempDir::new().unwrap();
        let result = log_tail_in(dir.path(), None).unwrap();
        assert_eq!(result.text, "");
        assert_eq!(result.size, 0);
        assert!(!result.truncated);
    }

    #[test]
    fn log_tail_returns_whole_file_when_small() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(LOG_FILE), "a\nb\n").unwrap();
        let result = log_tail_in(dir.path(), None).unwrap();
        assert_eq!(result.text, "a\nb\n");
        assert_eq!(result.size, 4);
        assert!(!result.truncated);
    }

    #[test]
    fn log_tail_truncates_and_aligns_to_next_line() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join(LOG_FILE),
            "line-one\nline-two\nline-three\n",
        )
        .unwrap();
        // 末尾 14 字节为 "o\nline-three\n" 之类，从第一个换行之后开始
        let result = log_tail_in(dir.path(), Some(15)).unwrap();
        assert!(result.truncated);
        assert_eq!(result.text, "line-three\n");
        assert_eq!(result.size, 29);
    }

    #[test]
    fn log_tail_without_newline_in_window_returns_empty_and_clamps_max() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(LOG_FILE), "x".repeat(100)).unwrap();
        let result = log_tail_in(dir.path(), Some(10)).unwrap();
        assert!(result.truncated);
        assert_eq!(result.text, "");
        // 0 被钳到 1 而不是读全部
        assert!(log_tail_in(dir.path(), Some(0)).unwrap().truncated);
    }

    #[test]
    fn log_tail_decodes_utf8_lossily() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(LOG_FILE), b"ok \xff\xfe bad\n").unwrap();
        let result = log_tail_in(dir.path(), None).unwrap();
        assert!(result.text.contains('\u{FFFD}'));
        assert!(result.text.contains("bad"));
    }

    #[test]
    fn providers_json_is_redacted() {
        let raw = r#"{"version":1,"providers":[{"id":"a","apiKey":"sk-secret-key","baseUrl":"https://x.example",
            "env":{"LONG":"abcdefgh","SHORT":"1"},
            "settings":{"env":{"ANTHROPIC_AUTH_TOKEN":"tok-123456","FLAG":"true"},"model":"opus"}},
            {"id":"b","apiKey":""}]}"#;
        let out = redact_providers_json(raw).unwrap();
        assert!(!out.contains("sk-secret-key"));
        assert!(!out.contains("abcdefgh"));
        assert!(!out.contains("tok-123456"));
        let value: Value = serde_json::from_str(&out).unwrap();
        let first = &value["providers"][0];
        assert_eq!(first["apiKey"], "***");
        assert_eq!(first["baseUrl"], "https://x.example");
        assert_eq!(first["env"]["LONG"], "***");
        assert_eq!(first["env"]["SHORT"], "1");
        assert_eq!(first["settings"]["env"]["ANTHROPIC_AUTH_TOKEN"], "***");
        assert_eq!(first["settings"]["env"]["FLAG"], "true");
        assert_eq!(first["settings"]["model"], "opus");
        assert_eq!(value["providers"][1]["apiKey"], "");
    }

    #[test]
    fn invalid_providers_json_is_not_included() {
        assert!(redact_providers_json("{ not json sk-leak").is_none());
    }

    fn entry_names(path: &Path) -> Vec<String> {
        let mut archive = zip::ZipArchive::new(File::open(path).unwrap()).unwrap();
        let mut names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn bundle_contains_expected_entries_and_redacts() {
        let data = TempDir::new().unwrap();
        let logs = data.path().join("logs");
        fs::create_dir_all(&logs).unwrap();
        fs::write(logs.join(LOG_FILE), "log\n").unwrap();
        fs::write(logs.join("sidecar.log.1"), "old\n").unwrap();
        fs::write(
            data.path().join("providers.json"),
            r#"{"providers":[{"apiKey":"topsecret"}]}"#,
        )
        .unwrap();
        fs::write(data.path().join(CODING_AGENT_PATHS_FILE), "{}").unwrap();
        fs::write(data.path().join("ui.sqlite"), "db").unwrap();
        fs::write(data.path().join("sidecar.token"), "TOKEN").unwrap();
        let out = TempDir::new().unwrap();
        let target = out.path().join("bundle.zip");

        let bytes = write_bundle(&target, data.path(), &logs, "{\"a\":1}", "{}\n").unwrap();
        assert!(bytes > 0);
        assert_eq!(
            entry_names(&target),
            vec![
                "config/coding-agent-paths.json",
                "config/providers.json",
                "diagnostics.json",
                "frontend-events.jsonl",
                "logs/sidecar.log",
                "logs/sidecar.log.1",
            ]
        );
        let mut archive = zip::ZipArchive::new(File::open(&target).unwrap()).unwrap();
        let mut text = String::new();
        archive
            .by_name("config/providers.json")
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert!(!text.contains("topsecret"));
    }

    #[test]
    fn bundle_skips_missing_optional_files() {
        let data = TempDir::new().unwrap();
        let logs = data.path().join("logs");
        let out = TempDir::new().unwrap();
        let target = out.path().join("bundle.zip");
        write_bundle(&target, data.path(), &logs, "{}", "").unwrap();
        assert_eq!(
            entry_names(&target),
            vec!["diagnostics.json", "frontend-events.jsonl"]
        );
    }

    #[test]
    fn timestamp_formats_utc() {
        assert_eq!(format_timestamp(0), "19700101-000000");
        assert_eq!(format_timestamp(1_709_164_800 + 3661), "20240229-010101");
    }
}
