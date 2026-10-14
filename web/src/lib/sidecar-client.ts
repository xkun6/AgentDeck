// 前端 ↔ Node sidecar 的 JSON-RPC 2.0 客户端（契约见 docs/design.md 第 4 节）。
//
// 传输层改造自 gateway-client.ts：同样的请求/响应匹配、1→15s 指数退避重连、
// 唤醒（online / visibility / 系统 resume / 时钟跳变）触发重连；socket 载体沿用
// sidecar-socket-path.ts 的原生 WS / Rust 中继自动回退（两条路径线协议相同）。
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
  type AgentGroup,
  type Schedule,
  type ScheduleNotice,
  type RemoteStatus,
  type AttentionNotice,
  type Board,
} from "@agentdeck/protocol";
import { debugBus } from "./debug-bus";

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
  /**
   * 首次同步某个 agent（本地还没有它的任何事件）时只取最近这么多条（`agent.timeline { limit }`，design.md 4.31），
   * 更早的历史用 `fetchOlder` 按需向前翻页。手机端设置；桌面不设，保持整段补齐。
   */
  historyLimit?: number;
  /**
   * 回前台 / 网络恢复时的死连接探测（手机端设置，桌面不设）：连接看起来还开着，但距最后一次收到数据已超过 `idleMs`，
   * 就立即发一次 `sidecar.info`，`timeoutMs` 内没有回应则强制断开重连（不等 TCP 自然超时），重连后照常 `sinceSeq` 补齐。
   */
  livenessProbe?: LivenessProbeOptions;
  /**
   * 页面当前是否处于后台（手机端设置，默认看 `document.visibilityState`）。后台时浏览器会把定时器限速到每秒甚至每分钟一次，
   * 时钟跳变 watchdog 看到的「间隔」只是限速而不是系统休眠，所以此时的跳变不再无条件强制重连，改走 `livenessProbe`。
   * 原生壳里后台保活会让页面一直保持可见，由调用方改用原生前后台状态判断。
   */
  isBackground?: () => boolean;
}

export interface LivenessProbeOptions {
  idleMs: number;
  timeoutMs: number;
}

/** 手机端默认值：15 秒没收到任何数据才探活，3 秒内无回应即判定连接已死 */
export const DEFAULT_LIVENESS_PROBE: LivenessProbeOptions = { idleMs: 15_000, timeoutMs: 3_000 };

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

/**
 * 请求发出后连接断开，结果未知：服务端可能已经处理（例如页面被系统挂起期间发出的 agent.send）。
 * 与「未连接」「请求超时」「RPC 错误」区分开，调用方据此在重连补齐后核对是否已落地（见 `confirmUserMessage`）。
 */
export class SidecarConnectionLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SidecarConnectionLostError";
  }
}

/**
 * 断线后核对 agent.send / steer 是否已落地的整体时限（重连 + 补齐）。超时按「未确认」处理，
 * 避免界面永远停在「思考中」（见 `confirmUserMessage` / use-agent-session 的 `confirmLostSend`）。
 */
export const CONFIRM_USER_MESSAGE_TIMEOUT_MS = 20_000;

/** 记住最近这么多条已收到的用户消息 clientMessageId（用于断线后判断 agent.send / steer 是否已落地） */
const DELIVERED_MESSAGE_LIMIT = 500;

/**
 * 终止性关闭码区间：socket 以 4400–4499 关闭表示「重试也没用」（例如远程网关的凭据失效），
 * 此时不再自动重连，由上层提示用户处理后手动 `connect()` / `forceReconnect()`。
 */
export const SIDECAR_TERMINAL_CLOSE_MIN = 4400;
export const SIDECAR_TERMINAL_CLOSE_MAX = 4499;

/** 收到终止性关闭码时的错误：`reason` 为 socket 关闭时给出的原因（远程网关为 expired / invalid / revoked）。 */
export class SidecarTerminalError extends Error {
  readonly closeCode: number;
  readonly reason: string;

  constructor(closeCode: number, reason: string) {
    super(reason ? `连接被拒绝：${reason}` : "连接被拒绝");
    this.name = "SidecarTerminalError";
    this.closeCode = closeCode;
    this.reason = reason;
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
  /** 本地已拿到的最早 seq（向前翻页的游标）；尚未收到任何事件时为 0 */
  oldestSeq: number;
  /** sidecar 上是否还有比 oldestSeq 更早的条目 */
  hasOlder: boolean;
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
  private readonly historyLimit: number | undefined;
  private readonly livenessProbe: LivenessProbeOptions | undefined;
  private readonly isBackground: () => boolean;

  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  /** 连接代数：forceReconnect / close 弃用进行中的连接尝试时递增，旧尝试据此放弃，不再占用 this.ws */
  private connectGen = 0;
  /** 让进行中的 connect() promise 转而等待新连接（forceReconnect）或以错误结束（close） */
  private abandonConnect: ((error?: Error) => void) | null = null;
  private _state: SidecarConnectionState = "idle";
  private pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private intentionalClose = false;
  private autoReconnect = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private openedOnce = false;
  private _currentUrl: string | null = null;
  private _terminalError: SidecarTerminalError | null = null;
  private _lastError: string | null = null;

  private wakeListenersInstalled = false;
  private wakeWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastWakeTickAt = 0;
  private boundOnline: (() => void) | null = null;
  private boundVisibility: (() => void) | null = null;
  private boundNetworkChange: (() => void) | null = null;
  private lastActivityAt = 0;
  private probing: Promise<void> | null = null;
  private syncDepth = 0;
  private unsubscribeSystemResume: (() => void) | null = null;

  /** 已收到的用户消息：clientMessageId → turnId（空串 = 事件没带 turnId），FIFO 淘汰 */
  private deliveredMessages = new Map<string, string>();

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
  private scheduleChangedListeners = new Set<Listener<{ schedules: Schedule[]; paused: boolean }>>();
  private scheduleNoticeListeners = new Set<Listener<ScheduleNotice>>();
  private boardChangedListeners = new Set<Listener<{ projectPath: string; board: Board }>>();
  private groupChangedListeners = new Set<Listener<AgentGroup>>();
  private groupRemovedListeners = new Set<Listener<string>>();
  private remoteChangedListeners = new Set<Listener<RemoteStatus>>();
  private terminalListeners = new Set<Listener<SidecarTerminalError>>();
  private attentionListeners = new Set<Listener<AttentionNotice>>();
  private syncingListeners = new Set<Listener<boolean>>();

  constructor(options: SidecarClientOptions) {
    this.resolveUrl = options.resolveUrl;
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? RECONNECT_BASE_DELAY_MS;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? RECONNECT_MAX_DELAY_MS;
    this.wakeListenersEnabled = options.wakeListeners ?? true;
    this.historyLimit = options.historyLimit;
    this.livenessProbe = options.livenessProbe;
    this.isBackground =
      options.isBackground ?? (() => typeof document !== "undefined" && document.visibilityState !== "visible");
  }

  get state(): SidecarConnectionState {
    return this._state;
  }

  /** 最近一次成功建连使用的地址。 */
  get currentUrl(): string | null {
    return this._currentUrl;
  }

  /** 最近一次终止性关闭（凭据失效等）；成功建连或手动重连后清空。非 null 时不会自动重连。 */
  get terminalError(): SidecarTerminalError | null {
    return this._terminalError;
  }

  /** 最近一次建连 / 断线的原因（成功建连后清空），供 UI 展示。 */
  get lastError(): string | null {
    return this._lastError;
  }

  /** 重连后正在按 `sinceSeq` 补齐各会话（手机端据此显示「正在同步…」）；首次连接不算。 */
  get syncing(): boolean {
    return this.syncDepth > 0;
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

  /** `schedule.changed` 通知（调度表 / 运行记录变化，design.md 4.25）。 */
  onScheduleChanged(listener: Listener<{ schedules: Schedule[]; paused: boolean }>): () => void {
    return subscribe(this.scheduleChangedListeners, listener);
  }

  /** `board.changed` 通知（看板变化，design.md 4.28）。 */
  onBoardChanged(listener: Listener<{ projectPath: string; board: Board }>): () => void {
    return subscribe(this.boardChangedListeners, listener);
  }

  /** `schedule.notice` 通知（目标循环结束 / 定时任务失败，前端转系统通知，design.md 4.25）。 */
  onScheduleNotice(listener: Listener<ScheduleNotice>): () => void {
    return subscribe(this.scheduleNoticeListeners, listener);
  }

  /** `group.changed` 通知（协作组新建 / 状态 / 成员变化，design.md 4.27）。 */
  onGroupChanged(listener: Listener<AgentGroup>): () => void {
    return subscribe(this.groupChangedListeners, listener);
  }

  /** `group.removed` 通知（协作组被删除，参数为 groupId）。 */
  onGroupRemoved(listener: Listener<string>): () => void {
    return subscribe(this.groupRemovedListeners, listener);
  }

  /** `remote.changed` 通知（远程网关启停、设备配对 / 吊销 / 连接 / 断开，design.md 4.31）。 */
  onRemoteChanged(listener: Listener<RemoteStatus>): () => void {
    return subscribe(this.remoteChangedListeners, listener);
  }

  /** `client.attention` 通知（只发给远程客户端：完成 / 失败 / 待审批 / 调度，design.md 4.31）。 */
  onAttention(listener: Listener<AttentionNotice>): () => void {
    return subscribe(this.attentionListeners, listener);
  }

  /** 重连后补齐的开始 / 结束（订阅时立即回调当前值）。 */
  onSyncing(listener: Listener<boolean>): () => void {
    listener(this.syncing);
    return subscribe(this.syncingListeners, listener);
  }

  /** 终止性关闭（见 SIDECAR_TERMINAL_CLOSE_MIN）：已停止自动重连，需要用户介入。 */
  onTerminalError(listener: Listener<SidecarTerminalError>): () => void {
    return subscribe(this.terminalListeners, listener);
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
    debugBus.push({
      type: "sidecar",
      level: next === "error" ? "warn" : "info",
      summary: `sidecar 连接状态：${this._state} → ${next}`,
      payload: { from: this._state, to: next, reconnectAttempts: this.reconnectAttempts },
    });
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
    this._terminalError = null;

    const gen = ++this.connectGen;
    // 进行中的连接尝试被弃用（forceReconnect 换了 socket）时，旧 openSocket 里的回调都因 isCurrent() 为假而不再 settle；
    // 这里额外挂一个「弃用」出口，保证等待者一定会 settle：forceReconnect 时转去等新连接，close 时报错。
    const abandoned = new Promise<void>((resolve, reject) => {
      this.abandonConnect = (error) => {
        if (error) reject(error);
        else resolve(this.connect());
      };
    });
    const promise = Promise.race([this.openSocket(gen), abandoned]).finally(() => {
      if (this.connectPromise === promise) {
        this.connectPromise = null;
        this.abandonConnect = null;
      }
    });
    this.connectPromise = promise;
    return promise;
  }

  private async openSocket(gen: number): Promise<void> {
    this.setState("connecting");
    let url: string;
    try {
      url = await this.resolveUrl();
    } catch (error) {
      if (gen !== this.connectGen) throw new Error("连接尝试已被新的连接取代");
      this._lastError = error instanceof Error ? error.message : String(error);
      this.setState("error");
      this.scheduleReconnect();
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (gen !== this.connectGen) throw new Error("连接尝试已被新的连接取代");
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
        this._lastError = "连接 Agent 服务超时";
        this.setState("error");
        reject(new Error("连接 Agent 服务超时"));
        this.scheduleReconnect();
      }, this.connectTimeoutMs);

      ws.onopen = () => {
        if (!isCurrent() || settled) return;
        settled = true;
        clearTimeout(connectTimer);
        this.reconnectAttempts = 0;
        this._terminalError = null;
        this._lastError = null;
        this._currentUrl = url;
        this.lastActivityAt = Date.now();
        this.setState("open");
        resolve();
        void this.afterOpen();
      };

      const handleDrop = (message: string, terminal?: SidecarTerminalError) => {
        if (!isCurrent()) return;
        this.ws = null;
        clearTimeout(connectTimer);
        this.rejectPending(message, true);
        this._lastError = message;
        if (terminal) this._terminalError = terminal;
        if (!settled) {
          settled = true;
          this.setState("error");
          reject(terminal ?? new Error(message));
        } else {
          this.setState(terminal ? "error" : "closed");
        }
        try { ws.close(); } catch {}
        if (terminal) emitTo(this.terminalListeners, terminal);
        else if (!this.intentionalClose) this.scheduleReconnect();
      };

      ws.onclose = (event: CloseEvent) => {
        const code = typeof event?.code === "number" ? event.code : 0;
        if (code >= SIDECAR_TERMINAL_CLOSE_MIN && code <= SIDECAR_TERMINAL_CLOSE_MAX) {
          handleDrop("连接被拒绝", new SidecarTerminalError(code, event.reason ?? ""));
        } else {
          handleDrop(event?.reason || "与 Agent 服务的连接已断开");
        }
      };
      ws.onerror = () => handleDrop("无法连接 Agent 服务");
      ws.onmessage = (event: MessageEvent) => {
        if (!isCurrent()) return;
        this.lastActivityAt = Date.now();
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

  private rejectPending(message: string, connectionLost = false): void {
    this.pending.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject(connectionLost ? new SidecarConnectionLostError(message) : new Error(message));
    });
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (!this.autoReconnect || this.intentionalClose || this._terminalError) return;
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
    this._terminalError = null;
    const ws = this.ws;
    if (ws || this.connectPromise) {
      this.ws = null;
      this.connectPromise = null;
      this.connectGen += 1;
      const abandon = this.abandonConnect;
      this.abandonConnect = null;
      this.rejectPending("与 Agent 服务的连接已断开", true);
      if (ws) {
        try { ws.close(); } catch {}
      }
      this.setState("closed");
      this.connect().catch(() => {});
      // 旧连接尝试的等待者转去等刚发起的新连接（须在 connect() 之后调用）
      abandon?.();
      return;
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
    this.connectGen += 1;
    const abandon = this.abandonConnect;
    this.abandonConnect = null;
    abandon?.(new Error("连接已关闭"));
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
    const desktop = window.agentdeckDesktop;
    if (typeof desktop?.onSystemResume === "function") {
      this.unsubscribeSystemResume = desktop.onSystemResume(() => this.handleWake(true));
    }
    this.lastWakeTickAt = Date.now();
    this.wakeWatchdogTimer = setInterval(() => {
      const now = Date.now();
      const gap = now - this.lastWakeTickAt;
      this.lastWakeTickAt = now;
      if (gap > WAKE_GAP_THRESHOLD_MS) {
        // 手机端后台：定时器被限速造成的跳变不等于系统休眠，不强制重连，连着就探活（3 秒无回应才重连）
        const throttledInBackground = this.livenessProbe !== undefined && this.isBackground();
        this.handleWake(!throttledInBackground);
      }
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
    // 移动网络 / Wi-Fi 切换（Network Information API）：只在配置了探活时监听，桌面行为不变
    const connection = this.livenessProbe ? networkInformation() : null;
    if (connection) {
      this.boundNetworkChange = () => this.handleWake(false);
      connection.addEventListener("change", this.boundNetworkChange);
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
    if (this.boundNetworkChange) {
      networkInformation()?.removeEventListener("change", this.boundNetworkChange);
      this.boundNetworkChange = null;
    }
    this.unsubscribeSystemResume?.();
    this.unsubscribeSystemResume = null;
  }

  /** 外部（手机端的原生前后台状态）认为 App 刚回到前台：与 `online` / `visibilitychange` 同一路径，连着就探活，断着就重连 */
  hintWake(): void {
    this.handleWake(false);
  }

  private handleWake(forceful: boolean): void {
    if (!this.autoReconnect || this.intentionalClose || this._terminalError) return;
    if (!forceful && this.ws?.readyState === SOCKET_OPEN) {
      if (this.livenessProbe) void this.probeIfIdle();
      return;
    }
    this.forceReconnect(forceful ? "wake" : "hint");
  }

  /**
   * 回前台 / 网络恢复时的死连接探测（需配置 `livenessProbe`）：距最后一次收到数据不足 `idleMs` 视为健康；
   * 否则发 `sidecar.info`，超时（对端无任何回应）即强制重连。对端回了 RPC 错误也说明连接是活的。
   */
  probeIfIdle(): Promise<void> {
    const probe = this.livenessProbe;
    const ws = this.ws;
    if (!probe || !ws || ws.readyState !== SOCKET_OPEN || this._state !== "open") return Promise.resolve();
    if (this.probing) return this.probing;
    if (Date.now() - this.lastActivityAt < probe.idleMs) return Promise.resolve();
    const run = (async () => {
      try {
        await this.sendRequest("sidecar.info", {}, { timeoutMs: probe.timeoutMs });
      } catch (error) {
        if (error instanceof SidecarRpcError) return;
        // 探测期间已经断线 / 换了连接：由 onclose 与重连流程处理
        if (this.ws !== ws) return;
        debugBus.push({
          type: "sidecar",
          level: "warn",
          summary: "连接探活无回应，强制重连",
          payload: { idleMs: Date.now() - this.lastActivityAt },
        });
        this.forceReconnect("probe");
      }
    })().finally(() => {
      if (this.probing === run) this.probing = null;
    });
    this.probing = run;
    return run;
  }

  // ── 请求 ────────────────────────────────────────────────────────────────

  async request<M extends AgentRpcMethodName>(
    method: M,
    ...args: RequestArgs<M>
  ): Promise<AgentRpcResult<M>> {
    try {
      return await this.sendRequest(method, ...args);
    } catch (error) {
      // 旁路记录到调试事件（Debug 面板），不改变错误本身
      debugBus.push({
        type: "sidecar",
        level: "error",
        summary: `RPC 失败 ${method}：${error instanceof Error ? error.message : String(error)}`,
        payload: {
          method,
          code: error instanceof SidecarRpcError ? error.code : undefined,
          businessCode: error instanceof SidecarRpcError ? error.businessCode : undefined,
          message: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  private async sendRequest<M extends AgentRpcMethodName>(
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
    if (record.method === AGENT_RPC_NOTIFICATIONS.scheduleChanged && record.params) {
      emitTo(this.scheduleChangedListeners, record.params as { schedules: Schedule[]; paused: boolean });
      return;
    }
    if (record.method === AGENT_RPC_NOTIFICATIONS.scheduleNotice && record.params) {
      emitTo(this.scheduleNoticeListeners, record.params as ScheduleNotice);
      return;
    }
    if (record.method === AGENT_RPC_NOTIFICATIONS.boardChanged && record.params) {
      emitTo(this.boardChangedListeners, record.params as { projectPath: string; board: Board });
      return;
    }
    if (record.method === AGENT_RPC_NOTIFICATIONS.groupChanged && record.params) {
      const group = (record.params as { group?: AgentGroup }).group;
      if (group) emitTo(this.groupChangedListeners, group);
      return;
    }
    if (record.method === AGENT_RPC_NOTIFICATIONS.groupRemoved && record.params) {
      const groupId = (record.params as { groupId?: unknown }).groupId;
      if (typeof groupId === "string") emitTo(this.groupRemovedListeners, groupId);
      return;
    }
    if (record.method === AGENT_RPC_NOTIFICATIONS.remoteChanged && record.params) {
      emitTo(this.remoteChangedListeners, record.params as RemoteStatus);
      return;
    }
    if (record.method === AGENT_RPC_NOTIFICATIONS.clientAttention && record.params) {
      emitTo(this.attentionListeners, record.params as AttentionNotice);
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
      tracker = { oldestSeq: 0, hasOlder: false, lastSeq: 0, syncing: null, buffer: [] };
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
    if (tracker.oldestSeq === 0) {
      tracker.oldestSeq = envelope.seq;
      tracker.hasOlder = envelope.seq > 1;
    }
    tracker.lastSeq = envelope.seq;
    this.rememberUserMessage(envelope);
    const meta: SidecarStreamMeta = { replay };
    for (const listener of [...this.streamListeners]) {
      try {
        listener(envelope, meta);
      } catch (error) {
        console.error("[sidecar-client] 订阅回调出错", error);
      }
    }
  }

  private rememberUserMessage(envelope: AgentStreamEnvelope): void {
    const event = envelope.event;
    if (event.type !== "timeline" || event.item.type !== "user_message" || !event.item.clientMessageId) return;
    this.deliveredMessages.set(event.item.clientMessageId, event.turnId ?? "");
    if (this.deliveredMessages.size > DELIVERED_MESSAGE_LIMIT) {
      this.deliveredMessages.delete(this.deliveredMessages.keys().next().value as string);
    }
  }

  /**
   * `agent.send` / `agent.steer` 因连接断开失败（`SidecarConnectionLostError`）后调用：重连并按 `sinceSeq` 补齐该会话时间线，
   * 看里面有没有带这个 `clientMessageId` 的 `user_message`（sidecar 写入时间线时原样带上，design.md 4.3）。
   * 有 = 服务端其实已收到并开始处理，返回其 turnId；没有 = 确实没发出去，返回 null。重连失败或超过 `timeoutMs` 时抛出（结果仍然未知）。
   */
  async confirmUserMessage(
    agentId: string,
    clientMessageId: string,
    timeoutMs = CONFIRM_USER_MESSAGE_TIMEOUT_MS,
  ): Promise<{ turnId: string } | null> {
    if (!this.deliveredMessages.has(clientMessageId)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("核对消息是否送达超时")), timeoutMs);
      });
      try {
        await Promise.race([(async () => {
          await this.connect();
          await this.syncAgent(agentId);
        })(), timeout]);
      } finally {
        clearTimeout(timer);
      }
    }
    const turnId = this.deliveredMessages.get(clientMessageId);
    return turnId === undefined ? null : { turnId };
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
    if (sinceSeq === 0 && this.historyLimit) {
      // 手机端：只取最近一页（页首对齐到回合起点），更早的历史由 fetchOlder 向前翻
      const page = await this.request("agent.timeline", { agentId, limit: this.historyLimit });
      this.noteEpoch(page.epoch);
      const entries = [...page.entries].sort(bySeq);
      for (const envelope of entries) this.deliver(envelope, true);
      const tracker = this.trackers.get(agentId);
      if (tracker && entries.length > 0) tracker.hasOlder = page.hasOlder === true;
      return;
    }
    const result = await this.request("agent.timeline", { agentId, sinceSeq });
    if (this.noteEpoch(result.epoch) && sinceSeq > 0) {
      // 旧序号已作废：按新 epoch 从头拉一次
      const full = await this.request("agent.timeline", { agentId, sinceSeq: 0 });
      for (const envelope of [...full.entries].sort(bySeq)) this.deliver(envelope, true);
      return;
    }
    for (const envelope of [...result.entries].sort(bySeq)) this.deliver(envelope, true);
  }

  /** 本地时间线的向前翻页状态（最早已取到的 seq / sidecar 上是否还有更早条目）。 */
  historyState(agentId: string): { oldestSeq: number; hasOlder: boolean } {
    const tracker = this.trackers.get(agentId);
    return { oldestSeq: tracker?.oldestSeq ?? 0, hasOlder: tracker?.hasOlder ?? false };
  }

  /**
   * 向前取更早的一页（`agent.timeline { beforeSeq, limit }`）。返回升序条目，**不**经 onStream 投递
   * （reducer 只能向后追加），由调用方把它们作为历史前插；页首对齐到回合起点，因此每页都是完整回合。
   */
  async fetchOlder(agentId: string, limit: number): Promise<{ entries: AgentStreamEnvelope[]; hasOlder: boolean }> {
    const tracker = this.trackers.get(agentId);
    if (!tracker || tracker.oldestSeq <= 1 || !tracker.hasOlder) {
      return { entries: [], hasOlder: false };
    }
    const page = await this.request("agent.timeline", { agentId, beforeSeq: tracker.oldestSeq, limit });
    const entries = [...page.entries].sort(bySeq);
    const current = this.trackers.get(agentId);
    if (current && entries.length > 0) current.oldestSeq = Math.min(current.oldestSeq, entries[0]!.seq);
    const hasOlder = page.hasOlder === true && entries.length > 0;
    if (current) current.hasOlder = hasOlder;
    return { entries, hasOlder };
  }

  /** 拉取 `agent.list` 并通知订阅方。 */
  async refreshAgents(): Promise<AgentSnapshot[]> {
    const { agents } = await this.request("agent.list");
    emitTo(this.agentsListeners, agents);
    return agents;
  }

  private setSyncDepth(delta: number): void {
    const before = this.syncing;
    this.syncDepth = Math.max(0, this.syncDepth + delta);
    if (before !== this.syncing) emitTo(this.syncingListeners, this.syncing);
  }

  private async afterOpen(): Promise<void> {
    const reconnect = this.openedOnce;
    this.openedOnce = true;
    if (reconnect) this.setSyncDepth(1);
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
    } finally {
      if (reconnect) this.setSyncDepth(-1);
    }
  }
}

function networkInformation(): EventTarget | null {
  if (typeof navigator === "undefined") return null;
  const connection = (navigator as Navigator & { connection?: EventTarget }).connection;
  return connection && typeof connection.addEventListener === "function" ? connection : null;
}

// ── 单例与注入 ────────────────────────────────────────────────────────────

/** 桌面 Rust 壳上报的 sidecar 状态（`get_sidecar_config` / `sidecar-status` 事件）。 */
export interface SidecarStatusPayload {
  wsUrl: string;
  token: string;
  version: string | null;
  status: "starting" | "ready" | "failed" | "stopped";
  error: string | null;
  /** sidecar 进程 pid，未运行时为 null（design.md 3.4） */
  pid: number | null;
}

/**
 * 各入口注册自己的连接方式：桌面入口注册 `createDesktopSidecarClient`（lib/sidecar-desktop.ts，
 * 走 Tauri `get_sidecar_config`），手机入口直接注入已建好的远程连接客户端。
 * 未注册时 `getSidecarClient()` 抛错，避免误用桌面命令。
 */
export type SidecarClientConfig = { client: SidecarClient | null } | { create: () => SidecarClient };

let instance: SidecarClient | null = null;
let factory: (() => SidecarClient) | null = null;

export function configureSidecarClient(config: SidecarClientConfig): void {
  if ("create" in config) {
    factory = config.create;
    instance = null;
  } else {
    factory = null;
    instance = config.client;
  }
}

export function getSidecarClient(): SidecarClient {
  if (instance) return instance;
  if (!factory) {
    throw new Error("尚未配置 Agent 服务连接：入口需先调用 configureSidecarClient()");
  }
  instance = factory();
  return instance;
}

/** 测试用：替换或清空单例（等价于 `configureSidecarClient({ client })`）。 */
export function __setSidecarClientForTests(client: SidecarClient | null): void {
  configureSidecarClient({ client });
}
