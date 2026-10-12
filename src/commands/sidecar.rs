//! sidecar 相关命令（契约见 docs/design.md 3.4）。

use tauri::State;

use crate::error::AppResult;
use crate::process::sidecar::SidecarStatusPayload;
use crate::state::AppState;

/// 返回当前 sidecar 地址、token、版本与状态。
#[tauri::command]
pub fn get_sidecar_config(state: State<'_, AppState>) -> AppResult<SidecarStatusPayload> {
    Ok(state.inner.lock()?.sidecar_status.clone())
}

/// 重启 sidecar（重新生成 token，端口可能变化），返回重启后的状态。
#[tauri::command]
pub async fn restart_sidecar(app: tauri::AppHandle) -> AppResult<SidecarStatusPayload> {
    Ok(crate::supervisor::restart_sidecar(&app).await)
}
