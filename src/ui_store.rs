use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};

const UI_DB_FILE: &str = "ui.sqlite";
const SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiStoreSnapshot {
    pub kv: HashMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiStoreSetKvInput {
    pub key: String,
    pub value: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiStoreRemoveKvInput {
    pub key: String,
}

pub fn db_path(data_dir: &str) -> PathBuf {
    Path::new(data_dir).join(UI_DB_FILE)
}

fn sqlite_err(e: rusqlite::Error) -> AppError {
    AppError::Internal(format!("UI store sqlite error: {}", e))
}

fn json_err(e: serde_json::Error) -> AppError {
    AppError::Internal(format!("UI store json error: {}", e))
}

fn connect(data_dir: &str) -> AppResult<Connection> {
    let path = db_path(data_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(path).map_err(sqlite_err)?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(sqlite_err)?;
    conn.pragma_update(None, "busy_timeout", 5000)
        .map_err(sqlite_err)?;
    init_schema(&conn)?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS ui_schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ui_kv (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        ",
    )
    .map_err(sqlite_err)?;

    conn.execute(
        "INSERT OR IGNORE INTO ui_schema_migrations(version, applied_at) VALUES(?, strftime('%s','now') * 1000)",
        params![SCHEMA_VERSION],
    )
    .map_err(sqlite_err)?;
    Ok(())
}

fn clean_key(key: &str) -> AppResult<String> {
    let key = key.trim();
    if key.is_empty() {
        return Err(AppError::InvalidRequest("UI store key is empty".into()));
    }
    if key.len() > 256 {
        return Err(AppError::InvalidRequest("UI store key is too long".into()));
    }
    Ok(key.to_string())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn snapshot(data_dir: &str) -> AppResult<UiStoreSnapshot> {
    let conn = connect(data_dir)?;
    let mut stmt = conn
        .prepare("SELECT key, value_json FROM ui_kv ORDER BY key")
        .map_err(sqlite_err)?;
    let rows = stmt
        .query_map([], |row| {
            let key: String = row.get(0)?;
            let raw: String = row.get(1)?;
            Ok((key, raw))
        })
        .map_err(sqlite_err)?;

    let mut kv = HashMap::new();
    for row in rows {
        let (key, raw) = row.map_err(sqlite_err)?;
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            kv.insert(key, value);
        }
    }
    Ok(UiStoreSnapshot { kv })
}

pub fn set_kv(data_dir: &str, input: UiStoreSetKvInput) -> AppResult<()> {
    let key = clean_key(&input.key)?;
    let raw = serde_json::to_string(&input.value).map_err(json_err)?;
    let conn = connect(data_dir)?;
    conn.execute(
        "INSERT INTO ui_kv(key, value_json, updated_at)
         VALUES(?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
        params![key, raw, now_ms()],
    )
    .map_err(sqlite_err)?;
    Ok(())
}

pub fn remove_kv(data_dir: &str, input: UiStoreRemoveKvInput) -> AppResult<()> {
    let key = clean_key(&input.key)?;
    let conn = connect(data_dir)?;
    conn.execute("DELETE FROM ui_kv WHERE key = ?", params![key])
        .map_err(sqlite_err)?;
    Ok(())
}

pub fn kv_value(data_dir: &str, key: &str) -> AppResult<Option<Value>> {
    let conn = connect(data_dir)?;
    let raw: Option<String> = conn
        .query_row(
            "SELECT value_json FROM ui_kv WHERE key = ?",
            params![clean_key(key)?],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite_err)?;
    raw.map(|value| serde_json::from_str::<Value>(&value).map_err(json_err))
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    #[test]
    fn kv_roundtrip() {
        let dir = TempDir::new().unwrap();
        set_kv(
            dir.path().to_str().unwrap(),
            UiStoreSetKvInput {
                key: "hello".into(),
                value: serde_json::json!({ "world": true }),
            },
        )
        .unwrap();
        let snap = snapshot(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(snap.kv["hello"], serde_json::json!({ "world": true }));
    }
}
