fn main() {
    // 本地插件 native（前台服务 / 电池优化 / 应用设置）：声明命令，生成 native:default 权限供 capabilities 引用
    tauri_build::try_build(tauri_build::Attributes::new().plugin(
        "native",
        tauri_build::InlinedPlugin::new()
            .commands(&[
                "keepalive_start",
                "keepalive_stop",
                "battery_optimization_status",
                "request_ignore_battery_optimization",
                "open_app_settings",
            ])
            .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
    ))
    .expect("tauri-build 失败");
}
