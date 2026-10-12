//! Per-data-dir single-instance guard.
//!
//! Two shells sharing one data directory would fight over the same sidecar and
//! UI store, so a second launch against the SAME data dir must hand focus to
//! the incumbent and exit. Distinct data dirs (e.g. `AGENTDECK_HOME` pointing
//! elsewhere) keep coexisting, which is why this is an advisory file lock
//! scoped to the data dir rather than `tauri-plugin-single-instance` (that
//! plugin keys on the app identifier).
//!
//! Lock-file semantics: the file carries no content and is never deleted.
//! Both `flock` (Unix) and `LockFileEx` (Windows, via `fs2`) release the
//! lock when the owning process dies, so a leftover file from a crashed
//! shell can never deadlock the next launch.

use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::Duration;

use fs2::FileExt;

#[cfg(target_os = "windows")]
use std::sync::Mutex;

const INSTANCE_LOCK_FILENAME: &str = "desktop-instance.lock";
const FOCUS_REQUEST_FILENAME: &str = "focus-request.json";
/// Poll cadence for the focus watcher. A 1s stat of one small file is
/// negligible, and polling (unlike `notify` watches) behaves identically on
/// network volumes and every Windows filesystem.
const FOCUS_WATCH_INTERVAL: Duration = Duration::from_secs(1);
/// Escape hatch for QA / development multi-open against one root.
const SINGLE_INSTANCE_ENV: &str = "AGENTDECK_SINGLE_INSTANCE";

/// Holding this guard means holding the exclusive instance lock; keep it
/// alive for the whole process.
pub struct InstanceGuard {
    _file: std::fs::File,
}

// Windows named mutex handle kept alive for the process lifetime. Stored
// here so the mutex object persists in the kernel namespace, preventing
// rapid double-clicks from creating a second instance before the file
// lock is set up.
#[cfg(target_os = "windows")]
static NAMED_MUTEX_HANDLE: Mutex<Option<isize>> = Mutex::new(None);

pub enum SingleInstance {
    /// We own the data dir; proceed with startup.
    Acquired(InstanceGuard),
    /// A live shell already owns this data dir.
    AlreadyRunning,
    /// The lock could not be evaluated (exotic filesystem, permissions…).
    /// Callers must FAIL OPEN — never let the guard itself block startup.
    Unavailable(String),
}

fn instance_lock_path(data_dir: &Path) -> PathBuf {
    data_dir.join(INSTANCE_LOCK_FILENAME)
}

fn focus_request_path(data_dir: &Path) -> PathBuf {
    data_dir.join(FOCUS_REQUEST_FILENAME)
}

fn single_instance_disabled() -> bool {
    std::env::var(SINGLE_INSTANCE_ENV)
        .map(|v| {
            let v = v.trim();
            v == "0" || v.eq_ignore_ascii_case("false") || v.eq_ignore_ascii_case("off")
        })
        .unwrap_or(false)
}

/// Try to become the single desktop instance for `data_dir`.
pub fn try_acquire(data_dir: &Path) -> SingleInstance {
    if single_instance_disabled() {
        log::warn!(
            "{SINGLE_INSTANCE_ENV} disables the single-instance guard; \
             concurrent shells on one data dir are unsupported"
        );
        return SingleInstance::Unavailable(format!("disabled via {SINGLE_INSTANCE_ENV}"));
    }

    // Windows: use a named mutex as a fast secondary guard that catches
    // rapid double-clicks before the file lock is set up. The handle is
    // stored in NAMED_MUTEX_HANDLE and automatically released on process exit.
    #[cfg(target_os = "windows")]
    {
        match try_acquire_named_mutex(data_dir) {
            Ok(()) => {}
            Err(already) if already => return SingleInstance::AlreadyRunning,
            Err(_) => {
                // Fail-open: if the named mutex can't be created, the
                // file lock below will still catch conflicts.
            }
        }
    }

    let lock_path = instance_lock_path(data_dir);
    if let Some(parent) = lock_path.parent() {
        if let Err(err) = fs::create_dir_all(parent) {
            return SingleInstance::Unavailable(format!(
                "create data dir {}: {err}",
                parent.display()
            ));
        }
    }

    let file = match OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
    {
        Ok(file) => file,
        Err(err) => {
            return SingleInstance::Unavailable(format!("open {}: {err}", lock_path.display()));
        }
    };

    match file.try_lock_exclusive() {
        Ok(()) => SingleInstance::Acquired(InstanceGuard { _file: file }),
        Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => SingleInstance::AlreadyRunning,
        Err(err) => SingleInstance::Unavailable(format!("lock {}: {err}", lock_path.display())),
    }
}

/// Try to acquire a Windows named mutex as a secondary single-instance guard.
/// Returns `Ok(())` on first acquisition, `Err(true)` if another instance holds
/// the mutex, or `Err(false)` if the OS call failed (fail-open).
/// The handle is stored in `NAMED_MUTEX_HANDLE` so it stays alive for the
/// process lifetime, keeping the mutex visible to other processes.
#[cfg(target_os = "windows")]
fn try_acquire_named_mutex(data_dir: &Path) -> Result<(), bool> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
    use windows_sys::Win32::System::Threading::CreateMutexW;

    let root_str = data_dir.to_string_lossy();
    let safe_name = root_str.replace("\\", "_").replace(":", "");
    let wide: Vec<u16> = OsStr::new(&format!("Local\\AgentDeck_{safe_name}"))
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // CreateMutexW with bInitialOwner=0 returns a handle to the mutex.
    // If the mutex already existed, GetLastError() returns ERROR_ALREADY_EXISTS.
    // This single-call approach avoids the TOCTOU race between OpenMutexW
    // and CreateMutexW.
    let handle: HANDLE = unsafe { CreateMutexW(std::ptr::null(), 0, wide.as_ptr()) };
    if handle.is_null() {
        return Err(false); // Unavailable (fail-open)
    }

    let already_exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    if already_exists {
        unsafe {
            CloseHandle(handle);
        }
        return Err(true);
    }

    // Store the handle so it outlives this function call.
    if let Ok(mut guard) = NAMED_MUTEX_HANDLE.lock() {
        *guard = Some(handle as isize);
    } else {
        // Lock poisoned — close the handle directly.
        unsafe {
            CloseHandle(handle);
        }
        return Err(false);
    }

    Ok(())
}

/// Ask the incumbent instance to bring its main window to the foreground.
/// Atomic write (temp file + rename) so the watcher never reads a torn file.
pub fn notify_running_instance(data_dir: &Path) {
    let path = focus_request_path(data_dir);
    let Some(parent) = path.parent().map(PathBuf::from) else {
        return;
    };
    let payload = format!(
        "{{\"pid\":{},\"at_ms\":{}}}\n",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let write = || -> std::io::Result<()> {
        let mut tmp = tempfile::NamedTempFile::new_in(&parent)?;
        use std::io::Write;
        tmp.write_all(payload.as_bytes())?;
        tmp.persist(&path).map_err(|e| e.error)?;
        Ok(())
    };
    if let Err(err) = write() {
        log::warn!("failed to write focus request {}: {err}", path.display());
    }
}

/// Remove a leftover focus request from a previous run. Called by the lock
/// holder during startup — its window is about to show anyway, so consuming
/// a racing request here is equivalent to honoring it.
pub fn clear_stale_focus_request(data_dir: &Path) {
    let path = focus_request_path(data_dir);
    match fs::remove_file(&path) {
        Ok(()) => log::debug!("cleared stale focus request {}", path.display()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => log::debug!("focus request cleanup {}: {err}", path.display()),
    }
}

/// Watch for focus requests from would-be second instances and raise the
/// main window. Delete-then-show ordering: showing is idempotent, so a
/// failed show never leaves the file behind to storm the loop.
pub fn spawn_focus_watcher(app: tauri::AppHandle, data_dir: PathBuf) {
    let path = focus_request_path(&data_dir);
    std::thread::Builder::new()
        .name("instance-focus-watcher".into())
        .spawn(move || loop {
            if path.exists() {
                match fs::remove_file(&path) {
                    Ok(()) => {
                        log::info!("focus requested by another launch; raising main window");
                        crate::tray::show_main_window(&app);
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                    Err(err) => {
                        log::debug!("focus request consume {}: {err}", path.display());
                    }
                }
            }
            std::thread::sleep(FOCUS_WATCH_INTERVAL);
        })
        .map(|_| ())
        .unwrap_or_else(|err| log::warn!("failed to spawn focus watcher: {err}"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    fn with_data_dir<T>(f: impl FnOnce(&std::path::Path) -> T) -> T {
        let dir = tempfile::TempDir::new().expect("tempdir");
        f(dir.path())
    }

    #[test]
    #[serial]
    fn second_acquire_returns_already_running() {
        with_data_dir(|root| {
            let first = try_acquire(root);
            let guard = match first {
                SingleInstance::Acquired(g) => g,
                _ => panic!("first acquire should succeed"),
            };
            // flock/LockFileEx exclude a second descriptor even within one
            // process, so this models a second shell faithfully.
            match try_acquire(root) {
                SingleInstance::AlreadyRunning => {}
                SingleInstance::Acquired(_) => panic!("second acquire must be blocked"),
                SingleInstance::Unavailable(err) => panic!("unexpected: {err}"),
            }
            drop(guard);
        });
    }

    #[test]
    #[serial]
    fn drop_guard_releases_lock() {
        with_data_dir(|root| {
            match try_acquire(root) {
                SingleInstance::Acquired(guard) => drop(guard),
                _ => panic!("first acquire should succeed"),
            }
            // On Windows the named mutex handle is stored in a module-level
            // static and persists until process exit, so a second acquisition
            // within the SAME process sees it as AlreadyRunning (the same as
            // a second process would). This is correct cross-process behavior.
            // On non-Windows (or if the named mutex fails), the file lock
            // alone is the guard and should be reacquirable after drop.
            match try_acquire(root) {
                SingleInstance::Acquired(_) => {}
                #[cfg(not(target_os = "windows"))]
                _ => panic!("lock must be reacquirable after drop"),
                #[cfg(target_os = "windows")]
                SingleInstance::AlreadyRunning => {}
                #[cfg(target_os = "windows")]
                SingleInstance::Unavailable(_) => {
                    // Named mutex unavailable (fail-open) → file lock should
                    // still be reacquirable after the guard drop.
                }
            }
        });
    }

    #[test]
    #[serial]
    fn focus_request_roundtrip() {
        with_data_dir(|root| {
            notify_running_instance(root);
            let path = root.join(FOCUS_REQUEST_FILENAME);
            let body = std::fs::read_to_string(&path).expect("focus request written");
            assert!(body.contains("\"pid\""), "payload has pid: {body}");
            clear_stale_focus_request(root);
            assert!(!path.exists(), "cleared focus request must be gone");
            // Clearing again is a no-op, not an error.
            clear_stale_focus_request(root);
        });
    }

    #[test]
    #[serial]
    fn env_escape_hatch_disables_lock() {
        with_data_dir(|root| {
            std::env::set_var(SINGLE_INSTANCE_ENV, "0");
            let out = try_acquire(root);
            std::env::remove_var(SINGLE_INSTANCE_ENV);
            match out {
                SingleInstance::Unavailable(reason) => {
                    assert!(reason.contains(SINGLE_INSTANCE_ENV), "{reason}");
                }
                _ => panic!("escape hatch must report Unavailable (fail-open)"),
            }
        });
    }
}
