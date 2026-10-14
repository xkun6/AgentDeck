// AgentDeck — Tauri v2 entry point.
//
// 启动流程：解析数据目录 → 单实例锁 → 创建窗口 / 托盘 → 异步拉起 Node sidecar
// → 启动 supervisor。sidecar 启动失败不阻塞窗口，前端通过 `sidecar-status`
// 事件显示错误。退出时按 docs/design.md 3.3 关闭 sidecar。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use agentdeck_core::commands;
use agentdeck_core::desktop_log;
use agentdeck_core::paths;
use agentdeck_core::process::instance;
use agentdeck_core::state::AppState;
use agentdeck_core::supervisor;
use agentdeck_core::tray;

/// 进程生命周期内持有的单实例锁。
static INSTANCE_GUARD: OnceLock<instance::InstanceGuard> = OnceLock::new();

/// Vite dev server 地址：`AGENTDECK_DEV_URL` 优先，debug 构建默认 9545；
/// release 构建返回 `None`，窗口加载打包的前端。
fn resolve_dev_url() -> Option<String> {
    if let Ok(url) = std::env::var("AGENTDECK_DEV_URL") {
        let trimmed = url.trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    if cfg!(debug_assertions) {
        return Some("http://localhost:9545".to_string());
    }
    None
}

fn shutdown(app: &tauri::AppHandle) {
    use tauri::Manager;

    if let Ok(mut inner) = app.state::<AppState>().inner.lock() {
        if let Some(relay) = inner.sidecar_ws.take() {
            relay.abort.store(true, Ordering::Relaxed);
            relay.notify.notify_waiters();
        }
    }
    supervisor::shutdown_sidecar(app);
    desktop_log::flush(std::time::Duration::from_secs(1));
}

fn main() {
    desktop_log::init();

    // Windows：设置了 AGENTDECK_HOME 时把 WebView2 用户数据也放进数据目录，
    // 保持隔离；必须在创建 webview 环境之前设置。
    #[cfg(windows)]
    if let Some(home) = std::env::var_os(paths::DATA_DIR_ENV).filter(|v| !v.is_empty()) {
        let webview_dir = std::path::PathBuf::from(home).join("webview2");
        let _ = std::fs::create_dir_all(&webview_dir);
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &webview_dir);
    }

    let quit_requested = Arc::new(AtomicBool::new(false));
    let close_quit_requested = Arc::clone(&quit_requested);
    let tray_available = Arc::new(AtomicBool::new(false));
    let setup_tray_available = Arc::clone(&tray_available);
    let close_tray_available = Arc::clone(&tray_available);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState::new())
        .setup(move |app| {
            use tauri::Manager;

            // 1. 数据目录与日志目录
            let data_dir = paths::resolve_data_dir(app.path().app_data_dir().ok())?;
            let log_dir = paths::log_dir(&data_dir);
            std::fs::create_dir_all(&log_dir)?;
            desktop_log::attach(&log_dir);
            log::info!("data dir: {}", data_dir.display());

            // 2. 单实例锁（按数据目录）
            match instance::try_acquire(&data_dir) {
                instance::SingleInstance::Acquired(guard) => {
                    let _ = INSTANCE_GUARD.set(guard);
                }
                instance::SingleInstance::AlreadyRunning => {
                    log::info!(
                        "another AgentDeck instance owns {}; requesting focus and exiting",
                        data_dir.display()
                    );
                    instance::notify_running_instance(&data_dir);
                    desktop_log::flush(std::time::Duration::from_secs(1));
                    std::process::exit(0);
                }
                instance::SingleInstance::Unavailable(reason) => {
                    // Fail open: the guard must never lock users out of their app.
                    log::warn!("single-instance lock unavailable ({reason}); continuing");
                }
            }

            {
                let state = app.state::<AppState>();
                let mut inner = state
                    .inner
                    .lock()
                    .map_err(|_| std::io::Error::other("app state lock poisoned"))?;
                inner.data_dir = data_dir.clone();
                inner.log_dir = log_dir;
                inner.resource_dir = app.path().resource_dir().ok();
            }

            // 3. 主窗口：dev 加载 Vite dev server，release 加载打包前端。
            let window_url = match resolve_dev_url() {
                Some(dev_url) => tauri::WebviewUrl::External(dev_url.parse()?),
                None => tauri::WebviewUrl::default(),
            };
            let window_builder =
                tauri::WebviewWindowBuilder::new(app, tray::MAIN_WINDOW_LABEL, window_url)
                    .title("AgentDeck")
                    .inner_size(1240.0, 820.0)
                    .min_inner_size(960.0, 680.0);
            #[cfg(target_os = "macos")]
            let window_builder = window_builder.title_bar_style(tauri::TitleBarStyle::Transparent);
            // Windows / Linux：去掉原生标题栏，由前端顶栏自绘窗口控制按钮（拖动区 + 最小化 /
            // 最大化 / 关闭）。保留系统阴影；无边框窗口的边缘缩放由 Tauri 内置处理。
            #[cfg(not(target_os = "macos"))]
            let window_builder = window_builder.decorations(false).shadow(true);
            window_builder.build()?;

            instance::clear_stale_focus_request(&data_dir);
            instance::spawn_focus_watcher(app.handle().clone(), data_dir);

            match tray::install(app) {
                Ok(()) => setup_tray_available.store(true, Ordering::Relaxed),
                Err(err) => log::warn!("Failed to install system tray: {}", err),
            }

            // 4. 异步拉起 sidecar，然后启动监管；失败只反映在 sidecar-status。
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // 先解析一次登录 shell / 注册表 PATH，sidecar 与其拉起的 Agent 都依赖它。
                let _ = tauri::async_runtime::spawn_blocking(|| {
                    agentdeck_core::path_resolver::refresh_blocking(
                        agentdeck_core::path_resolver::SHELL_PROBE_TIMEOUT,
                        true,
                    )
                })
                .await;
                supervisor::start_sidecar(&app_handle).await;
                supervisor::supervise_sidecar(app_handle).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::sidecar::get_sidecar_config,
            commands::sidecar::restart_sidecar,
            commands::file_dialogs::pick_files,
            commands::file_dialogs::pick_directory,
            commands::file_dialogs::open_workspace_path,
            commands::file_dialogs::open_external_url,
            commands::fs::fs_list,
            commands::log_export::export_log_snapshot,
            commands::session_export::export_session_file,
            commands::debug::log_tail,
            commands::debug::debug_paths,
            commands::debug::export_debug_bundle,
            commands::devtools::toggle_devtools,
            commands::environment::environment_check,
            commands::environment::environment_install,
            commands::coding_agents::coding_agents_check,
            commands::coding_agents::coding_agent_paths_get,
            commands::coding_agents::coding_agent_paths_set,
            commands::notify::desktop_notify,
            commands::ws_proxy::sidecar_ws_open,
            commands::ws_proxy::sidecar_ws_send,
            commands::ws_proxy::sidecar_ws_close,
            commands::ui_store::ui_store_snapshot,
            commands::ui_store::ui_store_set_kv,
            commands::ui_store::ui_store_remove_kv,
            commands::terminal::terminal_start,
            commands::terminal::terminal_open_external,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
            commands::preview::read_file_data_url,
            commands::preview::read_workspace_file,
            commands::preview::write_workspace_file,
            commands::preview::watch_preview_file,
            commands::preview::stop_preview_file_watch,
            commands::git::git_review_list,
            commands::git::git_review_diff,
            commands::git::git_review_stage,
            commands::git::git_review_unstage,
            commands::git::git_review_revert,
            commands::git::git_review_commit,
            commands::git::git_review_push,
            commands::git::git_review_ship_info,
            commands::git::git_review_create_pr,
            commands::git::git_worktree_list,
            commands::git::git_worktree_add,
            commands::git::git_worktree_remove,
            commands::git::git_branch_list,
            commands::git::git_branch_switch,
            commands::git::git_repo_status,
        ])
        .on_window_event(move |window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. }
                if window.label() == tray::MAIN_WINDOW_LABEL
                    && close_tray_available.load(Ordering::Relaxed)
                    && !close_quit_requested.load(Ordering::Relaxed) =>
            {
                api.prevent_close();
                tray::hide_main_window_to_tray(window);
            }
            tauri::WindowEvent::Destroyed if window.label() == tray::MAIN_WINDOW_LABEL => {
                log::info!("Main window destroyed");
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building AgentDeck");

    app.run(move |app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } => {
            quit_requested.store(true, Ordering::Relaxed);
        }
        tauri::RunEvent::Exit => {
            shutdown(app_handle);
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            tray::show_main_window(app_handle);
        }
        _ => {}
    });
}
