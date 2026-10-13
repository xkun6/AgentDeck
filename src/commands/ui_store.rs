use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;
use crate::ui_store::{self, UiStoreRemoveKvInput, UiStoreSetKvInput, UiStoreSnapshot};

fn data_dir(state: &State<'_, AppState>) -> AppResult<String> {
    let inner = state.inner.lock()?;
    Ok(inner.data_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn ui_store_snapshot(state: State<'_, AppState>) -> AppResult<UiStoreSnapshot> {
    ui_store::snapshot(&data_dir(&state)?)
}

#[tauri::command]
pub fn ui_store_set_kv(state: State<'_, AppState>, input: UiStoreSetKvInput) -> AppResult<bool> {
    ui_store::set_kv(&data_dir(&state)?, input)?;
    Ok(true)
}

#[tauri::command]
pub fn ui_store_remove_kv(
    state: State<'_, AppState>,
    input: UiStoreRemoveKvInput,
) -> AppResult<bool> {
    ui_store::remove_kv(&data_dir(&state)?, input)?;
    Ok(true)
}
