//! 应用数据目录解析。
//!
//! 数据目录 = 环境变量 `AGENTDECK_HOME`（非空时），否则 Tauri 的
//! `app.path().app_data_dir()`。日志目录固定为 `<data>/logs`。

use std::path::{Path, PathBuf};

/// 覆盖数据目录的环境变量（测试隔离 / 便携使用）。
pub const DATA_DIR_ENV: &str = "AGENTDECK_HOME";

/// 解析数据目录：`AGENTDECK_HOME` 优先，其次 Tauri 提供的 `app_data_dir`。
pub fn resolve_data_dir(app_data_dir: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os(DATA_DIR_ENV) {
        if !value.is_empty() {
            return Ok(PathBuf::from(value));
        }
    }
    app_data_dir.ok_or_else(|| format!("无法确定应用数据目录，请设置环境变量 {DATA_DIR_ENV}"))
}

/// 日志目录 `<data>/logs`。
pub fn log_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("logs")
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use serial_test::serial;

    #[test]
    #[serial]
    fn env_override_wins_over_app_data_dir() {
        let dir = tempfile::TempDir::new().unwrap();
        std::env::set_var(DATA_DIR_ENV, dir.path());
        let resolved = resolve_data_dir(Some(PathBuf::from("/fallback")));
        std::env::remove_var(DATA_DIR_ENV);
        assert_eq!(resolved.unwrap(), dir.path().to_path_buf());
    }

    #[test]
    #[serial]
    fn falls_back_to_app_data_dir_when_env_missing_or_empty() {
        std::env::remove_var(DATA_DIR_ENV);
        assert_eq!(
            resolve_data_dir(Some(PathBuf::from("/fallback"))).unwrap(),
            PathBuf::from("/fallback")
        );
        std::env::set_var(DATA_DIR_ENV, "");
        let resolved = resolve_data_dir(Some(PathBuf::from("/fallback")));
        std::env::remove_var(DATA_DIR_ENV);
        assert_eq!(resolved.unwrap(), PathBuf::from("/fallback"));
        assert!(resolve_data_dir(None).is_err());
    }

    #[test]
    fn log_dir_is_under_data_dir() {
        assert_eq!(log_dir(Path::new("/data")), Path::new("/data").join("logs"));
    }
}
