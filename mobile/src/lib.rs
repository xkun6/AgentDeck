// AgentDeck 安卓壳：只承载 web/dist-mobile 的 WebView，没有任何桌面命令。
// 手机经 WebSocket 直连电脑上的 sidecar（M0 阶段用 adb reverse，M1 起走远程网关）。

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("运行 AgentDeck 手机端失败");
}
