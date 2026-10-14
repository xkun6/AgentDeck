// 桌面调试入口（仅为让 crate 在非 Android 目标下也能 `cargo check`）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    agentdeck_mobile_lib::run();
}
