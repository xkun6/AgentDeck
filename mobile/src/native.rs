//! 本地插件 native：把安卓前台服务（常驻通知保活）、电池优化白名单、应用设置页包成 Tauri 命令。
//!
//! Kotlin 侧实现见 `gen/android/app/src/main/java/local/agentdeck/mobile/NativePlugin.kt`，
//! 经 `register_android_plugin` 注册，Rust 命令只是把参数转发给它。仅 Android 注册，其它平台无此插件。
use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime};

/// Kotlin 插件所在包与类名（`NativePlugin.kt`）
const PLUGIN_IDENTIFIER: &str = "local.agentdeck.mobile";
const PLUGIN_CLASS: &str = "NativePlugin";

struct NativeHandle<R: Runtime>(PluginHandle<R>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeepAliveArgs {
    text: String,
    wake_lock: bool,
}

#[derive(Serialize, Deserialize)]
struct BatteryStatus {
    ignoring: bool,
}

fn to_message(error: tauri::plugin::mobile::PluginInvokeError) -> String {
    error.to_string()
}

#[tauri::command]
async fn keepalive_start<R: Runtime>(
    app: AppHandle<R>,
    text: String,
    wake_lock: Option<bool>,
) -> Result<(), String> {
    app.state::<NativeHandle<R>>()
        .0
        .run_mobile_plugin_async::<()>(
            "keepaliveStart",
            KeepAliveArgs {
                text,
                wake_lock: wake_lock.unwrap_or(false),
            },
        )
        .await
        .map_err(to_message)
}

#[tauri::command]
async fn keepalive_stop<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.state::<NativeHandle<R>>()
        .0
        .run_mobile_plugin_async::<()>("keepaliveStop", ())
        .await
        .map_err(to_message)
}

#[tauri::command]
async fn battery_optimization_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<BatteryStatus, String> {
    app.state::<NativeHandle<R>>()
        .0
        .run_mobile_plugin_async("batteryOptimizationStatus", ())
        .await
        .map_err(to_message)
}

#[tauri::command]
async fn request_ignore_battery_optimization<R: Runtime>(
    app: AppHandle<R>,
) -> Result<(), String> {
    app.state::<NativeHandle<R>>()
        .0
        .run_mobile_plugin_async::<()>("requestIgnoreBatteryOptimization", ())
        .await
        .map_err(to_message)
}

#[tauri::command]
async fn open_app_settings<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.state::<NativeHandle<R>>()
        .0
        .run_mobile_plugin_async::<()>("openAppSettings", ())
        .await
        .map_err(to_message)
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("native")
        .invoke_handler(tauri::generate_handler![
            keepalive_start,
            keepalive_stop,
            battery_optimization_status,
            request_ignore_battery_optimization,
            open_app_settings
        ])
        .setup(|app, api| {
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, PLUGIN_CLASS)?;
            app.manage(NativeHandle(handle));
            Ok(())
        })
        .build()
}
