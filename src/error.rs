// Domain error types for the Tauri backend.
//
// Replaces the `Result<T, String>` pattern with typed errors that:
// - Give each failure a clear category for frontend handling
// - Implement Serialize so Tauri can return them to the renderer
// - Implement Display via thiserror for human-readable messages

use serde::Serialize;

#[derive(Debug, Clone, thiserror::Error)]
pub enum AppError {
    // --- Sidecar WebSocket relay ---
    #[error("Gateway WebSocket error: {0}")]
    GatewayWs(String),

    // --- Requests ---
    #[error("Invalid API request: {0}")]
    InvalidRequest(String),

    #[error("API proxy error: {0}")]
    ProxyError(String),

    #[error("Request outside allowed origin: {0}")]
    OriginViolation(String),

    // --- File operations ---
    #[error("File operation failed: {0}")]
    FileError(String),

    // --- Git ---
    #[error("Git operation failed: {0}")]
    Git(String),

    // --- State ---
    #[error("App state lock poisoned")]
    StateLockPoisoned,

    // --- Generic (escape hatch for truly unexpected errors) ---
    #[error("{0}")]
    Internal(String),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppErrorIpc {
    code: &'static str,
    kind: &'static str,
    message: String,
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::GatewayWs(_) => "gateway_ws",
            AppError::InvalidRequest(_) => "invalid_request",
            AppError::ProxyError(_) => "proxy_error",
            AppError::OriginViolation(_) => "origin_violation",
            AppError::FileError(_) => "file_error",
            AppError::Git(_) => "git",
            AppError::StateLockPoisoned => "state_lock_poisoned",
            AppError::Internal(_) => "internal",
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            AppError::GatewayWs(_) => "gateway_ws",
            AppError::InvalidRequest(_)
            | AppError::ProxyError(_)
            | AppError::OriginViolation(_) => "api_proxy",
            AppError::FileError(_) => "file",
            AppError::Git(_) => "git",
            AppError::StateLockPoisoned => "state",
            AppError::Internal(_) => "internal",
        }
    }
}

// Tauri requires Serialize to return errors to the frontend.
// Keep the human-readable message, but preserve a stable code/kind so the
// frontend can choose recovery UI without parsing localized text.
impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        AppErrorIpc {
            code: self.code(),
            kind: self.kind(),
            message: self.to_string(),
        }
        .serialize(serializer)
    }
}

// Convenience: convert any std::sync::PoisonError into AppError
impl<T> From<std::sync::PoisonError<T>> for AppError {
    fn from(_: std::sync::PoisonError<T>) -> Self {
        AppError::StateLockPoisoned
    }
}

// Convenience: convert reqwest errors
impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_timeout() {
            AppError::ProxyError(format!("Request timed out: {}", e))
        } else {
            AppError::ProxyError(e.to_string())
        }
    }
}

// Convenience: convert IO errors
impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::FileError(e.to_string())
    }
}

// Convenience: convert URL parse errors
impl From<url::ParseError> for AppError {
    fn from(e: url::ParseError) -> Self {
        AppError::InvalidRequest(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use std::sync::{Mutex, PoisonError};

    #[test]
    fn from_io_error_maps_to_file_error() {
        let io_err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        let app: AppError = io_err.into();
        assert!(matches!(app, AppError::FileError(msg) if msg.contains("denied")));
    }

    #[test]
    fn from_poison_error_maps_to_state_lock_poisoned() {
        let m = Mutex::new(0u8);
        let _ = std::panic::catch_unwind(|| {
            let _guard = m.lock().unwrap();
            panic!("poison");
        });
        let err: AppError = m.lock().unwrap_err().into();
        assert!(matches!(err, AppError::StateLockPoisoned));
    }

    #[test]
    fn from_poison_error_synthetic_also_works() {
        let poison: PoisonError<()> = PoisonError::new(());
        let err: AppError = poison.into();
        assert!(matches!(err, AppError::StateLockPoisoned));
    }

    #[test]
    fn from_url_parse_error_maps_to_invalid_request() {
        let err: url::ParseError = url::Url::parse("not a url").unwrap_err();
        let app: AppError = err.into();
        assert!(matches!(app, AppError::InvalidRequest(_)));
    }

    #[test]
    fn serialize_emits_structured_ipc_error() {
        let err = AppError::GatewayWs("boom".to_string());
        let json: serde_json::Value = serde_json::to_value(&err).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "code": "gateway_ws",
                "kind": "gateway_ws",
                "message": "Gateway WebSocket error: boom"
            })
        );
    }

    #[test]
    fn display_origin_violation_contains_origin() {
        let err = AppError::OriginViolation("https://evil.example".to_string());
        assert!(err.to_string().contains("https://evil.example"));
    }
}
