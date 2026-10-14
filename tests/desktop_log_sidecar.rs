//! desktop.log 与 sidecar 的端到端集成测试（docs/design.md 3.6）。
//!
//! 用假 sidecar：ready 后向 stderr 输出若干行（含自己的 AGENTDECK_TOKEN），然后以退出码 9 退出，
//! 验证 desktop.log 里有全部 stderr 行、退出码、且 token 已脱敏。PATH 上找不到 node 时跳过。

use std::path::PathBuf;
use std::time::{Duration, Instant};

use agentdeck_core::desktop_log;
use agentdeck_core::process::sidecar::{
    self, resolve_entry, resolve_node, spawn_sidecar, SpawnOptions,
};
use tempfile::TempDir;

const EXITING_SIDECAR: &str = r#"
import http from "node:http";
const server = http.createServer((_req, res) => res.end("ok"));
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  process.stdout.write(JSON.stringify({ type: "ready", port, version: "0", pid: process.pid }) + "\n");
  process.stderr.write("env AGENTDECK_TOKEN=" + process.env.AGENTDECK_TOKEN + "\n");
  process.stderr.write("raw token " + process.env.AGENTDECK_TOKEN + " end\n");
  process.stderr.write("interop Bearer adi_0123456789abcdef0123456789abcdef\n");
  for (let i = 0; i < 1000; i++) process.stderr.write("stderr-line-" + i + "\n");
  setTimeout(() => process.exit(9), 300);
});
"#;

#[test]
#[serial_test::serial]
fn desktop_log_captures_sidecar_stderr_exit_code_and_redacts_tokens() {
    let node = {
        let entries: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect())
            .unwrap_or_default();
        match resolve_node(None, &entries) {
            Some(node) => node,
            None => {
                eprintln!("PATH 上找不到 node，跳过");
                return;
            }
        }
    };

    desktop_log::init();
    let tmp = TempDir::new().unwrap();
    let log_dir = tmp.path().join("logs");
    desktop_log::attach(&log_dir);

    let script = tmp.path().join("exiting-sidecar.mjs");
    std::fs::write(&script, EXITING_SIDECAR).unwrap();
    std::env::set_var(sidecar::ENTRY_ENV, &script);
    let entry = resolve_entry(None, None).expect("entry");
    std::env::remove_var(sidecar::ENTRY_ENV);

    let token = sidecar::generate_token().unwrap();
    let mut handle = spawn_sidecar(&SpawnOptions {
        node,
        entry,
        token: token.clone(),
        data_dir: tmp.path().join("data"),
        log_dir: log_dir.clone(),
        path_env: std::env::var_os("PATH").unwrap_or_default(),
    })
    .expect("sidecar ready");

    // 模拟 supervisor 的 5 秒轮询：等进程自行退出
    let deadline = Instant::now() + Duration::from_secs(15);
    while !handle.has_exited() {
        assert!(Instant::now() < deadline, "sidecar 未按预期退出");
        std::thread::sleep(Duration::from_millis(50));
    }
    // 读线程在进程退出后才读完剩余管道数据，稍等再 flush
    std::thread::sleep(Duration::from_millis(500));
    desktop_log::flush(Duration::from_secs(5));

    let text = std::fs::read_to_string(log_dir.join(desktop_log::LOG_FILE_NAME)).unwrap();
    assert!(text.contains("sidecar.stderr: stderr-line-0\n"), "{text}");
    assert!(text.contains("sidecar.stderr: stderr-line-999\n"));
    assert_eq!(text.matches("sidecar.stderr: stderr-line-").count(), 1000);
    assert!(
        text.contains("意外退出：退出码 9 (0x9)"),
        "应记录退出码: {text}"
    );
    assert!(text.contains("AGENTDECK_TOKEN=***"));
    assert!(text.contains("raw token *** end"));
    assert!(text.contains("Bearer adi_***"));
    assert!(!text.contains(&token), "desktop.log 不应含 token 原文");
    assert!(!text.contains("0123456789abcdef0123456789abcdef"));
    // Rust 侧自己的日志也进了文件
    assert!(text.contains("sidecar 就绪"), "{text}");
}
