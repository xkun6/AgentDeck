//! sidecar 生命周期编排与后台监管。
//!
//! - `start_sidecar`：启动时拉起 sidecar，状态每次变化都更新 `AppState` 并 emit
//!   `sidecar-status`（载荷见 docs/design.md 3.4）。
//! - `restart_sidecar`：手动重启（重新生成 token，端口可能变化）。
//! - `supervise_sidecar`：沿用原 dashboard supervisor 策略——5 秒轮询，进程意外
//!   退出时自动重启；60 秒内连续失败 5 次后暂停自动重启并上报错误。自动重启拉起
//!   失败时下个周期继续重试；手动重启清零计数。
//! - `shutdown_sidecar`：应用退出时按契约关闭 sidecar。
//!
//! `sidecar_busy` 防止监管器与手动重启同时操作 `AppState::sidecar`。

use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::process::sidecar::{
    self, SidecarHandle, SidecarStatus, SidecarStatusPayload, SpawnOptions,
};
use crate::state::AppState;

/// sidecar 状态事件名。
pub const SIDECAR_STATUS_EVENT: &str = "sidecar-status";

const POLL_INTERVAL: Duration = Duration::from_secs(5);
/// 两次自动重启间隔小于该值时视为"连续"失败；运行更久则计数归零。
const HEALTHY_WINDOW: Duration = Duration::from_secs(60);
/// 连续自动重启的上限，超过后暂停自动重启。
const MAX_CONSECUTIVE_RESTARTS: u32 = 5;

/// 自动重启策略（纯逻辑，便于单测），保存在 `AppStateInner::sidecar_restart_policy`。
#[derive(Debug, Default)]
pub struct RestartPolicy {
    consecutive: u32,
    last_restart: Option<Instant>,
    /// 上一次自动重启拉起失败：下个周期即使没有进程句柄也要重试。
    retry_pending: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RestartDecision {
    /// 自动重启（第 attempt 次，1..=MAX_CONSECUTIVE_RESTARTS）
    Restart { attempt: u32 },
    /// 连续失败超过上限，暂停自动重启
    Pause { failures: u32 },
}

impl RestartPolicy {
    pub fn retry_pending(&self) -> bool {
        self.retry_pending
    }

    /// 进程意外退出或上次自动重启失败时调用。
    pub fn decide(&mut self, now: Instant) -> RestartDecision {
        self.consecutive = match self.last_restart {
            Some(prev) if now.duration_since(prev) < HEALTHY_WINDOW => self.consecutive + 1,
            _ => 1,
        };
        if self.consecutive > MAX_CONSECUTIVE_RESTARTS {
            self.retry_pending = false;
            return RestartDecision::Pause {
                failures: self.consecutive - 1,
            };
        }
        self.last_restart = Some(now);
        RestartDecision::Restart {
            attempt: self.consecutive,
        }
    }

    /// 记录一次自动重启的结果：未就绪则下个周期重试。
    pub fn record_launch(&mut self, ready: bool) {
        self.retry_pending = !ready;
    }

    /// 手动重启：清零计数与待重试标记。
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

/// 更新 `AppState::sidecar_status` 并 emit `sidecar-status`。
pub fn set_status(app: &AppHandle, payload: SidecarStatusPayload) {
    if let Ok(mut inner) = app.state::<AppState>().inner.lock() {
        inner.sidecar_status = payload.clone();
    }
    if let Err(err) = app.emit(SIDECAR_STATUS_EVENT, payload) {
        log::warn!("emit {SIDECAR_STATUS_EVENT} 失败: {err}");
    }
}

/// 当前 sidecar 状态快照。
pub fn current_status(app: &AppHandle) -> SidecarStatusPayload {
    app.state::<AppState>()
        .inner
        .lock()
        .map(|inner| inner.sidecar_status.clone())
        .unwrap_or_else(|_| SidecarStatusPayload::stopped())
}

fn failed(token: String, error: String) -> SidecarStatusPayload {
    SidecarStatusPayload {
        ws_url: String::new(),
        token,
        version: None,
        status: SidecarStatus::Failed,
        error: Some(error),
    }
}

fn try_claim(app: &AppHandle) -> bool {
    match app.state::<AppState>().inner.lock() {
        Ok(mut inner) if !inner.sidecar_busy => {
            inner.sidecar_busy = true;
            true
        }
        _ => false,
    }
}

fn release(app: &AppHandle) {
    if let Ok(mut inner) = app.state::<AppState>().inner.lock() {
        inner.sidecar_busy = false;
    }
}

fn take_handle(app: &AppHandle) -> Option<SidecarHandle> {
    app.state::<AppState>()
        .inner
        .lock()
        .ok()
        .and_then(|mut inner| inner.sidecar.take())
}

/// 在阻塞线程池中按契约关闭 sidecar（关 stdin → 等 3 秒 → 强杀）。
async fn stop_handle(handle: Option<SidecarHandle>) {
    if let Some(mut handle) = handle {
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if !handle.stop() {
                log::warn!("sidecar (pid {}) 未能确认退出", handle.child_pid());
            }
        })
        .await;
    }
}

fn resolve_and_spawn(
    token: String,
    data_dir: std::path::PathBuf,
    log_dir: std::path::PathBuf,
    resource_dir: Option<std::path::PathBuf>,
) -> Result<SidecarHandle, String> {
    let entries = crate::path_resolver::effective_entries();
    let node = sidecar::resolve_node(sidecar::current_exe_dir().as_deref(), &entries).ok_or_else(
        || {
            format!(
                "未找到 Node.js：请安装 Node.js 并确认其在 PATH 中，或设置环境变量 {}",
                sidecar::NODE_ENV
            )
        },
    )?;
    let entry =
        sidecar::resolve_entry(resource_dir.as_deref(), sidecar::dev_repo_root().as_deref())
            .ok_or_else(|| {
                format!(
                    "未找到 sidecar 入口：可设置环境变量 {} 指向 sidecar 脚本",
                    sidecar::ENTRY_ENV
                )
            })?;
    sidecar::spawn_sidecar(&SpawnOptions {
        node,
        entry,
        token,
        data_dir,
        log_dir,
        path_env: crate::path_resolver::effective_path_os(),
    })
}

/// 拉起一次 sidecar 并更新状态。调用方必须已持有 `sidecar_busy`。
async fn launch(app: &AppHandle) -> SidecarStatusPayload {
    let (data_dir, log_dir, resource_dir) = match app.state::<AppState>().inner.lock() {
        Ok(inner) => (
            inner.data_dir.clone(),
            inner.log_dir.clone(),
            inner.resource_dir.clone(),
        ),
        Err(_) => {
            let payload = failed(String::new(), "应用状态锁异常".to_string());
            set_status(app, payload.clone());
            return payload;
        }
    };

    // 每次启动都重新生成 token。
    let token = match sidecar::generate_token() {
        Ok(token) => token,
        Err(err) => {
            let payload = failed(String::new(), err);
            set_status(app, payload.clone());
            return payload;
        }
    };
    set_status(
        app,
        SidecarStatusPayload {
            ws_url: String::new(),
            token: token.clone(),
            version: None,
            status: SidecarStatus::Starting,
            error: None,
        },
    );

    let spawn_token = token.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        resolve_and_spawn(spawn_token, data_dir, log_dir, resource_dir)
    })
    .await
    .map_err(|err| format!("sidecar 启动任务异常: {err}"))
    .and_then(|result| result);

    let payload = match result {
        Ok(handle) => {
            let payload = SidecarStatusPayload {
                ws_url: handle.ws_url(),
                token,
                version: Some(handle.version.clone()),
                status: SidecarStatus::Ready,
                error: None,
            };
            let previous = match app.state::<AppState>().inner.lock() {
                Ok(mut inner) => inner.sidecar.replace(handle),
                Err(_) => Some(handle),
            };
            stop_handle(previous).await;
            payload
        }
        Err(err) => {
            log::error!("sidecar 启动失败: {err}");
            failed(token, err)
        }
    };
    set_status(app, payload.clone());
    payload
}

/// 应用启动时拉起 sidecar。失败只体现在状态里，不影响窗口。
pub async fn start_sidecar(app: &AppHandle) -> SidecarStatusPayload {
    if !try_claim(app) {
        return current_status(app);
    }
    let payload = launch(app).await;
    release(app);
    payload
}

/// 手动重启 sidecar。若已有启动/重启在进行，直接返回当前状态。
pub async fn restart_sidecar(app: &AppHandle) -> SidecarStatusPayload {
    if !try_claim(app) {
        return current_status(app);
    }
    if let Ok(mut inner) = app.state::<AppState>().inner.lock() {
        inner.sidecar_restart_policy.reset();
    }
    stop_handle(take_handle(app)).await;
    let payload = launch(app).await;
    release(app);
    payload
}

/// 应用退出时同步关闭 sidecar（最多阻塞约 3 秒 + 强杀）。
pub fn shutdown_sidecar(app: &AppHandle) {
    if let Some(mut handle) = take_handle(app) {
        log::info!("应用退出，关闭 sidecar (pid {})", handle.child_pid());
        handle.stop();
    }
    if let Ok(mut inner) = app.state::<AppState>().inner.lock() {
        inner.sidecar_status = SidecarStatusPayload::stopped();
    }
}

/// 后台监管：5 秒轮询，sidecar 意外退出时自动重启。
pub async fn supervise_sidecar(app: AppHandle) {
    let mut ticker = tokio::time::interval(POLL_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        ticker.tick().await;

        // 在锁内判定并占用 busy，避免与手动重启竞争。
        let state = app.state::<AppState>();
        let (decision, dead) = {
            let mut inner = match state.inner.lock() {
                Ok(guard) => guard,
                Err(_) => continue,
            };
            if inner.sidecar_busy {
                continue;
            }
            let exited = inner
                .sidecar
                .as_mut()
                .is_some_and(|handle| handle.has_exited());
            // 上次自动重启拉起失败时没有进程句柄，也要继续重试。
            let retry = inner.sidecar.is_none() && inner.sidecar_restart_policy.retry_pending();
            if !exited && !retry {
                continue;
            }
            inner.sidecar_busy = true;
            let decision = inner.sidecar_restart_policy.decide(Instant::now());
            (decision, inner.sidecar.take())
        };
        // 回收已退出进程，并清理 Job / 进程组里的残留子进程。
        stop_handle(dead).await;

        let attempt = match decision {
            RestartDecision::Pause { failures } => {
                log::error!("sidecar 连续异常退出 {failures} 次，暂停自动重启");
                set_status(
                    &app,
                    failed(
                        String::new(),
                        "sidecar 多次异常退出，已暂停自动重启。请手动重启，或检查 Node.js 环境 / 杀毒软件拦截。"
                            .to_string(),
                    ),
                );
                release(&app);
                continue;
            }
            RestartDecision::Restart { attempt } => attempt,
        };

        log::warn!(
            "sidecar 意外退出或上次自动重启失败，自动重启（第 {}/{} 次）",
            attempt,
            MAX_CONSECUTIVE_RESTARTS
        );
        let payload = launch(&app).await;
        if let Ok(mut inner) = state.inner.lock() {
            inner
                .sidecar_restart_policy
                .record_launch(matches!(payload.status, SidecarStatus::Ready));
        }
        release(&app);
        match payload.status {
            SidecarStatus::Ready => log::info!("sidecar 自动重启成功"),
            _ => log::error!("sidecar 自动重启失败: {:?}", payload.error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pauses_after_five_restarts_within_window() {
        let mut policy = RestartPolicy::default();
        let base = Instant::now();
        for attempt in 1..=MAX_CONSECUTIVE_RESTARTS {
            let now = base + Duration::from_secs(u64::from(attempt) * 5);
            assert_eq!(policy.decide(now), RestartDecision::Restart { attempt });
        }
        let now = base + Duration::from_secs(30);
        assert_eq!(policy.decide(now), RestartDecision::Pause { failures: 5 });
    }

    #[test]
    fn attempt_resets_after_healthy_window() {
        let mut policy = RestartPolicy::default();
        let base = Instant::now();
        assert_eq!(policy.decide(base), RestartDecision::Restart { attempt: 1 });
        assert_eq!(
            policy.decide(base + Duration::from_secs(10)),
            RestartDecision::Restart { attempt: 2 }
        );
        assert_eq!(
            policy.decide(base + Duration::from_secs(10) + HEALTHY_WINDOW),
            RestartDecision::Restart { attempt: 1 }
        );
    }

    #[test]
    fn record_launch_sets_retry_pending_and_pause_clears_it() {
        let mut policy = RestartPolicy::default();
        assert!(!policy.retry_pending());
        policy.record_launch(false);
        assert!(policy.retry_pending());
        policy.record_launch(true);
        assert!(!policy.retry_pending());

        let base = Instant::now();
        for attempt in 1..=MAX_CONSECUTIVE_RESTARTS {
            let now = base + Duration::from_secs(u64::from(attempt));
            assert_eq!(policy.decide(now), RestartDecision::Restart { attempt });
            policy.record_launch(false);
            assert!(policy.retry_pending());
        }
        assert_eq!(
            policy.decide(base + Duration::from_secs(10)),
            RestartDecision::Pause { failures: 5 }
        );
        assert!(!policy.retry_pending());
    }

    #[test]
    fn reset_clears_count_and_retry_pending() {
        let mut policy = RestartPolicy::default();
        let base = Instant::now();
        for attempt in 1..=3 {
            let now = base + Duration::from_secs(u64::from(attempt));
            assert_eq!(policy.decide(now), RestartDecision::Restart { attempt });
        }
        policy.record_launch(false);
        policy.reset();
        assert!(!policy.retry_pending());
        assert_eq!(
            policy.decide(base + Duration::from_secs(5)),
            RestartDecision::Restart { attempt: 1 }
        );
    }
}
