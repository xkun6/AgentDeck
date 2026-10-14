//! Rust 外壳日志落盘（design.md 3.6）：`<data>/logs/desktop.log`。
//!
//! - `init` 在 `main` 最先调用：`env_logger` 的输出目标换成「异步队列 + stderr tee」，并安装 panic hook；
//! - `attach` 在 `setup` 里数据目录确定后调用，此前的日志留在队列里，之后补写；
//! - 写文件由独立线程完成，调用方（含 sidecar stdout/stderr 读线程）只做 `try_send`，绝不阻塞；
//! - 单文件超过 5 MB 时改名为 `desktop.log.1`（只保留一份）；
//! - 写入前统一脱敏 token（规则同 design.md 4.26）。

use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 日志文件名。
pub const LOG_FILE_NAME: &str = "desktop.log";
/// 超过该大小时轮转为 `desktop.log.1`。
pub const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
/// 写入队列容量（行数）。
pub const QUEUE_CAPACITY: usize = 16_384;
/// 单条日志（单行 / 单条记录）最大字节数，超出截断。
pub const MAX_LINE_BYTES: usize = 16 * 1024;
/// 写线程截断阈值的余量：读线程已按 MAX_LINE_BYTES 截断的行（加时间戳前缀、截断说明）不应再被二次截断。
const LINE_PREFIX_SLACK: usize = 1024;
/// attach 之前最多缓存的行数。
const EARLY_LINES_CAP: usize = 4_096;
/// 默认过滤：第三方 crate 只留 warn，本项目 info。`RUST_LOG` 可覆盖。
const DEFAULT_FILTER: &str = "warn,agentdeck=info,agentdeck_core=info";
const REDACTED: &str = "***";
/// 登记的 token 至少这么长才按原文替换，避免误伤。
const MIN_SECRET_LEN: usize = 8;
const MAX_SECRETS: usize = 16;

// ---------------------------------------------------------------------------
// 时间戳与行格式
// ---------------------------------------------------------------------------

/// `2026-10-14T11:21:34.589Z`（UTC，毫秒）。
pub fn iso8601_utc(now: SystemTime) -> String {
    let duration = now.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = duration.as_secs() as i64;
    let millis = duration.subsec_millis();
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Howard Hinnant 的 civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// `<时间> [LEVEL] target: 消息`
pub fn format_record(now: SystemTime, level: &str, target: &str, message: &str) -> String {
    format!("{} [{level:<5}] {target}: {message}", iso8601_utc(now))
}

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

fn secrets() -> &'static Mutex<VecDeque<String>> {
    static SECRETS: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();
    SECRETS.get_or_init(|| Mutex::new(VecDeque::new()))
}

/// 登记本进程生成的 sidecar token（原文脱敏）；保留最近 [`MAX_SECRETS`] 个。
pub fn register_secret(secret: &str) {
    if secret.len() < MIN_SECRET_LEN {
        return;
    }
    if let Ok(mut list) = secrets().lock() {
        if list.iter().any(|s| s == secret) {
            return;
        }
        if list.len() >= MAX_SECRETS {
            list.pop_front();
        }
        list.push_back(secret.to_string());
    }
}

fn is_lower_hex(byte: u8) -> bool {
    matches!(byte, b'0'..=b'9' | b'a'..=b'f')
}

/// `adi_[0-9a-f]{16,}` → `adi_***`
fn mask_interop_tokens(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find("adi_") {
        out.push_str(&rest[..index + 4]);
        let after = &rest[index + 4..];
        let hex = after.bytes().take_while(|b| is_lower_hex(*b)).count();
        if hex >= 16 {
            out.push_str(REDACTED);
        } else {
            out.push_str(&after[..hex]);
        }
        rest = &after[hex..];
    }
    out.push_str(rest);
    out
}

/// `AGENTDECK_TOKEN=xxx` / `AGENTDECK_TOKEN: "xxx"` / `"AGENTDECK_TOKEN":"xxx"` 的值 → `***`。
/// 关键字后必须紧跟（可带一个引号）`=` 或 `:`，避免误伤「缺少环境变量 AGENTDECK_TOKEN」之类的说明文字。
fn mask_token_assignment(text: &str) -> String {
    const KEY: &str = "AGENTDECK_TOKEN";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find(KEY) {
        let after_key = index + KEY.len();
        out.push_str(&rest[..after_key]);
        let tail = &rest[after_key..];
        let bytes = tail.as_bytes();
        let mut pos = 0;
        if matches!(bytes.first(), Some(b'"' | b'\'')) {
            pos += 1;
        }
        if matches!(bytes.get(pos), Some(b'=' | b':')) {
            pos += 1;
            while matches!(bytes.get(pos), Some(b' ' | b'"' | b'\'')) {
                pos += 1;
            }
            let value_len: usize = tail[pos..]
                .chars()
                .take_while(|c| !c.is_whitespace() && !"\"',;&}".contains(*c))
                .map(char::len_utf8)
                .sum();
            out.push_str(&tail[..pos]);
            if value_len > 0 {
                out.push_str(REDACTED);
            }
            rest = &tail[pos + value_len..];
        } else {
            rest = tail;
        }
    }
    out.push_str(rest);
    out
}

/// `token=<≥16 位 token 字符>`（WS 地址等）→ `token=***`
fn mask_query_token(text: &str) -> String {
    const KEY: &str = "token=";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find(KEY) {
        let after_key = index + KEY.len();
        out.push_str(&rest[..after_key]);
        let tail = &rest[after_key..];
        let run = tail
            .bytes()
            .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
            .count();
        if run >= 16 {
            out.push_str(REDACTED);
        } else {
            out.push_str(&tail[..run]);
        }
        rest = &tail[run..];
    }
    out.push_str(rest);
    out
}

/// 日志与诊断包共用的 token 脱敏。
pub fn redact(text: &str) -> String {
    let mut out = text.to_string();
    if let Ok(list) = secrets().lock() {
        for secret in list.iter() {
            out = out.replace(secret.as_str(), REDACTED);
        }
    }
    let out = mask_interop_tokens(&out);
    let out = mask_token_assignment(&out);
    mask_query_token(&out)
}

/// 超过 `max` 字节时截断（在字符边界），并注明原长。
pub fn truncate_line(line: &str, max: usize) -> String {
    if line.len() <= max {
        return line.to_string();
    }
    let mut end = max;
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…（已截断，原长 {} 字节）", &line[..end], line.len())
}

// ---------------------------------------------------------------------------
// 轮转文件
// ---------------------------------------------------------------------------

fn rotated_path(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".1");
    path.with_file_name(name)
}

/// 追加写 + 简单轮转（超限改名为 `.1`，只保留一份）。
pub struct RotatingFile {
    path: PathBuf,
    max_bytes: u64,
    file: File,
    size: u64,
}

impl RotatingFile {
    pub fn open(path: &Path, max_bytes: u64) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        if fs::metadata(path).is_ok_and(|m| m.len() > max_bytes) {
            let _ = fs::rename(path, rotated_path(path));
        }
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Self {
            path: path.to_path_buf(),
            max_bytes,
            file,
            size,
        })
    }

    /// 写一行（自动补换行）。写入前若会超限，先轮转。
    pub fn append_line(&mut self, line: &str) -> io::Result<()> {
        let mut data = String::with_capacity(line.len() + 1);
        data.push_str(line);
        data.push('\n');
        let bytes = data.len() as u64;
        if self.size > 0 && self.size + bytes > self.max_bytes {
            self.rotate();
        }
        self.file.write_all(data.as_bytes())?;
        self.size += bytes;
        Ok(())
    }

    fn rotate(&mut self) {
        // Rust 在 Windows 上以 FILE_SHARE_DELETE 打开文件，持有句柄时也能改名。
        match fs::rename(&self.path, rotated_path(&self.path)) {
            Ok(()) => {
                if let Ok(file) = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&self.path)
                {
                    self.file = file;
                    self.size = 0;
                }
            }
            // 改名失败（如被其它程序占用）：继续追加，下一个 max_bytes 之后再试，不丢日志。
            Err(_) => self.size = 0,
        }
    }
}

// ---------------------------------------------------------------------------
// 异步写入器
// ---------------------------------------------------------------------------

enum Msg {
    Line(String),
    Attach(PathBuf),
    Flush(mpsc::Sender<()>),
}

/// 日志写入句柄，可克隆；`write_*` 永不阻塞。
#[derive(Clone)]
pub struct LogSink {
    tx: SyncSender<Msg>,
    dropped: Arc<AtomicU64>,
}

impl LogSink {
    /// 启动写线程。`tee_stderr` 为真时每行同时输出到 stderr（开发态控制台）。
    pub fn spawn(max_bytes: u64, capacity: usize, tee_stderr: bool) -> Self {
        let (tx, rx) = mpsc::sync_channel::<Msg>(capacity);
        let dropped = Arc::new(AtomicU64::new(0));
        let thread_dropped = Arc::clone(&dropped);
        let _ = thread::Builder::new()
            .name("agentdeck-desktop-log".to_string())
            .spawn(move || run_writer(rx, thread_dropped, max_bytes, tee_stderr));
        Self { tx, dropped }
    }

    /// 写一整行（已含时间戳等格式）。队列满则丢弃并计数。
    pub fn write_line(&self, line: String) {
        match self.tx.try_send(Msg::Line(line)) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
            Err(TrySendError::Disconnected(_)) => {}
        }
    }

    /// 按 [`format_record`] 格式化后写入。
    pub fn write_record(&self, level: &str, target: &str, message: &str) {
        self.write_line(format_record(SystemTime::now(), level, target, message));
    }

    /// 指定日志目录，开始写 `<dir>/desktop.log`（此前排队的行会补写）。
    pub fn attach(&self, log_dir: &Path) {
        let _ = self.tx.send(Msg::Attach(log_dir.join(LOG_FILE_NAME)));
    }

    /// 等待写线程处理完此前的全部消息，最多 `timeout`；返回是否在时限内完成。
    pub fn flush(&self, timeout: Duration) -> bool {
        let (ack_tx, ack_rx) = mpsc::channel();
        if self.tx.send(Msg::Flush(ack_tx)).is_err() {
            return false;
        }
        ack_rx.recv_timeout(timeout).is_ok()
    }
}

struct WriterState {
    file: Option<RotatingFile>,
    early: VecDeque<String>,
    tee_stderr: bool,
}

impl WriterState {
    fn emit(&mut self, line: String) {
        if self.tee_stderr {
            let _ = writeln!(io::stderr(), "{line}");
        }
        match self.file.as_mut() {
            Some(file) => {
                let _ = file.append_line(&line);
            }
            None => {
                if self.early.len() >= EARLY_LINES_CAP {
                    self.early.pop_front();
                }
                self.early.push_back(line);
            }
        }
    }
}

fn run_writer(rx: mpsc::Receiver<Msg>, dropped: Arc<AtomicU64>, max_bytes: u64, tee_stderr: bool) {
    let mut state = WriterState {
        file: None,
        early: VecDeque::new(),
        tee_stderr,
    };
    while let Ok(msg) = rx.recv() {
        match msg {
            Msg::Line(line) => {
                state.emit(truncate_line(
                    &redact(&line),
                    MAX_LINE_BYTES + LINE_PREFIX_SLACK,
                ));
            }
            Msg::Attach(path) => match RotatingFile::open(&path, max_bytes) {
                Ok(mut file) => {
                    for line in state.early.drain(..) {
                        let _ = file.append_line(&line);
                    }
                    state.file = Some(file);
                }
                Err(err) => {
                    let _ = writeln!(io::stderr(), "打开日志文件 {} 失败: {err}", path.display());
                }
            },
            Msg::Flush(ack) => {
                let _ = ack.send(());
            }
        }
        let lost = dropped.swap(0, Ordering::Relaxed);
        if lost > 0 {
            state.emit(format_record(
                SystemTime::now(),
                "WARN",
                "desktop_log",
                &format!("日志队列已满，丢弃 {lost} 行"),
            ));
        }
    }
}

// ---------------------------------------------------------------------------
// 全局初始化
// ---------------------------------------------------------------------------

static SINK: OnceLock<LogSink> = OnceLock::new();

/// 全局写入句柄；`init` 之前为 None（如集成测试）。
pub fn global() -> Option<LogSink> {
    SINK.get().cloned()
}

/// 数据目录确定后调用。
pub fn attach(log_dir: &Path) {
    if let Some(sink) = SINK.get() {
        sink.attach(log_dir);
    }
}

/// 应用退出前调用，尽量把队列写完。
pub fn flush(timeout: Duration) {
    if let Some(sink) = SINK.get() {
        sink.flush(timeout);
    }
}

/// `env_logger` 的输出目标：交给异步队列。
struct QueueWriter(LogSink);

impl Write for QueueWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let text = String::from_utf8_lossy(buf);
        let line = text.trim_end_matches(['\r', '\n']);
        if !line.is_empty() {
            self.0.write_line(line.to_string());
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// 初始化日志：必须在 `main` 最先调用，且只会生效一次。
pub fn init() {
    let sink = LogSink::spawn(MAX_LOG_BYTES, QUEUE_CAPACITY, true);
    if SINK.set(sink.clone()).is_err() {
        return;
    }
    let mut builder =
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or(DEFAULT_FILTER));
    builder
        .format(|buf, record| {
            writeln!(
                buf,
                "{}",
                format_record(
                    SystemTime::now(),
                    record.level().as_str(),
                    record.target(),
                    &record.args().to_string()
                )
            )
        })
        .target(env_logger::Target::Pipe(Box::new(QueueWriter(sink))));
    if builder.try_init().is_ok() {
        install_panic_hook();
    }
}

/// panic 写入日志（release 无控制台，否则 panic 信息会丢）。
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = thread::current();
        log::error!(
            "panic（线程 {}）: {info}",
            thread.name().unwrap_or("未命名")
        );
        previous(info);
    }));
}

// ---------------------------------------------------------------------------
// 按行读取（限长）
// ---------------------------------------------------------------------------

/// 读一行到 `buf`（不含换行与结尾 `\r`），`buf` 最多保留 `cap` 字节，超出部分读掉丢弃。
/// 返回该行原始总字节数（不含换行）；EOF 且无数据返回 `None`。
/// 与 `BufRead::lines` 不同：不要求 UTF-8，也不会因超长行无限增长内存。
pub fn read_capped_line<R: BufRead>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    cap: usize,
) -> io::Result<Option<usize>> {
    buf.clear();
    let mut total = 0_usize;
    let mut got_any = false;
    loop {
        let available = match reader.fill_buf() {
            Ok(available) => available,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err),
        };
        if available.is_empty() {
            return Ok(got_any.then_some(total));
        }
        got_any = true;
        let newline = available.iter().position(|b| *b == b'\n');
        let used = newline.map_or(available.len(), |index| index + 1);
        let content = &available[..newline.unwrap_or(available.len())];
        total += content.len();
        let room = cap.saturating_sub(buf.len());
        buf.extend_from_slice(&content[..content.len().min(room)]);
        reader.consume(used);
        if newline.is_some() {
            if buf.last() == Some(&b'\r') && buf.len() == total {
                buf.pop();
                total -= 1;
            }
            return Ok(Some(total));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tempfile::TempDir;

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap_or_default()
    }

    #[test]
    fn iso8601_formats_utc_with_millis() {
        assert_eq!(iso8601_utc(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        let t = UNIX_EPOCH + Duration::from_millis(1_700_000_000_123);
        assert_eq!(iso8601_utc(t), "2023-11-14T22:13:20.123Z");
        // 闰日
        let leap = UNIX_EPOCH + Duration::from_secs(1_709_164_800);
        assert_eq!(iso8601_utc(leap), "2024-02-29T00:00:00.000Z");
    }

    #[test]
    fn redact_masks_interop_and_assignment_and_query_tokens() {
        let token = "adi_0123456789abcdef0123456789abcdef0123456789abcdef";
        assert_eq!(redact(&format!("Bearer {token} ok")), "Bearer adi_*** ok");
        // 太短不算 token
        assert_eq!(redact("adi_abc"), "adi_abc");
        assert_eq!(
            redact("env AGENTDECK_TOKEN=deadbeefdeadbeef12345678 PORT=0"),
            "env AGENTDECK_TOKEN=*** PORT=0"
        );
        assert_eq!(
            redact(r#"{"AGENTDECK_TOKEN":"abc123xyz","x":1}"#),
            r#"{"AGENTDECK_TOKEN":"***","x":1}"#
        );
        // 只是提到变量名，不误伤后面的文字
        assert_eq!(
            redact("缺少环境变量 AGENTDECK_TOKEN 无法启动"),
            "缺少环境变量 AGENTDECK_TOKEN 无法启动"
        );
        assert_eq!(
            redact("ws://127.0.0.1:1/rpc?token=0123456789abcdef0123456789abcdef&a=1"),
            "ws://127.0.0.1:1/rpc?token=***&a=1"
        );
        assert_eq!(redact("token=short"), "token=short");
    }

    #[test]
    fn redact_masks_registered_secret_verbatim() {
        register_secret("registered-secret-value-9f3a");
        assert_eq!(
            redact("leak registered-secret-value-9f3a here"),
            "leak *** here"
        );
    }

    #[test]
    fn truncate_line_respects_char_boundary_and_notes_length() {
        assert_eq!(truncate_line("short", 10), "short");
        let text = "中".repeat(10); // 30 字节
        let cut = truncate_line(&text, 8);
        assert!(cut.starts_with("中中"));
        assert!(cut.contains("原长 30 字节"));
    }

    #[test]
    fn rotating_file_rotates_to_single_dot_one() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(LOG_FILE_NAME);
        let mut file = RotatingFile::open(&path, 100).unwrap();
        for i in 0..30 {
            file.append_line(&format!("line-{i:03}-xxxxxxxxxx"))
                .unwrap();
        }
        let current = read(&path);
        let rotated = read(&rotated_path(&path));
        assert!(!rotated.is_empty(), "应已轮转出 .1");
        assert!(current.len() as u64 <= 100 + 30);
        assert!(current.contains("line-029"));
        // 只保留一份：没有 .2
        assert!(!dir.path().join("desktop.log.2").exists());
        // 最新的行都在，旧的行已被覆盖丢弃
        assert!(!rotated.contains("line-000"));
    }

    #[test]
    fn rotating_file_rotates_oversized_existing_file_on_open() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(LOG_FILE_NAME);
        fs::write(&path, vec![b'a'; 200]).unwrap();
        fs::write(rotated_path(&path), "old").unwrap();
        let mut file = RotatingFile::open(&path, 100).unwrap();
        file.append_line("fresh").unwrap();
        assert_eq!(fs::read(rotated_path(&path)).unwrap().len(), 200);
        assert_eq!(read(&path), "fresh\n");
    }

    #[test]
    fn sink_buffers_before_attach_redacts_and_flushes() {
        let dir = TempDir::new().unwrap();
        let sink = LogSink::spawn(MAX_LOG_BYTES, 64, false);
        sink.write_record("INFO", "t", "早于 attach 的日志");
        sink.attach(dir.path());
        sink.write_record(
            "WARN",
            "t",
            "Authorization: Bearer adi_0123456789abcdef0123456789abcdef",
        );
        assert!(sink.flush(Duration::from_secs(5)));
        let text = read(&dir.path().join(LOG_FILE_NAME));
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("[INFO ] t: 早于 attach 的日志"));
        assert!(lines[1].contains("[WARN ] t: Authorization: Bearer adi_***"));
        assert!(!text.contains("0123456789abcdef"));
    }

    #[test]
    fn sink_never_blocks_when_queue_is_full_and_accounts_every_line() {
        let dir = TempDir::new().unwrap();
        // 容量极小：生产者远快于写线程，必然触发丢弃路径
        let sink = LogSink::spawn(u64::MAX, 4, false);
        sink.attach(dir.path());
        let total = 50_000_u64;
        let started = std::time::Instant::now();
        for i in 0..total {
            sink.write_line(format!("row-{i}"));
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "write_line 不应被磁盘阻塞"
        );
        assert!(sink.flush(Duration::from_secs(30)));
        // 丢弃通知在下一条消息之后才会写出，再 flush 一次保证它已落盘
        assert!(sink.flush(Duration::from_secs(30)));
        let text = read(&dir.path().join(LOG_FILE_NAME));
        let written = text.lines().filter(|l| l.starts_with("row-")).count() as u64;
        let dropped: u64 = text
            .lines()
            .filter_map(|l| l.split("丢弃 ").nth(1))
            .filter_map(|rest| rest.split(' ').next()?.parse::<u64>().ok())
            .sum();
        assert_eq!(written + dropped, total);
    }

    #[test]
    fn read_capped_line_handles_crlf_long_lines_and_invalid_utf8() {
        let mut data: Vec<u8> = Vec::new();
        data.extend_from_slice(b"first\r\n");
        data.extend_from_slice(&[b'x'; 100]);
        data.push(b'\n');
        data.extend_from_slice(&[0xff, 0xfe, b'o', b'k', b'\n']);
        data.extend_from_slice(b"no-newline-at-eof");
        let mut reader = io::BufReader::with_capacity(8, io::Cursor::new(data));
        let mut buf = Vec::new();

        assert_eq!(
            read_capped_line(&mut reader, &mut buf, 32).unwrap(),
            Some(5)
        );
        assert_eq!(buf, b"first");
        assert_eq!(
            read_capped_line(&mut reader, &mut buf, 32).unwrap(),
            Some(100)
        );
        assert_eq!(buf.len(), 32);
        assert_eq!(
            read_capped_line(&mut reader, &mut buf, 32).unwrap(),
            Some(4)
        );
        assert_eq!(String::from_utf8_lossy(&buf), "\u{fffd}\u{fffd}ok");
        assert_eq!(
            read_capped_line(&mut reader, &mut buf, 32).unwrap(),
            Some(17)
        );
        assert_eq!(buf, b"no-newline-at-eof");
        assert_eq!(read_capped_line(&mut reader, &mut buf, 32).unwrap(), None);
    }
}
