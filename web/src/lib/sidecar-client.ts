// 前端 ↔ Node sidecar 的 JSON-RPC 2.0 客户端（契约见 docs/design.md 第 4 节）。
//
// 传输层改造自 gateway-client.ts：同样的请求/响应匹配、1→15s 指数退避重连、
// 唤醒（online / visibility / 系统 resume / 时钟跳变）触发重连；socket 载体沿用
// gateway-socket-path.ts 的原生 WS / Rust 中继自动回退（两条路径线协议相同）。
//
// 在此之上额外负责 agent 事件流的「连续、去重」：
// - 每个 agent 记录已投递的最后一个 seq；重复（seq <= lastSeq）直接丢弃；
// - 出现缺口（seq > lastSeq + 1，例如第一次见到某个已有历史的 agent）时，
//   用 `agent.timeline { sinceSeq }` 补齐，期间到达的实时事件先缓冲，补齐后按序投递；
// - 重连成功后对所有已知 agent 补齐，再拉 `agent.list` 刷新快照；
// - `epoch` 变化（sidecar 重启）时丢弃全部旧序号，通知订阅方并重新拉 `agent.list`。
//
// 会话持久化（design.md 4.5）：sidecar 重启后旧会话以 dormant / closed 留在列表里，
// seq 跨进程连续递增；timeline 返回的历史条目保留原 seq 与原 epoch，因此这里只按 seq
// 去重，epoch 只取 `agent.timeline` 响应顶层与实时事件上的当前进程 epoch。
// 经 timeline 补齐投递的事件带 `replay: true`，订阅方据此跳过桌面通知等副作用。
import {
  AGENT_RPC_NOTIFICATIONS,
  type AgentRpcErrorObject,
  type AgentRpcMethodName,
  type AgentRpcParams,
  type AgentRpcResult,
  type AgentSnapshot,
  type AgentStreamEnvelope,
  type AgentBackgroundTask,
  type ProviderSubagentUpdate,
} from "@agentdeck/protocol";
import { createGatewaySocket } from "./gateway-socket-path";

export type SidecarConnectionState = "idle" | "connecting" | "open" | "closed" | "error";

/** 与原生 WebSocket 构造签名一致的工厂（默认原生 WS，Tauri 下可回退 Rust 中继）。 */
export type SidecarSocketFactory = (url: string) => WebSocket;

export interface SidecarRequestOptions {
  timeoutMs?: number;
}

export interface SidecarClientOptions {
  /** 每次建连前调用，返回带 token 的完整 ws 地址；sidecar 未就绪时应抛错。 */
  resolveUrl: () => Promise<string>;
  socketFactory?: SidecarSocketFactory;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  /** 是否安装 online / visibility / 时钟跳变等唤醒监听（测试里关掉）。 */
  wakeListeners?: boolean;
}

const DEFAULT_RPC_TIMEOUT_MS = 120_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 15_000;
const RECONNECT_EXP_CAP = 4;
const WAKE_WATCHDOG_INTERVAL_MS = 2_000;
const WAKE_GAP_THRESHOLD_MS = 5_000;
const SOCKET_OPEN = 1;

/** JSON-RPC 错误：`code` 为 JSON-RPC 错误码，`businessCode` 为 `-32000` 时的 `data.code`。 */
export class SidecarRpcError extends Error {
  readonly code: number;
  readonly businessCode?: string;
  readonly data?: AgentRpcErrorObject["data"];

  constructor(error: AgentRpcErrorObject) {
    super(error.message || `RPC 错误 ${error.code}`);
    this.name = "SidecarRpcError";
    this.code = error.code;
    this.data = error.data;
    const businessCode = error.data?.code;
    if (typeof businessCode === "string") this.businessCode = businessCode;
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 事件投递附带信息：`replay` 为 true 表示来自 `agent.timeline` 补齐（历史回放）。 */
export interface SidecarStreamMeta {
  replay: boolean;
}

interface AgentSeqTracker {
  lastSeq: number;
  syncing: Promise<void> | null;
  buffer: AgentStreamEnvelope[];
}

type RequestArgs<M extends AgentRpcMethodName> = undefined extends AgentRpcParams<M>
  ? [params?: AgentRpcParams<M>, options?: SidecarRequestOptions]
  : [params: AgentRpcParams<M>, options?: SidecarRequestOptions];

type Listener<T> = (value: T) => void;

function emitTo<T>(listeners: Set<Listener<T>>, value: T): void {
  for (const listener of [...listeners]) {
    try {
      listener(value);
    } catch (error) {
      console.error("[sidecar-client] 订阅回调出错", error);
    }
  }
}

function subscribe<T>(listeners: Set<Listener<T>>, listener: Listener<T>): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function bySeq(a: AgentStreamEnvelope, b: AgentStreamEnvelope): number {
  return a.seq - b.seq;
}

export class SidecarClient {
  private readonly resolveUrl: () => Promise<string>;
  private readonly socketFactory: SidecarSocketFactory;
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly wakeListenersEnabled: boolean;

  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private _state: SidecarConnectionState = "idle";
  private pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private intentionalClose = false;
  private autoReconnect = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private openedOnce = false;
  private _currentUrl: string | null = null;

  private wakeListenersInstalled = false;
  private wakeWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastWakeTickAt = 0;
  private boundOnline: (() => void) | null = null;
  private boundVisibility: (() => void) | null = null;
  private unsubscribeSystemResume: (() => void) | null = null;

  private _epoch: string | null = null;
  private trackers = new Map<string, AgentSeqTracker>();

  private stateListeners = new Set<Listener<SidecarConnectionState>>();
  private streamListeners = new Set<(envelope: AgentStreamEnvelope, meta: SidecarStreamMeta) => void>();
  private agentRemovedListeners = new Set<Listener<string>>();
  private agentStateListeners = new Set<Listener<AgentSnapshot>>();
  private agentsListeners = new Set<Listener<AgentSnapshot[]>>();
  private epochListeners = new Set<Listener<{ epoch: string | null; previous: string | null }>>();
  private providerChangedListeners = new Set<Listener<void>>();
  private subagentListeners = new Set<Listener<ProviderSubagentUpdate>>();
  private tasksListeners = new Set<Listener<{ agentId: string; tasks: AgentBackgroundTask[] }>>();

  constructor(options: SidecarClientOptions) {
    this.resolveUrl = options.resolveUrl;
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? RECONNECT_BASE_DELAY_MS;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? RECONNECT_MAX_DELAY_MS;
    this.wakeListenersEnabled = options.wakeListeners ?? true;
  }

  get state(): SidecarConnectionState {
    return this._state;
  }

  /** 最近一次成功建连使用的地址。 */
  get currentUrl(): string | null {
    return this._currentUrl;
  }

  /** 当前已知的 sidecar epoch（尚未从事件或 timeline 得知时为 null）。 */
  get epoch(): string | null {
    return this._epoch;
  }

  /** 已向订阅方投递的某 agent 最后一个 seq（未知为 0）。 */
  lastSeq(agentId: string): number {
    return this.trackers.get(agentId)?.lastSeq ?? 0;
  }

  // ── 订阅 ────────────────────────────────────────────────────────────────

  onState(listener: Listener<SidecarConnectionState>): () => void {
    listener(this._state);
    return subscribe(this.stateListeners, listener);
  }

  /** 连续、去重后的 agent 事件流（实时 + 补齐）。 */
  onStream(listener: (envelope: AgentStreamEnvelope, meta: SidecarStreamMeta) => void): () => void {
    this.streamListeners.add(listener);
    return () => {
      this.streamListeners.delete(listener);
    };
  }

  /** `agent.removed` 通知（会话被删除）。 */
  onAgentRemoved(listener: Listener<string>): () => void {
    return subscribe(this.agentRemovedListeners, listener);
  }

  /** `agent.state` 通知。 */
  onAgentState(listener: Listener<AgentSnapshot>): () => void {
    return subscribe(this.agentStateListeners, listener);
  }

  /** 每次（重）连成功或 epoch 变化后拉到的完整 `agent.list`。 */
  onAgents(listener: Listener<AgentSnapshot[]>): () => void {
    return subscribe(this.agentsListeners, listener);
  }

  /** `provider.changed` 通知（providers.json 被替换，需刷新 provider.list 与模型目录）。 */
  onProviderChanged(listener: Listener<void>): () => void {
    return subscribe(this.providerChangedListeners, listener);
  }

  /** `agent.subagents.update` 通知（provider 子代理描述 / 时间线变化，design.md 4.11）。 */
  onSubagentUpdate(listener: Listener<ProviderSubagentUpdate>): () => void {
    return subscribe(this.subagentListeners, listener);
  }

  /** `agent.tasks.update` 通知（后台任务整表，design.md 4.15）。 */
  onTasksUpdate(listener: Listener<{ agentId: string; tasks: AgentBackgroundTask[] }>): () => void {
    return subscribe(this.tasksListeners, listener);
  }

  /** sidecar 重启（epoch 变化）。`epoch` 为 null 表示已知 agent 全部消失但新 epoch 尚未得知。 */
  onEpochChange(listener: Listener<{ epoch: string | null; previous: string | null }>): () => void {
    return subscribe(this.epochListeners, listener);
  }

  // ── 连接 ────────────────────────────────────────────────────────────────

  private setState(next: SidecarConnectionState): void {
    if (this._state === next) return;
    this._state = next;
    emitTo(this.stateListeners, next);
  }

  enableAutoReconnect(): void {
    this.autoReconnect = true;
    this.installWakeListeners();
  }

  disableAutoReconnect(): void {
    this.autoReconnect = false;
    this.cancelReconnect();
    this.removeWakeListeners();
  }

  connect(): Promise<void> {
    if (this.ws && this.ws.readyState === SOCKET_OPEN && this._state === "open") return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.intentionalClose = false;

    const promise = this.openSocket().finally(() => {
      if (this.connectPromise === promise) this.connectPromise = null;
    });
    this.connectPromise = promise;
    return promise;
  }

  private async openSocket(): Promise<void> {
    this.setState("connecting");
    let url: string;
    try {
      url = await this.resolveUrl();
    } catch (error) {
      this.setState("error");
      this.scheduleReconnect();
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (this.intentionalClose) {
      this.setState("idle");
      throw new Error("连接已关闭");
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = this.socketFactory(url);
      } catch (error) {
        this.setState("error");
        this.scheduleReconnect();
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.ws = ws;
      const isCurrent = () => this.ws === ws;

      const connectTimer = setTimeout(() => {
        if (settled || !isCurrent()) return;
        settled = true;
        this.ws = null;
        try { ws.close(); } catch {}
        this.setState("error");
        reject(new Error("连接 Agent 服务超时"));
        this.scheduleReconnect();
      }, this.connectTimeoutMs);

      ws.onopen = () => {
        if (!isCurrent() || settled) return;
        settled = true;
        clearTimeout(connectTimer);
        this.reconnectAttempts = 0;
        this._currentUrl = url;
        this.setState("open");
        resolve();
        void this.afterOpen();
      };

      const handleDrop = (message: string) => {
        if (!isCurrent()) return;
        this.ws = null;
        clearTimeout(connectTimer);
        this.rejectPending(message);
        if (!settled) {
          settled = true;
          this.setState("error");
          reject(new Error(message));
        } else {
          this.setState("closed");
        }
        try { ws.close(); } catch {}
        if (!this.intentionalClose) this.scheduleReconnect();
      };

      ws.onclose = () => handleDrop("与 Agent 服务的连接已断开");
      ws.onerror = () => handleDrop("无法连接 Agent 服务");
      ws.onmessage = (event: MessageEvent) => {
        if (!isCurrent()) return;
        let frame: unknown;
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          console.warn("[sidecar-client] 收到无法解析的帧");
          return;
        }
        this.handleFrame(frame);
      };
    });
  }

  private rejectPending(message: string): void {
    this.pending.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject(new Error(message));
    });
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (!this.autoReconnect || this.intentionalClose) return;
    if (this.reconnectTimer) return;
    const delay = Math.min(
      this.reconnectBaseDelayMs * Math.pow(2, Math.min(this.reconnectAttempts, RECONNECT_EXP_CAP)),
      this.reconnectMaxDelayMs,
    );
    const jitter = delay * 0.2 * Math.random();
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionalClose || this._state === "open") return;
      this.connect().catch(() => {});
    }, delay + jitter);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** 丢弃当前连接并立即重连（sidecar 重启拿到新地址 / 系统唤醒时用）。 */
  forceReconnect(_reason = "manual"): void {
    if (this.intentionalClose) return;
    this.cancelReconnect();
    this.reconnectAttempts = 0;
    const ws = this.ws;
    if (ws || this.connectPromise) {
      this.ws = null;
      this.connectPromise = null;
      this.rejectPending("与 Agent 服务的连接已断开");
      if (ws) {
        try { ws.close(); } catch {}
      }
      this.setState("closed");
    }
    this.connect().catch(() => {});
  }

  close(): void {
    this.intentionalClose = true;
    this.cancelReconnect();
    this.removeWakeListeners();
    this.rejectPending("连接已关闭");
    const ws = this.ws;
    this.ws = null;
    this.connectPromise = null;
    if (ws) {
      try { ws.close(); } catch {}
    }
    this.setState("idle");
  }

  // ── 唤醒监听（与 gateway-client 相同的策略） ───────────────────────────────

  private installWakeListeners(): void {
    if (!this.wakeListenersEnabled || this.wakeListenersInstalled) return;
    if (typeof window === "undefined") return;
    this.wakeListenersInstalled = true;

    // AgentDeck 的 Rust 外壳目前不发系统唤醒事件，时钟跳变 watchdog 始终开启；
    // 若桥提供了 onSystemResume 也一并订阅。断线重连后有 timeline 补齐，误触发代价很小。
    const desktop = window.hermesDesktop;
    if (typeof desktop?.onSystemResume === "function") {
      this.unsubscribeSystemResume = desktop.onSystemResume(() => this.handleWake(true));
    }
    this.lastWakeTickAt = Date.now();
    this.wakeWatchdogTimer = setInterval(() => {
      const now = Date.now();
      const gap = now - this.lastWakeTickAt;
      this.lastWakeTickAt = now;
      if (gap > WAKE_GAP_THRESHOLD_MS) this.handleWake(true);
    }, WAKE_WATCHDOG_INTERVAL_MS);
    if (typeof window.addEventListener === "function") {
      this.boundOnline = () => this.handleWake(false);
      window.addEventListener("online", this.boundOnline);
    }
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      this.boundVisibility = () => {
        if (document.visibilityState === "visible") this.handleWake(false);
      };
      document.addEventListener("visibilitychange", this.boundVisibility);
    }
  }

  private removeWakeListeners(): void {
    if (!this.wakeListenersInstalled) return;
    this.wakeListenersInstalled = false;
    if (this.wakeWatchdogTimer) {
      clearInterval(this.wakeWatchdogTimer);
      this.wakeWatchdogTimer = null;
    }
    if (this.boundOnline && typeof window !== "undefined") {
      window.removeEventListener("online", this.boundOnline);
      this.boundOnline = null;
    }
    if (this.boundVisibility && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.boundVisibility);
      this.boundVisibility = null;
    }
    this.unsubscribeSystemResume?.();
    this.unsubscribeSystemResume = null;
  }

  private handleWake(forceful: boolean): void {
    if (!this.autoReconnect || this.intentionalClose) return;
    if (!forceful && this.ws?.readyState === SOCKET_OPEN) return;
    this.forceReconnect(forceful ? "wake" : "hint");
  }

  // ── 请求 ────────────────────────────────────────────────────────────────

  async request<M extends AgentRpcMethodName>(
    method: M,
    ...args: RequestArgs<M>
  ): Promise<AgentRpcResult<M>> {
    const [params, options] = args as [AgentRpcParams<M> | undefined, SidecarRequestOptions | undefined];
    await this.connect();
    const ws = this.ws;
    if (!ws || ws.readyState !== SOCKET_OPEN) {
      throw new Error("Agent 服务未连接");
    }
    const timeoutMs = options?.timeoutMs ?? this.requestTimeoutMs;
    const id = `r${this.nextId++}`;
    return new Promise<AgentRpcResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleFrame(frame: unknown): void {
    if (!frame || typeof frame !== "object") return;
    const record = frame as Record<string, unknown>;
    if (record.id !== undefined && record.id !== null) {
      const key = String(record.id);
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key);
      clearTimeout(pending.timer);
      if (record.error && typeof record.error === "object") {
        pending.reject(new SidecarRpcError(record.error as AgentRpcErrorObject));
      } else {
        pending.resolve(record.result);
      }
      return;
    }

    if (record.method === AGENT_RPC_NOTIFICATIONS.agentStream && record.params) {
      this.handleLiveEnvelope(record.params as AgentStreamEnvelope);
      return;
    }
    if (record.method === AGENT_RPC_NOTIFICATIONS.agentState && record.params) {
      const agent = (record.params as { agent?: AgentSnapshot }).agent;
      if (agent) emitTo(this.agentStateListeners, agent);
      return;
    }
    if (record.method === AGENT_RPC_NOTIFICATIONS.agentSubagentsUpdate && record.params) {
      emitTo(this.subagentListeners, record.params as ProviderSubagentUpdate);
      return;
    }
    if (record.method === AGENT_RPC_NOTIFICATIONS.agentTasksUpdate && record.params) {
      emitTo(this.tasksListeners, record.params as { agentId: string; tasks: AgentBackgroundTask[] });
      return;
    }
    if (record.method === AGENT_RPC_NOTIFICATIONS.providerChanged) {
      emitTo(this.providerChangedListeners, undefined);
      return;
    }
    if (record.method === AGENT_RPC_NOTIFICATIONS.agentRemoved && record.params) {
      const agentId = (record.params as { agentId?: unknown }).agentId;
      if (typeof agentId !== "string") return;
      this.trackers.delete(agentId);
      emitTo(this.agentRemovedListeners, agentId);
    }
  }

  // ── 事件连续性 ──────────────────────────────────────────────────────────

  private tracker(agentId: string): AgentSeqTracker {
    let tracker = this.trackers.get(agentId);
    if (!tracker) {
      tracker = { lastSeq: 0, syncing: null, buffer: [] };
      this.trackers.set(agentId, tracker);
    }
    return tracker;
  }

  /** 记录 epoch；发生变化返回 true（已清空旧序号并通知订阅方）。 */
  private noteEpoch(epoch: string | null | undefined): boolean {
    if (!epoch) return false;
    if (this._epoch === null) {
      this._epoch = epoch;
      return false;
    }
    if (this._epoch === epoch) return false;
    this.resetEpoch(epoch);
    return true;
  }

  private resetEpoch(epoch: string | null): void {
    const previous = this._epoch;
    this._epoch = epoch;
    this.trackers.clear();
    emitTo(this.epochListeners, { epoch, previous });
    void this.refreshAgents().catch(() => {});
  }

  private deliver(envelope: AgentStreamEnvelope, replay = false): void {
    const tracker = this.tracker(envelope.agentId);
    if (envelope.seq <= tracker.lastSeq) return;
    tracker.lastSeq = envelope.seq;
    const meta: SidecarStreamMeta = { replay };
    for (const listener of [...this.streamListeners]) {
      try {
        listener(envelope, meta);
      } catch (error) {
        console.error("[sidecar-client] 订阅回调出错", error);
      }
    }
  }

  private handleLiveEnvelope(envelope: AgentStreamEnvelope): void {
    if (!envelope || typeof envelope.agentId !== "string" || typeof envelope.seq !== "number") return;
    this.noteEpoch(envelope.epoch);
    const tracker = this.tracker(envelope.agentId);
    if (tracker.syncing) {
      tracker.buffer.push(envelope);
      return;
    }
    if (envelope.seq <= tracker.lastSeq) return;
    if (envelope.seq === tracker.lastSeq + 1) {
      this.deliver(envelope);
      return;
    }
    tracker.buffer.push(envelope);
    void this.syncAgent(envelope.agentId).catch(() => {});
  }

  /**
   * 用 `agent.timeline { sinceSeq }` 补齐某 agent 的事件并按序投递给订阅方。
   * 对话页打开某个 agent 时调用一次即可拿到完整历史；已在补齐中则复用同一 Promise。
   */
  syncAgent(agentId: string): Promise<void> {
    const tracker = this.tracker(agentId);
    if (tracker.syncing) return tracker.syncing;
    const run = (async () => {
      try {
        await this.fetchAndDeliver(agentId);
      } finally {
        const current = this.trackers.get(agentId);
        if (current) {
          current.syncing = null;
          const buffered = current.buffer.sort(bySeq);
          current.buffer = [];
          for (const envelope of buffered) this.deliver(envelope);
        }
      }
    })();
    tracker.syncing = run;
    return run;
  }

  private async fetchAndDeliver(agentId: string): Promise<void> {
    const sinceSeq = this.lastSeq(agentId);
    const result = await this.request("agent.timeline", { agentId, sinceSeq });
    if (this.noteEpoch(result.epoch) && sinceSeq > 0) {
      // 旧序号已作废：按新 epoch 从头拉一次
      const full = await this.request("agent.timeline", { agentId, sinceSeq: 0 });
      for (const envelope of [...full.entries].sort(bySeq)) this.deliver(envelope, true);
      return;
    }
    for (const envelope of [...result.entries].sort(bySeq)) this.deliver(envelope, true);
  }

  /** 拉取 `agent.list` 并通知订阅方。 */
  async refreshAgents(): Promise<AgentSnapshot[]> {
    const { agents } = await this.request("agent.list");
    emitTo(this.agentsListeners, agents);
    return agents;
  }

  private async afterOpen(): Promise<void> {
    const reconnect = this.openedOnce;
    this.openedOnce = true;
    try {
      if (reconnect) {
        for (const agentId of [...this.trackers.keys()]) {
          try {
            await this.syncAgent(agentId);
          } catch (error) {
            if (error instanceof SidecarRpcError && error.businessCode === "AGENT_NOT_FOUND") {
              // 已知 agent 不存在了：sidecar 已重启（新 epoch 由后续事件得知）
              this.resetEpoch(null);
              return;
            }
            throw error;
          }
          if (!this.trackers.has(agentId)) return; // 补齐中发现 epoch 变化，resetEpoch 已重拉列表
        }
      }
      await this.refreshAgents();
    } catch (error) {
      console.warn("[sidecar-client] 连接后同步失败", error);
    }
  }
}

// ── 单例与地址解析 ────────────────────────────────────────────────────────

export interface SidecarStatusPayload {
  wsUrl: string;
  token: string;
  version: string | null;
  status: "starting" | "ready" | "failed" | "stopped";
  error: string | null;
}

export function buildSidecarSocketUrl(wsUrl: string, token: string): string {
  const url = new URL(wsUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" &&
    (window.__HERMES_RUNTIME__?.platform === "tauri" || Boolean(window.__TAURI_INTERNALS__));
}

/** 解析当前 sidecar 的 ws 地址：Tauri 下取 `get_sidecar_config`，浏览器开发模式取环境变量。 */
export async function resolveSidecarUrl(): Promise<string> {
  if (isTauriRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const status = await invoke<SidecarStatusPayload>("get_sidecar_config");
    if (status.status !== "ready" || !status.wsUrl) {
      throw new Error(status.error || `Agent 服务未就绪（${status.status}）`);
    }
    return buildSidecarSocketUrl(status.wsUrl, status.token);
  }
  const wsUrl = import.meta.env.VITE_AGENTDECK_SIDECAR_URL?.trim();
  const token = import.meta.env.VITE_AGENTDECK_SIDECAR_TOKEN?.trim() ?? "";
  if (!wsUrl) {
    throw new Error("未配置 Agent 服务地址：浏览器模式请设置 VITE_AGENTDECK_SIDECAR_URL 与 VITE_AGENTDECK_SIDECAR_TOKEN");
  }
  return buildSidecarSocketUrl(wsUrl, token);
}

let instance: SidecarClient | null = null;

async function watchTauriSidecarStatus(client: SidecarClient): Promise<void> {
  const { listen } = await import("@tauri-apps/api/event");
  await listen<SidecarStatusPayload>("sidecar-status", (event) => {
    const status = event.payload;
    if (status.status !== "ready" || !status.wsUrl) return;
    const url = buildSidecarSocketUrl(status.wsUrl, status.token);
    // 已连在同一地址上无需重连；sidecar 重启后端口 / token 变化则立即重连
    if (client.state === "open" && client.currentUrl === url) return;
    client.forceReconnect("sidecar-status");
  });
}

export function getSidecarClient(): SidecarClient {
  if (instance) return instance;
  instance = new SidecarClient({
    resolveUrl: resolveSidecarUrl,
    socketFactory: createGatewaySocket,
  });
  instance.enableAutoReconnect();
  if (isTauriRuntime()) {
    void watchTauriSidecarStatus(instance).catch((error) => {
      console.warn("[sidecar-client] 无法监听 sidecar-status", error);
    });
  }
  return instance;
}

/** 测试用：替换或清空单例。 */
export function __setSidecarClientForTests(client: SidecarClient | null): void {
  instance = client;
}
