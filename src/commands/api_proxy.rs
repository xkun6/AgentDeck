// 外部 HTTP 请求命令：external_request、download_external_image。
//
// 只允许 https，以及指向本机的 http；拒绝私网 / 链路本地等内网 IP（含 DNS
// 解析结果），每次重定向都重新校验。

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::LazyLock;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

const EXTERNAL_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_EXTERNAL_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const MAX_EXTERNAL_IMAGE_REDIRECTS: usize = 5;

static EXTERNAL_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(EXTERNAL_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("valid external HTTP client")
});

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRequestInput {
    pub path: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRequestResult {
    pub ok: bool,
    pub status: u16,
    pub status_text: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadExternalImageInput {
    pub url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadExternalImageResult {
    pub final_url: String,
    pub filename: String,
    pub mime_type: String,
    pub data_base64: String,
    pub size: usize,
}

fn external_image_limit_error() -> AppError {
    AppError::InvalidRequest(format!(
        "download_external_image exceeds {} MiB limit",
        MAX_EXTERNAL_IMAGE_BYTES / 1024 / 1024
    ))
}

fn is_blocked_external_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let octets = v4.octets();
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_unspecified()
                || octets[0] == 0
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        }
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            v6.is_loopback()
                || v6.is_unspecified()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || v6
                    .to_ipv4_mapped()
                    .is_some_and(|v4| is_blocked_external_ip(IpAddr::V4(v4)))
        }
    }
}

fn is_allowed_local_external_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_unspecified(),
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6
                    .to_ipv4_mapped()
                    .is_some_and(|v4| v4.is_loopback() || v4.is_unspecified())
        }
    }
}

fn is_allowed_local_external_domain(host: &str) -> bool {
    let lower_host = host.trim_end_matches('.').to_ascii_lowercase();
    lower_host == "localhost" || lower_host.ends_with(".localhost")
}

fn is_allowed_local_external_url(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) => is_allowed_local_external_domain(host),
        Some(url::Host::Ipv4(ip)) => is_allowed_local_external_ip(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => is_allowed_local_external_ip(IpAddr::V6(ip)),
        None => false,
    }
}

fn validate_external_url_shape(raw: &str) -> Result<url::Url, AppError> {
    let url = url::Url::parse(raw)?;
    let is_local_url = is_allowed_local_external_url(&url);
    if url.scheme() != "https" && !(url.scheme() == "http" && is_local_url) {
        return Err(AppError::InvalidRequest(
            "external_request only allows https URLs; http is only allowed for local URLs"
                .to_string(),
        ));
    }

    match url.host().ok_or_else(|| {
        AppError::InvalidRequest("external_request URL must include a host".to_string())
    })? {
        url::Host::Domain(_) => {}
        url::Host::Ipv4(ip) => {
            let ip = IpAddr::V4(ip);
            if !is_allowed_local_external_ip(ip) && is_blocked_external_ip(ip) {
                return Err(AppError::InvalidRequest(
                    "external_request refuses private or local IP targets".to_string(),
                ));
            }
        }
        url::Host::Ipv6(ip) => {
            let ip = IpAddr::V6(ip);
            if !is_allowed_local_external_ip(ip) && is_blocked_external_ip(ip) {
                return Err(AppError::InvalidRequest(
                    "external_request refuses private or local IP targets".to_string(),
                ));
            }
        }
    }

    Ok(url)
}

async fn validate_external_url(raw: &str) -> Result<url::Url, AppError> {
    let url = validate_external_url_shape(raw)?;

    if let Some(url::Host::Domain(host)) = url.host() {
        if is_allowed_local_external_domain(host) {
            return Ok(url);
        }
        let port = url.port_or_known_default().ok_or_else(|| {
            AppError::InvalidRequest("external_request URL must include a port".to_string())
        })?;
        let resolved = tokio::net::lookup_host((host, port)).await.map_err(|e| {
            AppError::InvalidRequest(format!("external_request DNS lookup failed: {}", e))
        })?;
        for addr in resolved {
            if is_blocked_external_ip(addr.ip()) {
                return Err(AppError::InvalidRequest(
                    "external_request refuses hosts resolving to private or local IPs".to_string(),
                ));
            }
        }
    }

    Ok(url)
}

/// Proxy an HTTP request to an arbitrary external URL (15s timeout).
#[tauri::command]
pub async fn external_request(input: ApiRequestInput) -> Result<ApiRequestResult, AppError> {
    let target_url = validate_external_url(&input.path).await?;
    external_request_impl(input, target_url).await
}

fn image_mime_from_magic(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n']) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        return Some("image/tiff");
    }
    None
}

fn image_extension(mime: &str) -> &'static str {
    match mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/tiff" => "tiff",
        "image/svg+xml" => "svg",
        "image/avif" => "avif",
        _ => "png",
    }
}

fn content_type_mime(headers: &reqwest::header::HeaderMap) -> Option<String> {
    headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
        })
        .filter(|value| !value.is_empty())
}

fn filename_from_url(url: &url::Url, mime_type: &str) -> String {
    let ext = image_extension(mime_type);
    let candidate = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .unwrap_or("external-image");
    let safe: String = candidate
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let safe = safe.trim_matches('.').trim_matches('_');
    if safe.is_empty() {
        return format!("external-image.{ext}");
    }
    if safe.rsplit_once('.').is_some_and(|(_, suffix)| {
        (2..=8).contains(&suffix.len()) && suffix.chars().all(|ch| ch.is_ascii_alphanumeric())
    }) {
        safe.to_string()
    } else {
        format!("{safe}.{ext}")
    }
}

async fn read_response_limited(
    response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, AppError> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(external_image_limit_error());
    }

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            AppError::InvalidRequest(format!("download_external_image failed: {}", e))
        })?;
        if bytes.len() + chunk.len() > limit {
            return Err(external_image_limit_error());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn next_redirect_url(
    current: &url::Url,
    response: &reqwest::Response,
) -> Result<url::Url, AppError> {
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            AppError::InvalidRequest(
                "download_external_image redirect missing Location".to_string(),
            )
        })?;
    let next = current.join(location)?;
    validate_external_url(next.as_str()).await
}

pub async fn download_external_image_impl(
    input: DownloadExternalImageInput,
    mut target_url: url::Url,
) -> Result<DownloadExternalImageResult, AppError> {
    use base64::Engine;

    for redirect_count in 0..=MAX_EXTERNAL_IMAGE_REDIRECTS {
        let response = EXTERNAL_HTTP_CLIENT
            .get(target_url.clone())
            .header(
                reqwest::header::ACCEPT,
                "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8,*/*;q=0.3",
            )
            .send()
            .await
            .map_err(|e| {
                AppError::InvalidRequest(format!(
                    "download_external_image failed for {}: {}",
                    input.url, e
                ))
            })?;

        if response.status().is_redirection() {
            if redirect_count >= MAX_EXTERNAL_IMAGE_REDIRECTS {
                return Err(AppError::InvalidRequest(
                    "download_external_image followed too many redirects".to_string(),
                ));
            }
            target_url = next_redirect_url(&target_url, &response).await?;
            continue;
        }

        if !response.status().is_success() {
            return Err(AppError::InvalidRequest(format!(
                "download_external_image returned HTTP {}",
                response.status().as_u16()
            )));
        }

        let header_mime = content_type_mime(response.headers());
        let bytes = read_response_limited(response, MAX_EXTERNAL_IMAGE_BYTES).await?;
        let magic_mime = image_mime_from_magic(&bytes).map(str::to_string);
        let mime_type = match (header_mime, magic_mime) {
            // Trust explicit image/* for formats not covered by the small magic
            // table (for example avif), but still reject empty bodies below.
            (Some(header), _) if header.starts_with("image/") => header,
            (_, Some(magic)) => magic,
            _ => {
                return Err(AppError::InvalidRequest(
                    "download_external_image URL did not return image content".to_string(),
                ));
            }
        };
        if bytes.is_empty() {
            return Err(AppError::InvalidRequest(
                "download_external_image returned an empty image".to_string(),
            ));
        }
        let filename = filename_from_url(&target_url, &mime_type);
        return Ok(DownloadExternalImageResult {
            final_url: target_url.to_string(),
            filename,
            mime_type,
            data_base64: base64::engine::general_purpose::STANDARD.encode(bytes.as_slice()),
            size: bytes.len(),
        });
    }

    Err(AppError::InvalidRequest(
        "download_external_image followed too many redirects".to_string(),
    ))
}

/// Download a public image URL for use as a composer attachment. URL validation
/// intentionally mirrors `external_request` and every redirect is revalidated.
#[tauri::command]
pub async fn download_external_image(
    input: DownloadExternalImageInput,
) -> Result<DownloadExternalImageResult, AppError> {
    let target_url = validate_external_url(&input.url).await?;
    download_external_image_impl(input, target_url).await
}

/// Core implementation of `external_request` with validation already handled by
/// the caller. Exposed for integration tests so wiremock can exercise request
/// forwarding without loosening production URL validation.
pub async fn external_request_impl(
    input: ApiRequestInput,
    target_url: url::Url,
) -> Result<ApiRequestResult, AppError> {
    external_request_impl_with_client(input, target_url, &EXTERNAL_HTTP_CLIENT).await
}

async fn external_request_impl_with_client(
    input: ApiRequestInput,
    target_url: url::Url,
    client: &reqwest::Client,
) -> Result<ApiRequestResult, AppError> {
    let method = input.method.as_deref().unwrap_or("GET");
    let display_url = target_url.as_str().to_string();

    fn build_request(
        client: &reqwest::Client,
        method: &str,
        target_url: url::Url,
        headers: &Option<HashMap<String, String>>,
        body: &Option<String>,
    ) -> reqwest::RequestBuilder {
        let mut req = client.request(method.parse().unwrap_or(reqwest::Method::GET), target_url);
        if let Some(ref headers) = headers {
            for (key, value) in headers {
                req = req.header(key.as_str(), value.as_str());
            }
        }
        if let Some(ref body) = body {
            req = req.body(body.clone());
        }
        req
    }

    // A credentialed request must be sent exactly once. In particular, never
    // bypass a configured system proxy after a connect failure: doing so both
    // violates the user's network policy and can replay API keys/request bodies
    // to a second network path.
    let result = build_request(client, method, target_url, &input.headers, &input.body)
        .send()
        .await;

    match result {
        Ok(res) => {
            let status = res.status().as_u16();
            let status_text = res.status().canonical_reason().unwrap_or("").to_string();
            let headers: HashMap<String, String> = res
                .headers()
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
                .collect();
            let body = res.text().await.unwrap_or_default();
            Ok(ApiRequestResult {
                ok: (200..300).contains(&status),
                status,
                status_text,
                headers,
                body,
            })
        }
        Err(e) => {
            let is_timeout = e.is_timeout();
            Ok(ApiRequestResult {
                ok: false,
                status: if is_timeout { 408 } else { 0 },
                status_text: if is_timeout {
                    "Request Timeout".to_string()
                } else {
                    "Network Error".to_string()
                },
                headers: HashMap::new(),
                body: if is_timeout {
                    format!("Request to {} timed out after 15s", display_url)
                } else {
                    e.to_string()
                },
            })
        }
    }
}

#[cfg(test)]
mod external_request_tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn credentialed_post_is_not_replayed_without_the_proxy() {
        let target = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/secret"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&target)
            .await;

        let proxy = TcpListener::bind(("127.0.0.1", 0)).expect("bind proxy");
        let proxy_addr = proxy.local_addr().expect("proxy address");
        let (captured_tx, captured_rx) = mpsc::channel();
        let proxy_thread = thread::spawn(move || {
            let (mut stream, _) = proxy.accept().expect("accept proxied request");
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("set read timeout");
            let mut buf = vec![0_u8; 8192];
            let count = stream.read(&mut buf).unwrap_or(0);
            captured_tx
                .send(String::from_utf8_lossy(&buf[..count]).to_string())
                .expect("send captured request");
            // Drop without a response to emulate a proxy connection failure.
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .proxy(reqwest::Proxy::all(format!("http://{}", proxy_addr)).expect("valid proxy URL"))
            .build()
            .expect("build proxied client");
        let target_url: url::Url = format!("{}/secret", target.uri())
            .parse()
            .expect("valid target URL");

        let result = external_request_impl_with_client(
            ApiRequestInput {
                path: target_url.to_string(),
                method: Some("POST".to_string()),
                headers: Some(HashMap::from([(
                    "Authorization".to_string(),
                    "Bearer sk-sensitive".to_string(),
                )])),
                body: Some("{\"prompt\":\"hello\"}".to_string()),
            },
            target_url,
            &client,
        )
        .await
        .expect("network errors are returned as a result envelope");

        assert!(!result.ok);
        assert_eq!(result.status, 0);
        let captured = captured_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("proxy should receive exactly one request");
        assert!(captured.contains("Bearer sk-sensitive"));
        proxy_thread.join().expect("proxy thread");
        target.verify().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn external_url_shape_requires_https() {
        let err = validate_external_url_shape("http://api.example.com/models").unwrap_err();
        assert!(err.to_string().contains("only allows https"));
    }

    #[test]
    fn external_url_shape_accepts_local_http_targets() {
        for raw in [
            "http://localhost:1234/v1/models",
            "http://service.localhost:1234/v1/models",
            "http://127.0.0.1:1234/v1/models",
            "http://0.0.0.0:1234/v1/models",
            "http://[::1]:1234/v1/models",
        ] {
            let url = validate_external_url_shape(raw).unwrap();
            assert_eq!(url.scheme(), "http");
        }
    }

    #[tokio::test]
    async fn external_url_allows_localhost_without_dns_rejection() {
        let url = validate_external_url("http://localhost:1234/v1/models")
            .await
            .unwrap();
        assert_eq!(url.host_str(), Some("localhost"));
    }

    #[test]
    fn external_url_shape_rejects_private_ip_literals() {
        for raw in [
            "https://10.0.0.1/status",
            "https://172.16.0.1/status",
            "https://192.168.1.1/status",
            "https://169.254.169.254/latest/meta-data",
            "https://[fc00::1]/status",
            "https://[fe80::1]/status",
        ] {
            let err = validate_external_url_shape(raw).unwrap_err();
            assert!(
                err.to_string().contains("private or local")
                    || err.to_string().contains("localhost"),
                "unexpected error for {raw}: {err}"
            );
        }
    }

    #[test]
    fn external_url_shape_accepts_public_https_hosts() {
        let url = validate_external_url_shape("https://api.example.com/v1/models").unwrap();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("api.example.com"));
    }
}
