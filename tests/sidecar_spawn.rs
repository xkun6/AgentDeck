//! sidecar 拉起 / ready 握手 / 关闭的集成测试（docs/design.md 第 3 节）。
//!
//! 用 TempDir 里的假 sidecar 脚本代替真实 packages/sidecar，经
//! `AGENTDECK_SIDECAR_ENTRY` 注入。PATH 上找不到 node 时打印原因后跳过。

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use agentdeck_core::process::sidecar::{
    self, resolve_entry, resolve_node, spawn_sidecar, spawn_sidecar_with_timeout, SpawnOptions,
};
use pretty_assertions::assert_eq;
use tempfile::TempDir;

/// 正常的假 sidecar：校验 token，监听 127.0.0.1:0，输出 ready 行，stdin end 后退出。
const FAKE_SIDECAR: &str = r#"
import http from "node:http";

const token = process.env.AGENTDECK_TOKEN;
if (!token) {
  process.stderr.write("missing AGENTDECK_TOKEN\n");
  process.exit(3);
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    const body = JSON.stringify({
      ok: true,
      version: "9.9.9-test",
      tokenLength: token.length,
      port: process.env.AGENTDECK_PORT,
      dataDir: process.env.AGENTDECK_DATA_DIR,
      logDir: process.env.AGENTDECK_LOG_DIR,
      parentPid: process.env.AGENTDECK_PARENT_PID,
      hasPath: Boolean(process.env.PATH || process.env.Path),
    });
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(Number(process.env.AGENTDECK_PORT ?? 0), "127.0.0.1", () => {
  const { port } = server.address();
  process.stderr.write("fake sidecar listening\n");
  process.stdout.write(JSON.stringify({ type: "ready", port, version: "9.9.9-test", pid: process.pid }) + "\n");
});

process.stdin.on("end", () => {
  server.close();
  process.exit(0);
});
process.stdin.resume();
"#;

/// 输出 ready 后忽略 stdin end、永不退出的 sidecar，用于验证强杀路径。
const STUBBORN_SIDECAR: &str = r#"
import http from "node:http";
const server = http.createServer((_req, res) => res.end("ok"));
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  process.stdout.write(JSON.stringify({ type: "ready", port, version: "0", pid: process.pid }) + "\n");
});
process.stdin.on("end", () => {});
process.stdin.resume();
setInterval(() => {}, 1000);
"#;

/// 不输出 ready 就退出的 sidecar。
const CRASHING_SIDECAR: &str = r#"
process.stderr.write("boom\n");
process.exit(7);
"#;

struct EntryEnvGuard;

impl EntryEnvGuard {
    fn set(path: &Path) -> Self {
        std::env::set_var(sidecar::ENTRY_ENV, path);
        Self
    }
}

impl Drop for EntryEnvGuard {
    fn drop(&mut self) {
        std::env::remove_var(sidecar::ENTRY_ENV);
    }
}

fn path_entries() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default()
}

fn find_node() -> Option<PathBuf> {
    let node = resolve_node(None, &path_entries());
    if node.is_none() {
        eprintln!("PATH 上找不到 node，跳过 sidecar 集成测试");
    }
    node
}

/// 写入脚本并经 `AGENTDECK_SIDECAR_ENTRY` 解析出拉起参数。
fn options_for(tmp: &TempDir, node: PathBuf, script: &str) -> (SpawnOptions, EntryEnvGuard) {
    let script_path = tmp.path().join("fake-sidecar.mjs");
    std::fs::write(&script_path, script).expect("write fake sidecar");
    let guard = EntryEnvGuard::set(&script_path);
    let entry = resolve_entry(None, None).expect("entry from AGENTDECK_SIDECAR_ENTRY");
    assert_eq!(entry.script, script_path);
    let options = SpawnOptions {
        node,
        entry,
        token: sidecar::generate_token().expect("token"),
        data_dir: tmp.path().join("data"),
        log_dir: tmp.path().join("data").join("logs"),
        path_env: std::env::var_os("PATH").unwrap_or_default(),
    };
    (options, guard)
}

fn http_get(port: u16, path: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect sidecar");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("read timeout");
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )
    .expect("write request");
    let mut response = String::new();
    stream.read_to_string(&mut response).expect("read response");
    response
}

#[test]
#[serial_test::serial]
fn spawns_fake_sidecar_reads_ready_line_and_stops_via_stdin() {
    let Some(node) = find_node() else {
        return;
    };
    let tmp = TempDir::new().expect("tempdir");
    let (options, _guard) = options_for(&tmp, node, FAKE_SIDECAR);

    let mut handle = spawn_sidecar(&options).expect("sidecar should become ready");
    assert!(handle.port > 0);
    assert_eq!(handle.version, "9.9.9-test");
    assert_eq!(handle.reported_pid, handle.child_pid());
    assert_eq!(
        handle.ws_url(),
        format!("ws://127.0.0.1:{}/rpc", handle.port)
    );
    assert!(!handle.has_exited());

    let response = http_get(handle.port, "/health");
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let body = response.split("\r\n\r\n").nth(1).expect("body");
    let health: serde_json::Value = serde_json::from_str(body).expect("health json");
    assert_eq!(health["ok"], true);
    assert_eq!(health["tokenLength"], 64);
    assert_eq!(health["port"], "0");
    assert_eq!(health["parentPid"], std::process::id().to_string());
    assert_eq!(
        health["dataDir"].as_str().map(PathBuf::from),
        Some(options.data_dir.clone())
    );
    assert_eq!(
        health["logDir"].as_str().map(PathBuf::from),
        Some(options.log_dir.clone())
    );
    assert_eq!(health["hasPath"], true);

    let started = Instant::now();
    assert!(handle.stop(), "sidecar should exit after stdin closes");
    assert!(
        started.elapsed() < sidecar::GRACEFUL_EXIT_TIMEOUT,
        "graceful exit should not need the force-kill path"
    );
    assert!(handle.has_exited());
    assert!(
        TcpStream::connect(("127.0.0.1", handle.port)).is_err(),
        "listener should be gone after stop"
    );
}

#[test]
#[serial_test::serial]
fn force_kills_sidecar_that_ignores_stdin_close() {
    let Some(node) = find_node() else {
        return;
    };
    let tmp = TempDir::new().expect("tempdir");
    let (options, _guard) = options_for(&tmp, node, STUBBORN_SIDECAR);

    let mut handle = spawn_sidecar(&options).expect("sidecar should become ready");
    let started = Instant::now();
    assert!(handle.stop(), "stubborn sidecar must be force-killed");
    assert!(started.elapsed() >= sidecar::GRACEFUL_EXIT_TIMEOUT);
    assert!(handle.has_exited());
}

#[test]
#[serial_test::serial]
fn reports_error_when_sidecar_exits_before_ready() {
    let Some(node) = find_node() else {
        return;
    };
    let tmp = TempDir::new().expect("tempdir");
    let (options, _guard) = options_for(&tmp, node, CRASHING_SIDECAR);

    let err = match spawn_sidecar_with_timeout(&options, Duration::from_secs(10)) {
        Ok(_) => panic!("crashing sidecar must not be reported ready"),
        Err(err) => err,
    };
    assert!(err.contains("ready"), "{err}");
}
