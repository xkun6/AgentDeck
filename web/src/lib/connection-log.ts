// 手机端连接事件环形缓冲（design.md 4.31「断线诊断」）：记录 SidecarClient / E2eeSocket 的建连、断线、探活、重连等事件，
// 持久化到 localStorage（节流写入），设置页「连接诊断」展示与复制，用来事后定位「总在重连」的真实原因。
// 只在手机入口注入（桌面不创建、不写）。

export const CONNECTION_LOG_KEY = "agentdeck.mobile.connection-log";
export const CONNECTION_LOG_CAPACITY = 100;
/** 事件发生后合并写入的延迟：1 秒内的多条事件只写一次 */
export const CONNECTION_LOG_FLUSH_MS = 1_000;

export interface ConnectionLogEntry {
  /** ISO 时间 */
  at: string;
  /** open / close / error / force-reconnect / probe-start / probe-ok / probe-timeout / schedule-reconnect /
   *  connect-timeout / manual-close / wake-ignored / attempt-ok / attempt-fail / protocol-error 等 */
  event: string;
  /** 触发路径：gap-watchdog / hint / online / visibility / network-change / system-resume / probe / manual 等 */
  trigger?: string;
  /** 时钟跳变 watchdog 看到的间隔（毫秒） */
  gapMs?: number;
  /** close 事件的关闭码 / 原因 / 是否干净关闭 */
  code?: number;
  reason?: string;
  wasClean?: boolean;
  /** 本条连接已存活毫秒数（仅连接曾经打开过） */
  aliveMs?: number;
  /** 距最后一次收到入站帧的毫秒数 */
  idleMs?: number;
  online?: boolean;
  netType?: string;
  effectiveType?: string;
  /** App 是否在前台 */
  foreground?: boolean;
  /** E2eeSocket 的单个地址尝试 */
  address?: string;
  durationMs?: number;
  detail?: string;
}

export type ConnectionLogInput = Omit<ConnectionLogEntry, "at">;

type LogStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface ConnectionEventLogOptions {
  storage?: LogStorage | null;
  storageKey?: string;
  capacity?: number;
  flushDelayMs?: number;
  now?: () => number;
}

interface NavigatorWithConnection {
  onLine?: boolean;
  connection?: { type?: string; effectiveType?: string };
}

/** 当前网络环境（navigator.onLine / Network Information API，有则记） */
export function networkEnvironment(): Pick<ConnectionLogEntry, "online" | "netType" | "effectiveType"> {
  if (typeof navigator === "undefined") return {};
  const nav = navigator as unknown as NavigatorWithConnection;
  return {
    ...(typeof nav.onLine === "boolean" ? { online: nav.onLine } : {}),
    ...(nav.connection?.type ? { netType: nav.connection.type } : {}),
    ...(nav.connection?.effectiveType ? { effectiveType: nav.connection.effectiveType } : {}),
  };
}

export class ConnectionEventLog {
  private items: ConnectionLogEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly storage: LogStorage | null;
  private readonly storageKey: string;
  private readonly capacity: number;
  private readonly flushDelayMs: number;
  private readonly now: () => number;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ConnectionEventLogOptions = {}) {
    this.storage = options.storage ?? null;
    this.storageKey = options.storageKey ?? CONNECTION_LOG_KEY;
    this.capacity = options.capacity ?? CONNECTION_LOG_CAPACITY;
    this.flushDelayMs = options.flushDelayMs ?? CONNECTION_LOG_FLUSH_MS;
    this.now = options.now ?? Date.now;
    this.items = this.load();
  }

  /** 追加一条事件；自动补时间与网络环境，超过容量丢弃最旧的 */
  push(input: ConnectionLogInput): void {
    const entry: ConnectionLogEntry = {
      at: new Date(this.now()).toISOString(),
      ...networkEnvironment(),
      ...input,
    };
    // 每次换新数组引用，让 useSyncExternalStore 感知变化
    this.items = [...this.items, entry].slice(-this.capacity);
    this.scheduleFlush();
    this.emit();
  }

  /** 按时间升序（最旧在前）的快照 */
  entries = (): ConnectionLogEntry[] => this.items;

  /** useSyncExternalStore 用：内容变化时返回新数组引用 */
  getSnapshot = (): ConnectionLogEntry[] => this.items;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  clear(): void {
    this.items = [];
    this.cancelFlush();
    try {
      this.storage?.removeItem(this.storageKey);
    } catch {
      // 存储不可用：忽略
    }
    this.emit();
  }

  /** 立即写入持久化存储（页面即将隐藏 / 被挂起时调用） */
  flush(): void {
    this.cancelFlush();
    try {
      this.storage?.setItem(this.storageKey, this.serialize());
    } catch {
      // 存储不可用（隐私模式 / 配额）：本次运行内仍然可看
    }
  }

  /** 序列化为 JSON 数组文本（持久化格式，也是「复制全部」的内容） */
  serialize(entries: ConnectionLogEntry[] = this.items): string {
    return JSON.stringify(entries);
  }

  private load(): ConnectionLogEntry[] {
    try {
      const raw = this.storage?.getItem(this.storageKey);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const valid = parsed.filter(
        (item): item is ConnectionLogEntry =>
          typeof item === "object" && item !== null && typeof (item as ConnectionLogEntry).at === "string" && typeof (item as ConnectionLogEntry).event === "string",
      );
      return valid.slice(-this.capacity);
    } catch {
      return [];
    }
  }

  private scheduleFlush(): void {
    if (!this.storage || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.flushDelayMs);
  }

  private cancelFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

let mobileLog: ConnectionEventLog | null = null;

/** 手机入口的全局事件日志（localStorage 持久化）；页面隐藏时立即落盘，避免进程被挂起 / 杀掉丢掉最后的事件 */
export function getMobileConnectionLog(): ConnectionEventLog {
  if (mobileLog) return mobileLog;
  const storage = typeof localStorage === "undefined" ? null : localStorage;
  const log = new ConnectionEventLog({ storage });
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") log.flush();
    });
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", () => log.flush());
  }
  mobileLog = log;
  return log;
}

const TRIGGER_TEXT: Record<string, string> = {
  "gap-watchdog": "时钟跳变",
  hint: "回前台",
  online: "网络恢复",
  visibility: "页面可见",
  "network-change": "网络切换",
  "system-resume": "系统唤醒",
  probe: "探活超时",
  manual: "手动",
};

function localTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 设置页单行摘要：时间 + 事件 + 触发路径 + code */
export function formatConnectionLogLine(entry: ConnectionLogEntry): string {
  const parts = [localTime(entry.at), entry.event];
  if (entry.trigger) {
    const text = TRIGGER_TEXT[entry.trigger];
    parts.push(text ? `${entry.trigger}(${text})` : entry.trigger);
  }
  if (entry.gapMs !== undefined) parts.push(`gap=${entry.gapMs}ms`);
  if (entry.code !== undefined) parts.push(`code=${entry.code}`);
  if (entry.reason) parts.push(`reason=${entry.reason}`);
  return parts.join(" ");
}
