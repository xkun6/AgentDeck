//! Rust-side WebSocket relay to the Node sidecar's JSON-RPC endpoint
//! (`ws://127.0.0.1:<port>/rpc?token=...`, see docs/design.md §3–4).
//!
//! The renderer normally connects to the sidecar directly. A Tauri webview can't
//! always do that (a packaged WKWebView may refuse `ws://127.0.0.1` from the
//! `tauri://` origin as mixed content), so this module lets the *Rust* process —
//! which has no webview origin restriction — open the socket and relay frames
//! to/from the webview over Tauri events + commands. The wire protocol is
//! unchanged; only the carrier differs.
//!
//! Wire contract with the JS shim (`web/src/lib/gateway-relay-socket.ts`):
//!   - `gateway_ws_open { connectionId }`  → resolves once the WS handshake succeeds
//!   - emits `gateway-ws-message { connectionId, data }` per inbound text frame
//!   - emits `gateway-ws-closed  { connectionId, message }` on close/error/EOF
//!   - `gateway_ws_send  { connectionId, data }` → write one text frame
//!   - `gateway_ws_close { connectionId }`        → tear the connection down
//!
//! Every event is tagged with `connectionId` so a stale relay from a prior
//! connection can never deliver into a freshly-opened socket's shim.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use tokio::sync::{mpsc, Notify};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::error::AppError;
use crate::process::sidecar::SidecarStatus;
use crate::state::{AppState, GatewayWsHandle};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayWsOpenInput {
    pub connection_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayWsSendInput {
    pub connection_id: String,
    pub data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayWsCloseInput {
    pub connection_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WsMessagePayload {
    connection_id: String,
    data: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WsClosedPayload {
    connection_id: String,
    message: String,
    /// WebSocket close code, when the peer sent a Close frame. The frontend
    /// uses this to decide whether to keep reconnecting.
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<u16>,
}

/// Tear down whatever connection is currently active (if any). Caller holds no lock.
fn shutdown_active(state: &State<'_, AppState>) -> Result<(), AppError> {
    let mut inner = state.inner.lock()?;
    if let Some(prev) = inner.gateway_ws.take() {
        prev.abort.store(true, Ordering::Relaxed);
        prev.notify.notify_waiters();
    }
    Ok(())
}

pub type GatewayWebSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

/// Open the current sidecar's JSON-RPC WebSocket (`wsUrl?token=...`).
pub async fn connect_gateway_stream(state: &AppState) -> Result<GatewayWebSocket, AppError> {
    let url = {
        let inner = state.inner.lock()?;
        let status = &inner.sidecar_status;
        if status.status != SidecarStatus::Ready || status.ws_url.is_empty() {
            return Err(AppError::GatewayWs("sidecar 尚未就绪".to_string()));
        }
        format!(
            "{}?token={}",
            status.ws_url,
            urlencoding::encode(&status.token)
        )
    };
    tokio_tungstenite::connect_async(url)
        .await
        .map(|(ws, _)| ws)
        .map_err(|e| AppError::GatewayWs(e.to_string()))
}

/// Open the sidecar WebSocket from Rust and start relaying frames.
///
/// Resolves once the handshake completes; the JS shim treats that as `onopen`.
#[tauri::command]
pub async fn gateway_ws_open(
    input: GatewayWsOpenInput,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let connection_id = input.connection_id;
    shutdown_active(&state)?;

    let stream = connect_gateway_stream(&state).await?;

    let (mut sink, mut read) = stream.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let abort = Arc::new(AtomicBool::new(false));
    let notify = Arc::new(Notify::new());

    {
        let mut inner = state.inner.lock()?;
        inner.gateway_ws = Some(GatewayWsHandle {
            connection_id: connection_id.clone(),
            tx,
            abort: abort.clone(),
            notify: notify.clone(),
        });
    }

    // Writer task: drains outbound frames; closes the socket on abort / channel drop.
    {
        let abort_w = abort.clone();
        let notify_w = notify.clone();
        tauri::async_runtime::spawn(async move {
            // On this split sink/stream relay, tungstenite's automatic pong only
            // flushes when the write half is polled — and the writer sits idle
            // between RPCs. Send our own keepalive ping so an otherwise-quiet
            // connection stays warm and any pending pong gets flushed. The reader
            // ignores inbound Ping/Pong frames.
            let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(10));
            keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                if abort_w.load(Ordering::Relaxed) {
                    break;
                }
                tokio::select! {
                    _ = notify_w.notified() => break,
                    _ = keepalive.tick() => {
                        if sink.send(Message::Ping(Default::default())).await.is_err() {
                            break;
                        }
                    }
                    out = rx.recv() => match out {
                        Some(text) => {
                            if sink.send(Message::text(text)).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
            }
            let _ = sink.close().await;
        });
    }

    // Reader task: relays inbound text frames to the webview; emits closed on end.
    {
        let app_r = app.clone();
        let cid = connection_id.clone();
        let abort_r = abort.clone();
        let notify_r = notify.clone();
        tauri::async_runtime::spawn(async move {
            let mut reason = String::from("closed");
            let mut close_code: Option<u16> = None;
            loop {
                if abort_r.load(Ordering::Relaxed) {
                    break;
                }
                tokio::select! {
                    _ = notify_r.notified() => break,
                    item = read.next() => match item {
                        Some(Ok(Message::Text(t))) => {
                            let _ = app_r.emit(
                                "gateway-ws-message",
                                WsMessagePayload { connection_id: cid.clone(), data: t.to_string() },
                            );
                        }
                        // The JSON-RPC gateway speaks text frames only; ping/pong are
                        // handled inside tungstenite, binary is unexpected — ignore both.
                        Some(Ok(Message::Binary(_))) | Some(Ok(Message::Ping(_)))
                        | Some(Ok(Message::Pong(_))) | Some(Ok(Message::Frame(_))) => {}
                        Some(Ok(Message::Close(frame))) => {
                            // Capture the numeric close code so the frontend can
                            // decide whether to keep reconnecting.
                            close_code = frame.as_ref().map(|f| u16::from(f.code));
                            reason = frame
                                .map(|f| f.reason.to_string())
                                .filter(|r| !r.is_empty())
                                .unwrap_or_else(|| "closed".to_string());
                            break;
                        }
                        Some(Err(e)) => {
                            reason = e.to_string();
                            break;
                        }
                        None => {
                            reason = "stream ended".to_string();
                            break;
                        }
                    }
                }
            }
            // Wake the writer so it closes the socket too.
            abort_r.store(true, Ordering::Relaxed);
            notify_r.notify_waiters();
            // Drop the handle if it is still ours (a newer open may have replaced it).
            if let Ok(mut inner) = app_r.state::<AppState>().inner.lock() {
                if inner
                    .gateway_ws
                    .as_ref()
                    .is_some_and(|h| h.connection_id == cid)
                {
                    inner.gateway_ws = None;
                }
            }
            let _ = app_r.emit(
                "gateway-ws-closed",
                WsClosedPayload {
                    connection_id: cid,
                    message: reason,
                    code: close_code,
                },
            );
        });
    }

    Ok(())
}

#[tauri::command]
pub async fn gateway_ws_send(
    input: GatewayWsSendInput,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let inner = state.inner.lock()?;
    match &inner.gateway_ws {
        Some(handle) if handle.connection_id == input.connection_id => handle
            .tx
            .send(input.data)
            .map_err(|_| AppError::GatewayWs("relay send channel closed".to_string())),
        _ => Err(AppError::GatewayWs(
            "no active relay connection".to_string(),
        )),
    }
}

#[tauri::command]
pub async fn gateway_ws_close(
    input: GatewayWsCloseInput,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let mut inner = state.inner.lock()?;
    if let Some(handle) = inner.gateway_ws.as_ref() {
        if handle.connection_id == input.connection_id {
            handle.abort.store(true, Ordering::Relaxed);
            handle.notify.notify_waiters();
            inner.gateway_ws = None;
        }
    }
    Ok(())
}
