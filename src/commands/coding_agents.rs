use std::path::PathBuf;

use tauri::State;

use crate::coding_agents::{
    collect_coding_agents_check, read_coding_agent_paths, save_coding_agent_paths,
    CodingAgentPaths, CodingAgentsCheckResult,
};
use crate::error::AppError;
use crate::state::AppState;

fn data_dir(state: &State<'_, AppState>) -> Result<PathBuf, AppError> {
    Ok(state.inner.lock()?.data_dir.clone())
}

#[tauri::command]
pub async fn coding_agents_check(
    state: State<'_, AppState>,
) -> Result<CodingAgentsCheckResult, AppError> {
    let data_dir = data_dir(&state)?;
    // 与 environment_check 同款：先非强制刷新 PATH，让「刷新检测」能看到
    // 刚装好的 claude/codex 而无需重启应用（resolver 自带节流）。
    let _ = tauri::async_runtime::spawn_blocking(|| {
        crate::path_resolver::refresh_blocking(crate::path_resolver::SHELL_PROBE_TIMEOUT, false)
    })
    .await;
    let result =
        tauri::async_runtime::spawn_blocking(move || collect_coding_agents_check(&data_dir))
            .await
            .map_err(|err| AppError::Internal(format!("coding agents check join error: {err}")))?;
    Ok(result)
}

/// 读取「编程 Agent」页配置的 Claude / Codex 可执行文件路径（None = 自动查找）。
#[tauri::command]
pub fn coding_agent_paths_get(state: State<'_, AppState>) -> Result<CodingAgentPaths, AppError> {
    Ok(read_coding_agent_paths(&data_dir(&state)?))
}

/// 保存路径配置：非空值必须是绝对路径且文件存在，否则返回中文错误；sidecar 下次解析即生效。
#[tauri::command]
pub fn coding_agent_paths_set(
    state: State<'_, AppState>,
    paths: CodingAgentPaths,
) -> Result<CodingAgentPaths, AppError> {
    save_coding_agent_paths(&data_dir(&state)?, paths).map_err(AppError::Internal)
}
