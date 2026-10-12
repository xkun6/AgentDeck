//! 本地文件列表（docs/design.md 4.6）：供前端目录选择器浏览本机目录。
//!
//! 读取失败不返回 `Err`，而是在结果里带中文 `error` 与空 `entries`，
//! 便于前端就地提示。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FsListInput {
    /// 缺省列主目录；Windows 下空字符串列盘符。
    pub path: Option<String>,
    pub show_hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsListResult {
    pub path: String,
    pub parent: Option<String>,
    pub home: String,
    pub entries: Vec<FsEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[tauri::command]
pub async fn fs_list(input: Option<FsListInput>) -> AppResult<FsListResult> {
    let input = input.unwrap_or_default();
    // 网络盘 / 慢磁盘可能阻塞，放到阻塞线程池里读。
    tauri::async_runtime::spawn_blocking(move || list_dir(input.path.as_deref(), input.show_hidden))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))
}

/// 命令主体，与 AppHandle 无关，便于单元测试。
pub fn list_dir(path: Option<&str>, show_hidden: bool) -> FsListResult {
    let home_dir = dirs::home_dir();
    let home = home_dir.as_deref().map(display_path).unwrap_or_default();

    let target = match path {
        None => match home_dir {
            Some(dir) => dir,
            None => return failure(String::new(), home, "无法确定用户主目录"),
        },
        Some(raw) if raw.trim().is_empty() => {
            #[cfg(windows)]
            {
                return FsListResult {
                    path: String::new(),
                    parent: None,
                    home,
                    entries: drive_entries(),
                    error: None,
                };
            }
            #[cfg(not(windows))]
            {
                PathBuf::from("/")
            }
        }
        Some(raw) => normalize_input(raw.trim()),
    };

    let canonical = match fs::canonicalize(&target) {
        Ok(path) => path,
        Err(err) => {
            let shown = std::path::absolute(&target).unwrap_or(target);
            return failure(display_path(&shown), home, &io_error_message(&err));
        }
    };
    let shown = display_path(&canonical);
    let parent = canonical.parent().map(display_path);

    if !canonical.is_dir() {
        return FsListResult {
            path: shown,
            parent,
            home,
            entries: Vec::new(),
            error: Some("该路径不是目录".to_string()),
        };
    }

    let read = match fs::read_dir(&canonical) {
        Ok(read) => read,
        Err(err) => {
            return FsListResult {
                path: shown,
                parent,
                home,
                entries: Vec::new(),
                error: Some(io_error_message(&err)),
            };
        }
    };

    let mut entries: Vec<FsEntry> = read
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !show_hidden && is_hidden(&name, &entry) {
                return None;
            }
            let full = entry.path();
            let is_dir = match entry.file_type() {
                // 符号链接 / 目录联接按目标类型归类；目标失效则当文件。
                Ok(kind) if kind.is_symlink() => fs::metadata(&full).is_ok_and(|m| m.is_dir()),
                Ok(kind) => kind.is_dir(),
                Err(_) => false,
            };
            Some(FsEntry {
                name,
                path: display_path(&full),
                is_dir,
            })
        })
        .collect();
    sort_entries(&mut entries);

    FsListResult {
        path: shown,
        parent,
        home,
        entries,
        error: None,
    }
}

fn failure(path: String, home: String, message: &str) -> FsListResult {
    FsListResult {
        path,
        parent: None,
        home,
        entries: Vec::new(),
        error: Some(message.to_string()),
    }
}

fn io_error_message(err: &io::Error) -> String {
    match err.kind() {
        io::ErrorKind::NotFound => "路径不存在".to_string(),
        io::ErrorKind::PermissionDenied => "没有权限访问该目录".to_string(),
        _ => format!("无法读取目录：{err}"),
    }
}

/// Windows 下 `C:` 表示「C 盘的当前目录」，补成 `C:\` 才是盘符根目录。
fn normalize_input(raw: &str) -> PathBuf {
    let bytes = raw.as_bytes();
    if cfg!(windows) && bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return PathBuf::from(format!("{raw}\\"));
    }
    PathBuf::from(raw)
}

/// 目录在前、文件在后，各自按名称不区分大小写排序。
fn sort_entries(entries: &mut [FsEntry]) {
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
}

fn is_hidden(name: &str, entry: &fs::DirEntry) -> bool {
    if name.starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_HIDDEN;
        if let Ok(meta) = entry.metadata() {
            return meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0;
        }
    }
    #[cfg(not(windows))]
    let _ = entry;
    false
}

/// 返回给前端的路径：绝对路径，去掉 Windows 的 `\\?\` 扩展前缀。
fn display_path(path: &Path) -> String {
    strip_verbatim_prefix(&path.to_string_lossy())
}

fn strip_verbatim_prefix(raw: &str) -> String {
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        raw.to_string()
    }
}

/// 盘符列表：只看 `GetLogicalDrives` 位图，不逐个访问，避免断开的网络盘
/// 或无介质的可移动盘拖慢 / 弹窗。
#[cfg(windows)]
fn drive_entries() -> Vec<FsEntry> {
    use windows_sys::Win32::Storage::FileSystem::GetLogicalDrives;
    // SAFETY: 无参数的只读系统调用。
    let mask = unsafe { GetLogicalDrives() };
    (0..26u8)
        .filter(|bit| mask & (1 << bit) != 0)
        .map(|bit| {
            let root = format!("{}:\\", (b'A' + bit) as char);
            FsEntry {
                name: root.clone(),
                path: root,
                is_dir: true,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    fn canonical(path: &Path) -> String {
        display_path(&fs::canonicalize(path).unwrap())
    }

    fn names(result: &FsListResult) -> Vec<&str> {
        result.entries.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn sorts_dirs_first_then_case_insensitive_names() {
        let tmp = TempDir::new().unwrap();
        for dir in ["b_dir", "A_dir"] {
            fs::create_dir(tmp.path().join(dir)).unwrap();
        }
        for file in ["c.txt", "B.txt", "a.txt"] {
            fs::write(tmp.path().join(file), "x").unwrap();
        }

        let result = list_dir(tmp.path().to_str(), false);

        assert_eq!(result.error, None);
        assert_eq!(
            names(&result),
            vec!["A_dir", "b_dir", "a.txt", "B.txt", "c.txt"]
        );
        assert_eq!(
            result.entries.iter().map(|e| e.is_dir).collect::<Vec<_>>(),
            vec![true, true, false, false, false]
        );
        let base = canonical(tmp.path());
        assert_eq!(result.path, base);
        assert_eq!(
            result.entries[0].path,
            display_path(&Path::new(&base).join("A_dir"))
        );
    }

    #[test]
    fn hides_dot_entries_unless_show_hidden() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join(".git")).unwrap();
        fs::write(tmp.path().join(".env"), "x").unwrap();
        fs::write(tmp.path().join("visible.txt"), "x").unwrap();

        assert_eq!(
            names(&list_dir(tmp.path().to_str(), false)),
            vec!["visible.txt"]
        );
        assert_eq!(
            names(&list_dir(tmp.path().to_str(), true)),
            vec![".git", ".env", "visible.txt"]
        );
    }

    #[cfg(windows)]
    #[test]
    fn hides_windows_hidden_attribute_entries() {
        let tmp = TempDir::new().unwrap();
        let secret = tmp.path().join("secret.txt");
        fs::write(&secret, "x").unwrap();
        fs::write(tmp.path().join("plain.txt"), "x").unwrap();
        let status = std::process::Command::new("attrib")
            .arg("+h")
            .arg(&secret)
            .status()
            .unwrap();
        assert!(status.success());

        assert_eq!(
            names(&list_dir(tmp.path().to_str(), false)),
            vec!["plain.txt"]
        );
        assert_eq!(
            names(&list_dir(tmp.path().to_str(), true)),
            vec!["plain.txt", "secret.txt"]
        );
    }

    #[test]
    fn missing_path_returns_error_without_entries() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("no-such-dir");

        let result = list_dir(missing.to_str(), false);

        assert_eq!(result.error.as_deref(), Some("路径不存在"));
        assert!(result.entries.is_empty());
        assert!(!result.path.is_empty());
    }

    #[test]
    fn file_path_returns_not_a_directory_error() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("a.txt");
        fs::write(&file, "x").unwrap();

        let result = list_dir(file.to_str(), false);

        assert_eq!(result.error.as_deref(), Some("该路径不是目录"));
        assert!(result.entries.is_empty());
    }

    #[test]
    fn parent_points_to_containing_dir_and_is_null_at_root() {
        let tmp = TempDir::new().unwrap();
        let child = tmp.path().join("child");
        fs::create_dir(&child).unwrap();

        let result = list_dir(child.to_str(), false);
        assert_eq!(result.parent, Some(canonical(tmp.path())));

        let root = fs::canonicalize(tmp.path())
            .unwrap()
            .ancestors()
            .last()
            .unwrap()
            .to_path_buf();
        let root_result = list_dir(Some(&display_path(&root)), false);
        assert_eq!(root_result.parent, None);
        assert_eq!(root_result.error, None);
    }

    #[test]
    fn missing_path_lists_home_dir() {
        let result = list_dir(None, false);
        let home = dirs::home_dir().map(|h| canonical(&h)).unwrap_or_default();
        assert_eq!(result.path, home);
        assert_eq!(result.home, display_path(&dirs::home_dir().unwrap()));
    }

    #[test]
    fn strips_windows_verbatim_prefixes() {
        assert_eq!(strip_verbatim_prefix(r"\\?\C:\Users\me"), r"C:\Users\me");
        assert_eq!(
            strip_verbatim_prefix(r"\\?\UNC\server\share"),
            r"\\server\share"
        );
        assert_eq!(strip_verbatim_prefix("/home/me"), "/home/me");
    }

    #[cfg(windows)]
    #[test]
    fn empty_path_lists_drives_on_windows() {
        let result = list_dir(Some(""), false);

        assert_eq!(result.path, "");
        assert_eq!(result.parent, None);
        assert_eq!(result.error, None);
        let system_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
        let expected = format!("{}\\", system_drive.to_uppercase());
        assert!(
            result
                .entries
                .iter()
                .any(|e| e.path == expected && e.is_dir),
            "drive list should include {expected}: {:?}",
            result.entries
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_have_no_verbatim_prefix() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("sub")).unwrap();

        let result = list_dir(tmp.path().to_str(), false);

        assert!(!result.path.starts_with(r"\\?\"));
        assert!(result.entries.iter().all(|e| !e.path.starts_with(r"\\?\")));
        let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
        assert_eq!(list_dir(Some(&drive), false).path, format!("{drive}\\"));
    }

    #[test]
    fn input_deserializes_camel_case_with_defaults() {
        let input: FsListInput = serde_json::from_str(r#"{"showHidden":true}"#).unwrap();
        assert_eq!(input.path, None);
        assert!(input.show_hidden);
        let empty: FsListInput = serde_json::from_str("{}").unwrap();
        assert!(!empty.show_hidden);
    }
}
