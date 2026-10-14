//! 本地插件 native：安卓前台服务（常驻通知保活）、电池优化白名单、应用设置页、后台提醒通知及其点击回调。
//!
//! Kotlin 侧实现见 `gen/android/app/src/main/java/local/agentdeck/mobile/NativePlugin.kt`，经 `register_android_plugin` 注册。
//! 移动端 Tauri 会把 Rust 没有处理的 `plugin:native|<command>` 按 lowerCamelCase 直接转给 Kotlin 同名方法
//! （`keepalive_start` → `keepaliveStart`），所以这里不需要再写一层 Rust 命令。仅 Android 注册。
use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Kotlin 插件所在包与类名（`NativePlugin.kt`）
const PLUGIN_IDENTIFIER: &str = "local.agentdeck.mobile";
const PLUGIN_CLASS: &str = "NativePlugin";

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("native")
        .setup(|_app, api| {
            api.register_android_plugin(PLUGIN_IDENTIFIER, PLUGIN_CLASS)?;
            Ok(())
        })
        .build()
}
