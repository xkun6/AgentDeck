// AgentDeck 安卓壳：只承载 web/dist-mobile 的 WebView，没有任何桌面命令。
// 手机经 WebSocket 直连电脑上的 sidecar（远程网关，E2EE）；配对信息用 store 插件持久化，二维码用 barcode-scanner 扫描，后台提醒用 notification（本地通知）与自写的 native 插件（前台服务）。

#[cfg(target_os = "android")]
mod native;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_store::Builder::new().build());

    #[cfg(mobile)]
    let builder = builder
        .plugin(tauri_plugin_barcode_scanner::init())
        .plugin(tauri_plugin_notification::init());

    // 前台服务 / 电池优化 / 应用设置（仅 Android，Kotlin 实现见 native.rs）
    #[cfg(target_os = "android")]
    let builder = builder.plugin(native::init());

    builder
        .run(tauri::generate_context!())
        .expect("运行 AgentDeck 手机端失败");
}
