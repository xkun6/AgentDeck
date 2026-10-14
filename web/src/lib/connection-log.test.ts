// @vitest-environment jsdom
// 连接事件环形缓冲：容量上限、序列化 / 加载、节流写入、清空、设置页单行格式。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTION_LOG_CAPACITY,
  CONNECTION_LOG_KEY,
  ConnectionEventLog,
  formatConnectionLogLine,
  type ConnectionLogEntry,
} from "./connection-log";

class MemoryStorage {
  readonly data = new Map<string, string>();
  writes = 0;
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes += 1;
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ConnectionEventLog", () => {
  it("环形缓冲：最多保留 100 条，丢弃最旧的", () => {
    const log = new ConnectionEventLog();
    for (let i = 0; i < CONNECTION_LOG_CAPACITY + 25; i++) log.push({ event: "open", detail: String(i) });
    const entries = log.entries();
    expect(entries).toHaveLength(CONNECTION_LOG_CAPACITY);
    expect(entries[0]!.detail).toBe("25");
    expect(entries[entries.length - 1]!.detail).toBe(String(CONNECTION_LOG_CAPACITY + 24));
  });

  it("每条记录带 ISO 时间与网络环境（navigator.onLine）", () => {
    vi.setSystemTime(new Date("2026-03-04T05:06:07.000Z"));
    const log = new ConnectionEventLog();
    log.push({ event: "close", code: 1006, reason: "x", wasClean: false });
    expect(log.entries()[0]).toMatchObject({
      at: "2026-03-04T05:06:07.000Z",
      event: "close",
      code: 1006,
      online: navigator.onLine,
    });
  });

  it("序列化为 JSON 数组并能从存储加载（超过容量只保留最新的）", () => {
    const storage = new MemoryStorage();
    const log = new ConnectionEventLog({ storage });
    log.push({ event: "open", trigger: "hint" });
    log.push({ event: "close", code: 1011 });
    const parsed = JSON.parse(log.serialize()) as ConnectionLogEntry[];
    expect(parsed.map((e) => e.event)).toEqual(["open", "close"]);

    storage.data.set(
      CONNECTION_LOG_KEY,
      JSON.stringify([
        { at: "t", event: "a" },
        { bad: true },
        { at: "t", event: "b" },
        { at: "t", event: "c" },
      ]),
    );
    const loaded = new ConnectionEventLog({ storage, capacity: 2 });
    expect(loaded.entries().map((e) => e.event)).toEqual(["b", "c"]);
    storage.data.set(CONNECTION_LOG_KEY, "{broken");
    expect(new ConnectionEventLog({ storage }).entries()).toEqual([]);
  });

  it("持久化节流：1 秒内的多条事件合并成一次写入；flush 立即写入；clear 清存储", () => {
    const storage = new MemoryStorage();
    const log = new ConnectionEventLog({ storage });
    log.push({ event: "open" });
    log.push({ event: "close" });
    log.push({ event: "force-reconnect" });
    expect(storage.writes).toBe(0);
    vi.advanceTimersByTime(999);
    expect(storage.writes).toBe(0);
    vi.advanceTimersByTime(2);
    expect(storage.writes).toBe(1);
    expect(JSON.parse(storage.data.get(CONNECTION_LOG_KEY)!)).toHaveLength(3);

    log.push({ event: "open" });
    log.flush();
    expect(storage.writes).toBe(2);
    vi.advanceTimersByTime(2_000);
    expect(storage.writes).toBe(2); // flush 取消了待执行的节流写

    log.clear();
    expect(log.entries()).toEqual([]);
    expect(storage.data.has(CONNECTION_LOG_KEY)).toBe(false);
  });

  it("没有 storage（桌面 / 测试）时不写任何东西，订阅方收到变化", () => {
    const log = new ConnectionEventLog();
    const seen: number[] = [];
    log.subscribe(() => seen.push(log.getSnapshot().length));
    log.push({ event: "open" });
    log.push({ event: "close" });
    log.clear();
    expect(seen).toEqual([1, 2, 0]);
  });
});

describe("formatConnectionLogLine", () => {
  it("时间 + 事件 + 触发路径 + gap + code + reason", () => {
    const line = formatConnectionLogLine({
      at: "2026-03-04T05:06:07.000Z",
      event: "force-reconnect",
      trigger: "gap-watchdog",
      gapMs: 6200,
      code: 1006,
      reason: "断了",
    });
    expect(line).toMatch(/^\d\d-\d\d \d\d:\d\d:\d\d force-reconnect gap-watchdog\(时钟跳变\) gap=6200ms code=1006 reason=断了$/);
  });
});
