// HTTP-boundary tests for fetch_session_token.
//
// The dashboard's index HTML embeds the session token via
// `__HERMES_SESSION_TOKEN__="<token>"`. Verify the regex extraction and
// edge cases (missing token, HTTP errors).

use agentdeck_core::process::dashboard::fetch_session_token;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const HTML_WITH_TOKEN: &str = r#"<!DOCTYPE html>
<html>
  <head>
    <script>
      window.__HERMES_SESSION_TOKEN__="tok_abc_123";
    </script>
  </head>
  <body>ok</body>
</html>"#;

const HTML_WITHOUT_TOKEN: &str = r#"<!DOCTYPE html>
<html><body>nothing here</body></html>"#;

#[tokio::test]
async fn extracts_token_from_html() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string(HTML_WITH_TOKEN)
                .insert_header("content-type", "text/html"),
        )
        .mount(&server)
        .await;

    let token = fetch_session_token(&server.uri()).await;
    assert_eq!(token, Some("tok_abc_123".to_string()));
}

#[tokio::test]
async fn returns_none_when_token_missing() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(200).set_body_string(HTML_WITHOUT_TOKEN))
        .mount(&server)
        .await;

    let token = fetch_session_token(&server.uri()).await;
    assert_eq!(token, None);
}

#[tokio::test]
async fn returns_none_on_404() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;

    let token = fetch_session_token(&server.uri()).await;
    assert_eq!(token, None);
}

#[tokio::test]
async fn returns_none_on_empty_body() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(200).set_body_string(""))
        .mount(&server)
        .await;

    let token = fetch_session_token(&server.uri()).await;
    assert_eq!(token, None);
}

#[tokio::test]
async fn picks_first_token_when_multiple_present() {
    // Defensive: ensure the regex doesn't span across multiple matches.
    let html = r#"<script>__HERMES_SESSION_TOKEN__="first";</script>
<script>__HERMES_SESSION_TOKEN__="second";</script>"#;
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(200).set_body_string(html))
        .mount(&server)
        .await;

    let token = fetch_session_token(&server.uri()).await;
    assert_eq!(token, Some("first".to_string()));
}
