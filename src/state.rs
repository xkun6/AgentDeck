// Shared application state, passed to every Tauri command via tauri::State<AppState>.
//
// All mutable fields live behind a Mutex. Contention is low because IPC calls
// come from a single renderer and are mostly sequential. Never hold the lock
// across blocking work (e.g. stopping the sidecar) — take the value out first.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::sync::Mutex;
use tokio::sync::mpsc;
use tokio::sync::Notify;

pub use crate::process::sidecar::SidecarHandle;
use crate::process::sidecar::SidecarStatusPayload;

/// Handle to the live Rust→sidecar WebSocket relay (see commands/ws_proxy.rs).
/// Holds only std/tokio types so this module stays decoupled from the WS crate.
pub struct GatewayWsHandle {
    /// Per-connection id; relay events are tagged with it so a stale relay from
    /// a prior connection can't deliver into a freshly-opened socket's shim.
    pub connection_id: String,
    /// Outbound text frames pushed by `gateway_ws_send` → the writer task.
    pub tx: mpsc::UnboundedSender<String>,
    /// Set to stop the reader/writer tasks (checked at each loop iteration).
    pub abort: Arc<AtomicBool>,
    /// Wakes the reader/writer tasks so they observe `abort` promptly.
    pub notify: Arc<Notify>,
}

/// Interior mutable state shared across all Tauri commands.
pub struct AppStateInner {
    /// 应用数据目录（`AGENTDECK_HOME` 或 Tauri app_data_dir）。
    pub data_dir: PathBuf,
    /// 日志目录 `<data>/logs`。
    pub log_dir: PathBuf,
    /// Tauri 资源目录（打包态 sidecar bundle 所在处）。
    pub resource_dir: Option<PathBuf>,
    /// 当前运行的 sidecar 进程。
    pub sidecar: Option<SidecarHandle>,
    /// 当前 sidecar 状态（`get_sidecar_config` 返回值 / `sidecar-status` 载荷）。
    pub sidecar_status: SidecarStatusPayload,
    /// 正在启动 / 重启 sidecar，防止监管器与手动重启竞争。
    pub sidecar_busy: bool,
    /// 自动重启策略状态，监管器与手动重启共用。
    pub sidecar_restart_policy: crate::supervisor::RestartPolicy,
    /// The live Rust→sidecar WS relay connection, when the webview is on the
    /// relay socket path. `None` on webview-direct WS or before the first
    /// relay connect.
    pub gateway_ws: Option<GatewayWsHandle>,
}

/// Thread-safe wrapper. Tauri manages this via `app.manage(AppState::new())`.
pub struct AppState {
    pub inner: Mutex<AppStateInner>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(AppStateInner {
                data_dir: PathBuf::new(),
                log_dir: PathBuf::new(),
                resource_dir: None,
                sidecar: None,
                sidecar_status: SidecarStatusPayload::stopped(),
                sidecar_busy: false,
                sidecar_restart_policy: crate::supervisor::RestartPolicy::default(),
                gateway_ws: None,
            }),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
