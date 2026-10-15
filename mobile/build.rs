fn main() {
    // 本地插件 native（前台服务 / 电池优化 / 应用设置 / 系统浏览器打开外链 / 系统栏安全区 / 后台提醒通知及其撤回 / 前后台状态）：声明命令，生成 native:default 权限供 capabilities 引用
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "native",
            tauri_build::InlinedPlugin::new()
                .commands(&[
                    "keepalive_start",
                    "keepalive_stop",
                    "battery_optimization_status",
                    "request_ignore_battery_optimization",
                    "open_app_settings",
                    "open_app_notification_settings",
                    "open_url",
                    "safe_area_insets",
                    "show_attention",
                    "cancel_attention",
                    "notification_status",
                    "take_launch_target",
                    "app_state",
                    "register_listener",
                    "remove_listener",
                ])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        ),
    )
    .expect("tauri-build 失败");
}
