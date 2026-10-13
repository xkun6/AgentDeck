use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::error::{AppError, AppResult};

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Json,
    Markdown,
}

impl ExportFormat {
    fn extension(self) -> &'static str {
        match self {
            ExportFormat::Json => "json",
            ExportFormat::Markdown => "md",
        }
    }

    fn filter_name(self) -> &'static str {
        match self {
            ExportFormat::Json => "JSON 会话文件",
            ExportFormat::Markdown => "Markdown 会话文件",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSessionFileInput {
    pub file_name: String,
    pub content: String,
    pub format: ExportFormat,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSessionFileResult {
    pub ok: bool,
    pub canceled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[tauri::command]
pub async fn export_session_file(
    app: tauri::AppHandle,
    input: ExportSessionFileInput,
) -> AppResult<ExportSessionFileResult> {
    let Some(path) = choose_session_save_path(
        app,
        safe_file_name(&input.file_name, input.format),
        input.format,
    )
    .await?
    else {
        return Ok(ExportSessionFileResult {
            ok: false,
            canceled: true,
            path: None,
            bytes: 0,
            error: None,
        });
    };

    let path = ensure_extension(path, input.format);
    let bytes = input.content.len() as u64;
    let write_path = path.clone();
    let content = input.content;
    let write_result =
        tauri::async_runtime::spawn_blocking(move || fs::write(&write_path, content))
            .await
            .map_err(|error| AppError::Internal(error.to_string()))?;

    match write_result {
        Ok(()) => Ok(ExportSessionFileResult {
            ok: true,
            canceled: false,
            path: Some(path.to_string_lossy().to_string()),
            bytes,
            error: None,
        }),
        Err(error) => Ok(ExportSessionFileResult {
            ok: false,
            canceled: false,
            path: Some(path.to_string_lossy().to_string()),
            bytes: 0,
            error: Some(error.to_string()),
        }),
    }
}

async fn choose_session_save_path(
    app: tauri::AppHandle,
    file_name: String,
    format: ExportFormat,
) -> AppResult<Option<PathBuf>> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("导出 AgentDeck 会话")
        .set_file_name(file_name)
        .add_filter(format.filter_name(), &[format.extension()])
        .save_file(move |path| {
            let result = path.and_then(|value| value.as_path().map(|path| path.to_path_buf()));
            let _ = tx.send(result);
        });
    rx.await
        .map_err(|error| AppError::Internal(error.to_string()))
}

fn safe_file_name(file_name: &str, format: ExportFormat) -> String {
    let mut cleaned = file_name
        .trim()
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            character if character.is_control() => '_',
            character => character,
        })
        .collect::<String>();

    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        cleaned = "session-export".to_string();
    }
    let suffix = format!(".{}", format.extension());
    if !cleaned.to_lowercase().ends_with(&suffix) {
        cleaned.push_str(&suffix);
    }
    cleaned
}

fn ensure_extension(mut path: PathBuf, format: ExportFormat) -> PathBuf {
    let has_extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(format.extension()));
    if !has_extension {
        path.set_extension(format.extension());
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_file_name_removes_path_characters_and_adds_extension() {
        assert_eq!(
            safe_file_name("session-bad/name:1", ExportFormat::Json),
            "session-bad_name_1.json"
        );
        assert_eq!(
            safe_file_name("session-ok.JSON", ExportFormat::Json),
            "session-ok.JSON"
        );
        assert_eq!(
            safe_file_name("..", ExportFormat::Json),
            "session-export.json"
        );
        assert_eq!(
            safe_file_name("会话-20260101-0900", ExportFormat::Markdown),
            "会话-20260101-0900.md"
        );
        assert_eq!(
            safe_file_name("notes.MD", ExportFormat::Markdown),
            "notes.MD"
        );
    }

    #[test]
    fn ensure_extension_replaces_other_extension() {
        assert_eq!(
            ensure_extension(PathBuf::from("/tmp/session.txt"), ExportFormat::Json),
            PathBuf::from("/tmp/session.json")
        );
        assert_eq!(
            ensure_extension(PathBuf::from("/tmp/session.JSON"), ExportFormat::Json),
            PathBuf::from("/tmp/session.JSON")
        );
        assert_eq!(
            ensure_extension(PathBuf::from("/tmp/session.json"), ExportFormat::Markdown),
            PathBuf::from("/tmp/session.md")
        );
        assert_eq!(
            ensure_extension(PathBuf::from("/tmp/session"), ExportFormat::Markdown),
            PathBuf::from("/tmp/session.md")
        );
    }

    #[test]
    fn export_format_deserializes_lowercase() {
        let input: ExportSessionFileInput =
            serde_json::from_str(r#"{"fileName":"a","content":"b","format":"markdown"}"#).unwrap();
        assert_eq!(input.format, ExportFormat::Markdown);
        assert!(serde_json::from_str::<ExportFormat>(r#""json""#).is_ok());
        assert!(serde_json::from_str::<ExportFormat>(r#""pdf""#).is_err());
    }
}
