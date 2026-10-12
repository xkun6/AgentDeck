// Node sidecar 进程管理：定位 node 与入口、拉起、ready 握手、关闭。
//
// 契约见 docs/design.md 第 3 节。由原 process/dashboard.rs 精简改写：沿用其中的
// Windows Job Object（KILL_ON_JOB_CLOSE）、CREATE_NO_WINDOW、stdout/stderr 按行
// 转发到 `log`、taskkill 兜底；Unix 用独立进程组。
//
// 本模块不依赖 Tauri，便于在 tests/ 中直接驱动；状态管理与事件推送在
// `crate::supervisor`。

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// 等待 ready 行的超时。
pub const READY_TIMEOUT: Duration = Duration::from_secs(20);
/// 关闭 stdin 后等待 sidecar 自行退出的时长，超时强杀。
pub const GRACEFUL_EXIT_TIMEOUT: Duration = Duration::from_secs(3);
/// 强杀后等待进程消失的时长。
const FORCE_EXIT_TIMEOUT: Duration = Duration::from_secs(2);

/// 覆盖 node 可执行文件的环境变量。
pub const NODE_ENV: &str = "AGENTDECK_NODE";
/// 覆盖 sidecar 入口的环境变量。
pub const ENTRY_ENV: &str = "AGENTDECK_SIDECAR_ENTRY";

// ---------------------------------------------------------------------------
// ready 行与 wsUrl
// ---------------------------------------------------------------------------

/// sidecar 在 stdout 输出的唯一一行：
/// `{"type":"ready","port":<number>,"version":"<string>","pid":<number>}`
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ReadyLine {
    #[serde(rename = "type")]
    pub kind: String,
    pub port: u16,
    pub version: String,
    pub pid: u32,
}

/// 解析 ready 行；非 JSON、缺字段、`type` 不是 `ready` 或端口为 0 都视为无效。
pub fn parse_ready_line(line: &str) -> Result<ReadyLine, String> {
    let ready: ReadyLine = serde_json::from_str(line.trim())
        .map_err(|e| format!("ready 行不是合法 JSON 或缺少字段: {e}"))?;
    if ready.kind != "ready" {
        return Err(format!(
            "ready 行 type 应为 \"ready\"，实际为 {:?}",
            ready.kind
        ));
    }
    if ready.port == 0 {
        return Err("ready 行端口为 0".to_string());
    }
    Ok(ready)
}

/// 前端连接 sidecar 的 WebSocket 地址（不含 token）。
pub fn ws_url(port: u16) -> String {
    format!("ws://127.0.0.1:{port}/rpc")
}

/// 32 字节随机数的 hex 编码，作为 `AGENTDECK_TOKEN`。
pub fn generate_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("生成 sidecar token 失败: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

// ---------------------------------------------------------------------------
// 状态载荷（契约 3.4）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SidecarStatus {
    Starting,
    Ready,
    Failed,
    Stopped,
}

/// `get_sidecar_config` / `restart_sidecar` 的返回值与 `sidecar-status` 事件载荷。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarStatusPayload {
    pub ws_url: String,
    pub token: String,
    pub version: Option<String>,
    pub status: SidecarStatus,
    pub error: Option<String>,
}

impl SidecarStatusPayload {
    pub fn stopped() -> Self {
        Self {
            ws_url: String::new(),
            token: String::new(),
            version: None,
            status: SidecarStatus::Stopped,
            error: None,
        }
    }
}

// ---------------------------------------------------------------------------
// node 与入口定位（契约 3.1）
// ---------------------------------------------------------------------------

fn node_file_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// 主程序 exe 所在目录（打包态 node 与它同目录）。
pub fn current_exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
}

/// 开发态仓库根（仅 debug 构建可用）。
pub fn dev_repo_root() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")))
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}

/// 按顺序定位 node：`AGENTDECK_NODE` → exe 同目录 → `path_entries` 中的 node。
/// 环境变量指向不存在的文件时记录警告并继续后续候选。
pub fn resolve_node(exe_dir: Option<&Path>, path_entries: &[PathBuf]) -> Option<PathBuf> {
    if let Some(path) = env_path(NODE_ENV) {
        if path.is_file() {
            return Some(path);
        }
        log::warn!(
            "{NODE_ENV}={} 不存在，继续按默认顺序查找 node",
            path.display()
        );
    }
    if let Some(dir) = exe_dir {
        let bundled = dir.join(node_file_name());
        if bundled.is_file() {
            return Some(bundled);
        }
    }
    crate::environment::find_in_entries(node_file_name(), path_entries)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    /// `.mjs` / `.js`：`node <entry>`
    Js,
    /// `.ts`：`node --import tsx <entry>`
    Ts,
}

/// 解析出的 sidecar 入口：`script` 作为 node 参数，`cwd` 为子进程工作目录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidecarEntry {
    pub script: PathBuf,
    pub kind: EntryKind,
    pub cwd: PathBuf,
}

impl SidecarEntry {
    /// 传给 node 的参数。
    pub fn node_args(&self) -> Vec<OsString> {
        let mut args = Vec::new();
        if self.kind == EntryKind::Ts {
            args.push(OsString::from("--import"));
            args.push(OsString::from("tsx"));
        }
        args.push(self.script.clone().into_os_string());
        args
    }
}

fn entry_kind(path: &Path) -> EntryKind {
    let is_ts = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("ts"));
    if is_ts {
        EntryKind::Ts
    } else {
        EntryKind::Js
    }
}

/// 按顺序定位 sidecar 入口：`AGENTDECK_SIDECAR_ENTRY` → 开发态
/// `<dev_root>/packages/sidecar/src/main.ts`（cwd = `<dev_root>/packages/sidecar`）
/// → `<resource_dir>/sidecar/bundle.mjs`。
///
/// 开发态排在资源 bundle 之前：tauri-build 每次编译都会把 `bundle.resources` 复制到
/// `target/<profile>/`，而 Windows 上 `resource_dir` 就是 exe 目录，否则 `tauri dev`
/// 会误用旧的 `target/debug/sidecar/bundle.mjs`。`dev_root` 只在 debug 构建且源码存在时命中，
/// release 构建恒走资源 bundle。
pub fn resolve_entry(resource_dir: Option<&Path>, dev_root: Option<&Path>) -> Option<SidecarEntry> {
    if let Some(path) = env_path(ENTRY_ENV) {
        if path.is_file() {
            let cwd = path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from("."));
            return Some(SidecarEntry {
                kind: entry_kind(&path),
                script: path,
                cwd,
            });
        }
        log::warn!(
            "{ENTRY_ENV}={} 不存在，继续按默认顺序查找 sidecar 入口",
            path.display()
        );
    }
    if let Some(root) = dev_root {
        let package_dir = root.join("packages").join("sidecar");
        if package_dir.join("src").join("main.ts").is_file() {
            return Some(SidecarEntry {
                script: PathBuf::from("src").join("main.ts"),
                kind: EntryKind::Ts,
                cwd: package_dir,
            });
        }
    }
    if let Some(dir) = resource_dir {
        let sidecar_dir = dir.join("sidecar");
        let bundle = sidecar_dir.join("bundle.mjs");
        if bundle.is_file() {
            return Some(SidecarEntry {
                script: bundle,
                kind: EntryKind::Js,
                cwd: sidecar_dir,
            });
        }
    }
    None
}

// ---------------------------------------------------------------------------
// 拉起与关闭（契约 3.2 / 3.3）
// ---------------------------------------------------------------------------

/// 拉起 sidecar 所需的全部输入。
#[derive(Debug, Clone)]
pub struct SpawnOptions {
    pub node: PathBuf,
    pub entry: SidecarEntry,
    pub token: String,
    pub data_dir: PathBuf,
    pub log_dir: PathBuf,
    /// 用 `path_resolver` 解析出的 PATH。
    pub path_env: OsString,
}

/// Windows Job Object 句柄；非 Windows 为零大小占位。
pub struct JobHandle {
    #[cfg(windows)]
    raw: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
unsafe impl Send for JobHandle {}

impl JobHandle {
    /// 结束 Job 内全部进程；成功返回 true。
    #[cfg(windows)]
    fn terminate(&self) -> bool {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        !self.raw.is_null() && unsafe { TerminateJobObject(self.raw, 1) } != 0
    }
}

impl Drop for JobHandle {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            if !self.raw.is_null() {
                let _ = windows_sys::Win32::Foundation::CloseHandle(self.raw);
                self.raw = std::ptr::null_mut();
            }
        }
    }
}

#[cfg(windows)]
fn create_kill_on_close_job(child: &Child) -> Result<JobHandle, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(std::io::Error::last_os_error().to_string());
    }

    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let set_ok = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of_val(&info) as u32,
        )
    };
    if set_ok == 0 {
        let err = std::io::Error::last_os_error().to_string();
        unsafe { CloseHandle(job) };
        return Err(err);
    }

    let process = child.as_raw_handle() as HANDLE;
    let assign_ok = unsafe { AssignProcessToJobObject(job, process) };
    if assign_ok == 0 {
        let err = std::io::Error::last_os_error().to_string();
        unsafe { CloseHandle(job) };
        return Err(err);
    }

    Ok(JobHandle { raw: job })
}

#[cfg(windows)]
fn force_kill_process_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    if pid == 0 {
        return;
    }
    let pid_arg = pid.to_string();
    let _ = Command::new("taskkill")
        .args(["/PID", &pid_arg, "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

#[cfg(unix)]
fn signal_process_group(pid: u32, signal: libc::c_int) {
    if pid == 0 {
        return;
    }
    let pgid = -(pid as libc::pid_t);
    let rc = unsafe { libc::kill(pgid, signal) };
    if rc != 0 {
        log::debug!(
            "向 sidecar 进程组 {} 发送信号 {} 失败: {}",
            pid,
            signal,
            std::io::Error::last_os_error()
        );
    }
}

/// 运行中的 sidecar 进程。Drop 时按契约关闭。
pub struct SidecarHandle {
    child: Child,
    stdin: Option<ChildStdin>,
    job: Option<JobHandle>,
    /// ready 行报告的端口。
    pub port: u16,
    /// ready 行报告的 sidecar 版本。
    pub version: String,
    /// ready 行报告的 pid。
    pub reported_pid: u32,
    stopped: bool,
}

impl SidecarHandle {
    /// 子进程 pid（node 进程）。
    pub fn child_pid(&self) -> u32 {
        self.child.id()
    }

    /// 前端连接地址 `ws://127.0.0.1:<port>/rpc`。
    pub fn ws_url(&self) -> String {
        ws_url(self.port)
    }

    /// 进程是否已退出（不阻塞）。
    pub fn has_exited(&mut self) -> bool {
        self.stopped || matches!(self.child.try_wait(), Ok(Some(_)) | Err(_))
    }

    /// 按契约关闭：关 stdin → 等待 3 秒 → 强杀进程树。返回进程是否已退出。
    pub fn stop(&mut self) -> bool {
        if self.stopped {
            return true;
        }
        // 1. 关闭 stdin，sidecar 监听到 end 后自行清理退出。
        drop(self.stdin.take());
        // 2. 等待 3 秒。
        let exited = wait_for_child_exit(&mut self.child, GRACEFUL_EXIT_TIMEOUT);
        // 3. 仍未退出则强杀整棵进程树。
        let exited = exited || {
            log::warn!(
                "sidecar (pid {}) 关闭 stdin 后 {} 秒未退出，强制结束",
                self.child.id(),
                GRACEFUL_EXIT_TIMEOUT.as_secs()
            );
            self.force_kill();
            wait_for_child_exit(&mut self.child, FORCE_EXIT_TIMEOUT)
        };
        // 即使进程已自行退出，也结束 Job/进程组里可能残留的孙进程。
        self.kill_leftover_tree();
        self.job = None;
        self.stopped = exited;
        exited
    }

    fn force_kill(&mut self) {
        let pid = self.child.id();
        #[cfg(windows)]
        {
            let terminated = self.job.as_ref().is_some_and(JobHandle::terminate);
            if !terminated {
                force_kill_process_tree(pid);
            }
        }
        #[cfg(unix)]
        signal_process_group(pid, libc::SIGKILL);
        let _ = self.child.kill();
    }

    fn kill_leftover_tree(&mut self) {
        #[cfg(windows)]
        if let Some(job) = self.job.as_ref() {
            job.terminate();
        }
        #[cfg(unix)]
        signal_process_group(self.child.id(), libc::SIGKILL);
    }
}

impl Drop for SidecarHandle {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn wait_for_child_exit(child: &mut Child, timeout: Duration) -> bool {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return true,
            Ok(None) if start.elapsed() >= timeout => return false,
            Ok(None) => thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn spawn_log_reader<R>(stream: &'static str, reader: R, ready_tx: Option<mpsc::Sender<ReadyLine>>)
where
    R: Read + Send + 'static,
{
    let _ = thread::Builder::new()
        .name(format!("agentdeck-sidecar-{stream}"))
        .spawn(move || {
            let mut ready_tx = ready_tx;
            for line in BufReader::new(reader).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                if let Some(tx) = ready_tx.as_ref() {
                    match parse_ready_line(&line) {
                        Ok(ready) => {
                            let _ = tx.send(ready);
                            ready_tx = None;
                            continue;
                        }
                        Err(err) => {
                            log::warn!("[sidecar {stream}] 非 ready 行（{err}）: {line}");
                            continue;
                        }
                    }
                }
                match stream {
                    "stdout" => log::warn!("[sidecar stdout] {line}"),
                    _ => log::info!("[sidecar {stream}] {line}"),
                }
            }
        });
}

/// 拉起 sidecar 并阻塞等待 ready 行（最长 [`READY_TIMEOUT`]）。
pub fn spawn_sidecar(options: &SpawnOptions) -> Result<SidecarHandle, String> {
    spawn_sidecar_with_timeout(options, READY_TIMEOUT)
}

/// 同 [`spawn_sidecar`]，可指定 ready 超时（测试用）。
pub fn spawn_sidecar_with_timeout(
    options: &SpawnOptions,
    ready_timeout: Duration,
) -> Result<SidecarHandle, String> {
    let _ = std::fs::create_dir_all(&options.data_dir);
    let _ = std::fs::create_dir_all(&options.log_dir);

    let mut cmd = Command::new(&options.node);
    cmd.args(options.entry.node_args())
        .current_dir(&options.entry.cwd)
        .env("AGENTDECK_TOKEN", &options.token)
        .env("AGENTDECK_PORT", "0")
        .env("AGENTDECK_DATA_DIR", &options.data_dir)
        .env("AGENTDECK_LOG_DIR", &options.log_dir)
        .env("AGENTDECK_PARENT_PID", std::process::id().to_string())
        .env("PATH", &options.path_env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // 独立进程组，关闭时可连同 Agent 子进程一起结束。
        cmd.process_group(0);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }

    log::info!(
        "拉起 sidecar: {} {:?} (cwd={})",
        options.node.display(),
        options.entry.node_args(),
        options.entry.cwd.display()
    );
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动 sidecar（node={}）: {e}", options.node.display()))?;
    crate::path_resolver::mark_applied_to_runtime(&options.path_env);

    #[cfg(windows)]
    let job = match create_kill_on_close_job(&child) {
        Ok(job) => Some(job),
        Err(err) => {
            log::warn!("sidecar 加入 Windows Job Object 失败: {err}");
            None
        }
    };
    #[cfg(not(windows))]
    let job: Option<JobHandle> = None;

    let stdin = child.stdin.take();
    let (ready_tx, ready_rx) = mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        spawn_log_reader("stdout", stdout, Some(ready_tx));
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_log_reader("stderr", stderr, None);
    }

    let mut handle = SidecarHandle {
        child,
        stdin,
        job,
        port: 0,
        version: String::new(),
        reported_pid: 0,
        stopped: false,
    };

    let deadline = Instant::now() + ready_timeout;
    loop {
        match ready_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(ready) => {
                log::info!(
                    "sidecar 就绪: port={} version={} pid={}",
                    ready.port,
                    ready.version,
                    ready.pid
                );
                handle.port = ready.port;
                handle.version = ready.version;
                handle.reported_pid = ready.pid;
                return Ok(handle);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // stdout 已关闭且未出现 ready 行：等进程退出后报错。
                let _ = wait_for_child_exit(&mut handle.child, Duration::from_secs(1));
            }
        }
        if let Ok(Some(status)) = handle.child.try_wait() {
            handle.stopped = true;
            return Err(format!("sidecar 在输出 ready 行之前退出（{status}）"));
        }
        if Instant::now() >= deadline {
            handle.stop();
            return Err(format!(
                "sidecar 启动超时：{} 秒内未输出 ready 行",
                ready_timeout.as_secs()
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use serial_test::serial;
    use tempfile::TempDir;

    #[test]
    fn parse_ready_line_accepts_contract_shape() {
        let ready =
            parse_ready_line(r#"{"type":"ready","port":43123,"version":"0.1.0","pid":4242}"#)
                .unwrap();
        assert_eq!(
            ready,
            ReadyLine {
                kind: "ready".to_string(),
                port: 43123,
                version: "0.1.0".to_string(),
                pid: 4242,
            }
        );
        // 前后空白与额外字段不影响解析。
        assert!(parse_ready_line(
            "  {\"type\":\"ready\",\"port\":1,\"version\":\"x\",\"pid\":2,\"extra\":true}\r\n"
        )
        .is_ok());
    }

    #[test]
    fn parse_ready_line_rejects_non_json() {
        assert!(parse_ready_line("listening on 127.0.0.1:1234").is_err());
        assert!(parse_ready_line("").is_err());
    }

    #[test]
    fn parse_ready_line_rejects_missing_or_invalid_fields() {
        assert!(parse_ready_line(r#"{"type":"ready","version":"0.1.0","pid":1}"#).is_err());
        assert!(parse_ready_line(r#"{"type":"ready","port":1,"pid":1}"#).is_err());
        assert!(parse_ready_line(r#"{"type":"ready","port":1,"version":"v"}"#).is_err());
        assert!(parse_ready_line(r#"{"port":1,"version":"v","pid":1}"#).is_err());
        assert!(parse_ready_line(r#"{"type":"log","port":1,"version":"v","pid":1}"#).is_err());
        assert!(parse_ready_line(r#"{"type":"ready","port":0,"version":"v","pid":1}"#).is_err());
        assert!(parse_ready_line(r#"{"type":"ready","port":"80","version":"v","pid":1}"#).is_err());
    }

    #[test]
    fn ws_url_uses_loopback_rpc_path() {
        assert_eq!(ws_url(5173), "ws://127.0.0.1:5173/rpc");
    }

    #[test]
    fn token_is_64_hex_chars_and_random() {
        let a = generate_token().unwrap();
        let b = generate_token().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a, b);
    }

    #[test]
    fn status_payload_serializes_camel_case() {
        let payload = SidecarStatusPayload {
            ws_url: ws_url(1),
            token: "t".to_string(),
            version: Some("0.1.0".to_string()),
            status: SidecarStatus::Ready,
            error: None,
        };
        assert_eq!(
            serde_json::to_value(&payload).unwrap(),
            serde_json::json!({
                "wsUrl": "ws://127.0.0.1:1/rpc",
                "token": "t",
                "version": "0.1.0",
                "status": "ready",
                "error": null
            })
        );
        assert_eq!(
            serde_json::to_value(SidecarStatusPayload::stopped()).unwrap()["status"],
            "stopped"
        );
    }

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"").unwrap();
    }

    #[test]
    #[serial]
    fn resolve_node_prefers_env_then_exe_dir_then_path() {
        let tmp = TempDir::new().unwrap();
        let env_node = tmp.path().join("env").join(node_file_name());
        let exe_dir = tmp.path().join("exe");
        let path_dir = tmp.path().join("path");
        touch(&env_node);
        touch(&exe_dir.join(node_file_name()));
        touch(&path_dir.join(node_file_name()));
        let entries = vec![path_dir.clone()];

        std::env::set_var(NODE_ENV, &env_node);
        assert_eq!(
            resolve_node(Some(&exe_dir), &entries),
            Some(env_node.clone())
        );

        // 环境变量指向不存在的文件 → 继续后续候选。
        std::env::set_var(NODE_ENV, tmp.path().join("missing-node"));
        assert_eq!(
            resolve_node(Some(&exe_dir), &entries),
            Some(exe_dir.join(node_file_name()))
        );

        std::env::remove_var(NODE_ENV);
        assert_eq!(
            resolve_node(Some(&exe_dir), &entries),
            Some(exe_dir.join(node_file_name()))
        );
        let from_path = resolve_node(None, &entries).expect("node on PATH");
        assert_eq!(from_path.parent(), Some(path_dir.as_path()));
        assert_eq!(resolve_node(None, &[]), None);
    }

    #[test]
    #[serial]
    fn resolve_entry_prefers_env_then_dev_then_resource() {
        let tmp = TempDir::new().unwrap();
        let resource_dir = tmp.path().join("resources");
        let dev_root = tmp.path().join("repo");
        touch(&resource_dir.join("sidecar").join("bundle.mjs"));
        touch(&dev_root.join("packages/sidecar/src/main.ts"));
        let env_js = tmp.path().join("custom").join("entry.mjs");
        let env_ts = tmp.path().join("custom").join("entry.ts");
        touch(&env_js);
        touch(&env_ts);

        std::env::set_var(ENTRY_ENV, &env_js);
        let entry = resolve_entry(Some(&resource_dir), Some(&dev_root)).unwrap();
        assert_eq!(entry.kind, EntryKind::Js);
        assert_eq!(entry.script, env_js);
        assert_eq!(entry.cwd, tmp.path().join("custom"));
        assert_eq!(entry.node_args(), vec![OsString::from(&env_js)]);

        std::env::set_var(ENTRY_ENV, &env_ts);
        let entry = resolve_entry(Some(&resource_dir), Some(&dev_root)).unwrap();
        assert_eq!(entry.kind, EntryKind::Ts);
        assert_eq!(
            entry.node_args(),
            vec![
                OsString::from("--import"),
                OsString::from("tsx"),
                OsString::from(&env_ts)
            ]
        );

        // 指向不存在的文件 → 继续后续候选。
        std::env::set_var(ENTRY_ENV, tmp.path().join("missing.mjs"));
        let entry = resolve_entry(Some(&resource_dir), None).unwrap();
        assert_eq!(
            entry.script,
            resource_dir.join("sidecar").join("bundle.mjs")
        );
        std::env::remove_var(ENTRY_ENV);

        // 打包态（release，无 dev_root）走资源 bundle。
        let entry = resolve_entry(Some(&resource_dir), None).unwrap();
        assert_eq!(entry.kind, EntryKind::Js);
        assert_eq!(entry.cwd, resource_dir.join("sidecar"));
        assert_eq!(
            entry.node_args(),
            vec![resource_dir
                .join("sidecar")
                .join("bundle.mjs")
                .into_os_string()]
        );

        // 开发态源码优先于 target 目录里由 tauri-build 复制来的 bundle。
        let entry = resolve_entry(Some(&resource_dir), Some(&dev_root)).unwrap();
        assert_eq!(entry.kind, EntryKind::Ts);
        assert_eq!(entry.cwd, dev_root.join("packages").join("sidecar"));

        // dev_root 下没有源码（如 debug 安装包拷到别的机器）→ 回退资源 bundle。
        let entry = resolve_entry(Some(&resource_dir), Some(tmp.path())).unwrap();
        assert_eq!(entry.kind, EntryKind::Js);

        let entry = resolve_entry(None, Some(&dev_root)).unwrap();
        assert_eq!(entry.kind, EntryKind::Ts);
        assert_eq!(entry.cwd, dev_root.join("packages").join("sidecar"));
        assert_eq!(
            entry.node_args(),
            vec![
                OsString::from("--import"),
                OsString::from("tsx"),
                PathBuf::from("src").join("main.ts").into_os_string()
            ]
        );

        assert_eq!(resolve_entry(None, Some(tmp.path())), None);
        assert_eq!(resolve_entry(None, None), None);
    }
}
