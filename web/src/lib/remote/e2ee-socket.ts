// 远程网关的 E2EE socket（design.md 4.31）：对 SidecarClient 而言就是一条普通的 JSON 文本 WS。
//
// 内部对每个候选地址并发建一条 ws://host:port/remote，各自跑 @agentdeck/remote 的客户端握手状态机
// （hello → ready → 加密的 auth / pair），采用第一个认证成功的连接，其余立即关闭。
// 认证被拒（expired / invalid / revoked）以终止性关闭码 4401 + reason 上报，SidecarClient 据此停止自动重连。
import {
  createRemoteClientSession,
  type AuthFailedReason,
  type RemoteClientCredentials,
  type RemoteClientSession,
} from "@agentdeck/remote";
import type { ConnectionEventLog } from "@/lib/connection-log";

/** 认证失败的终止性关闭码（落在 sidecar-client 的 4400–4499 终止区间内），reason 为 AuthFailedReason。 */
export const E2EE_AUTH_FAILED_CLOSE_CODE = 4401;

export interface RemoteAddressRef {
  host: string;
  port: number;
}

export function addressKey(address: RemoteAddressRef): string {
  return `${address.host}:${address.port}`;
}

export function addressUrl(address: RemoteAddressRef): string {
  const host = address.host.includes(":") && !address.host.startsWith("[") ? `[${address.host}]` : address.host;
  return `ws://${host}:${address.port}/remote`;
}

/** 底层 socket 的最小形状（浏览器 WebSocket 与测试里的 ws 包都满足） */
export interface RawSocket {
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface E2eeSocketOptions {
  /** 候选地址；若 `lastAddress` 在其中则优先尝试 */
  addresses: RemoteAddressRef[];
  lastAddress?: RemoteAddressRef | null;
  credentials: RemoteClientCredentials;
  /** 默认 `new WebSocket(url)` */
  createSocket?: (url: string) => RawSocket;
  /** 有 lastAddress 时，其余地址晚这么久才开始尝试（默认 300ms） */
  staggerMs?: number;
  /** 单个地址从发起到认证成功的上限（默认 10s，与网关的认证超时一致） */
  attemptTimeoutMs?: number;
  /** 认证 / 配对成功并选定地址后回调（用来记住 lastAddress） */
  onAddressSelected?: (address: RemoteAddressRef) => void;
  /** 配对成功：deviceSecret 只出现这一次，调用方必须立即保存 */
  onPaired?: (result: { deviceId: string; deviceSecret: string; address: RemoteAddressRef }) => void;
  /** 连接事件环形缓冲（手机端注入）：每个地址尝试的结果与耗时、赢家连接的协议错误 */
  eventLog?: ConnectionEventLog;
}

const READY_STATE = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } as const;

type Failure = { kind: "auth"; reason: AuthFailedReason } | { kind: "network"; message: string };

interface Attempt {
  address: RemoteAddressRef;
  socket: RawSocket | null;
  session: RemoteClientSession | null;
  timer: ReturnType<typeof setTimeout> | null;
  startTimer: ReturnType<typeof setTimeout> | null;
  done: boolean;
  /** 发起连接的时刻（用于记录耗时） */
  startedAt: number;
}

export class E2eeSocket {
  static readonly CONNECTING = READY_STATE.CONNECTING;
  static readonly OPEN = READY_STATE.OPEN;
  static readonly CLOSING = READY_STATE.CLOSING;
  static readonly CLOSED = READY_STATE.CLOSED;

  readyState: number = READY_STATE.CONNECTING;
  binaryType = "arraybuffer";
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  /** 最终选中的地址（OPEN 之后有值） */
  selectedAddress: RemoteAddressRef | null = null;

  private readonly attempts: Attempt[] = [];
  private readonly failures: Failure[] = [];
  private winner: Attempt | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly options: E2eeSocketOptions;

  constructor(options: E2eeSocketOptions) {
    this.options = options;
    // 异步启动：调用方（SidecarClient）先挂好 on* 回调再开始
    queueMicrotask(() => this.start());
  }

  private start(): void {
    if (this.readyState !== READY_STATE.CONNECTING) return;
    const { addresses, lastAddress } = this.options;
    if (addresses.length === 0) {
      this.finishClosed(1006, "没有可用地址");
      return;
    }
    const preferredKey = lastAddress ? addressKey(lastAddress) : null;
    const hasPreferred = preferredKey !== null && addresses.some((a) => addressKey(a) === preferredKey);
    const stagger = this.options.staggerMs ?? 300;
    for (const { host, port } of addresses) {
      const address = { host, port };
      const attempt: Attempt = {
        address,
        socket: null,
        session: null,
        timer: null,
        startTimer: null,
        done: false,
        startedAt: 0,
      };
      this.attempts.push(attempt);
      const delay = hasPreferred && addressKey(address) !== preferredKey ? stagger : 0;
      if (delay > 0) {
        attempt.startTimer = setTimeout(() => this.startAttempt(attempt), delay);
      } else {
        this.startAttempt(attempt);
      }
    }
  }

  private startAttempt(attempt: Attempt): void {
    attempt.startTimer = null;
    if (attempt.done || this.winner || this.readyState !== READY_STATE.CONNECTING) return;
    attempt.startedAt = Date.now();
    const timeout = this.options.attemptTimeoutMs ?? 10_000;
    attempt.timer = setTimeout(() => this.failAttempt(attempt, { kind: "network", message: "连接超时" }), timeout);
    let socket: RawSocket;
    try {
      socket = (this.options.createSocket ?? ((url) => new WebSocket(url) as unknown as RawSocket))(
        addressUrl(attempt.address),
      );
    } catch (error) {
      this.failAttempt(attempt, { kind: "network", message: error instanceof Error ? error.message : String(error) });
      return;
    }
    socket.binaryType = "arraybuffer";
    attempt.socket = socket;
    const session = createRemoteClientSession({
      credentials: this.options.credentials,
      send: (data) => socket.send(data),
      onMessage: (text) => {
        if (this.winner === attempt) this.onmessage?.({ data: text });
      },
      onPaired: (result) => {
        if (this.winner || this.readyState !== READY_STATE.CONNECTING) {
          this.disposeAttempt(attempt);
          return;
        }
        this.options.onPaired?.({ ...result, address: attempt.address });
        this.win(attempt);
      },
      onAuthed: () => this.win(attempt),
      onAuthFailed: (reason) => this.failAttempt(attempt, { kind: "auth", reason }),
      onProtocolError: (error) => {
        // 胜出之后的协议错误（解密失败 / 计数回退 / 文本帧）：会话已失效、后续入站帧都会被丢弃，
        // 必须真正关闭连接，让 SidecarClient 走正常的 onclose → 退避重连，不能留下半死连接
        if (this.winner === attempt) this.failWinner(error);
        else this.failAttempt(attempt, { kind: "network", message: error.message });
      },
    });
    attempt.session = session;
    socket.onopen = () => {
      try {
        session.start();
      } catch (error) {
        this.failAttempt(attempt, { kind: "network", message: error instanceof Error ? error.message : String(error) });
      }
    };
    socket.onmessage = (event) => {
      const data = event.data;
      if (typeof data === "string") session.handleFrame(data);
      else if (data instanceof ArrayBuffer) session.handleFrame(new Uint8Array(data));
      else if (ArrayBuffer.isView(data)) session.handleFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    };
    socket.onerror = () => {
      // 随后一定会有 close；失败统一在 onclose 里记
    };
    socket.onclose = (event) => {
      if (this.winner === attempt) {
        this.winner = null;
        this.finishClosed(event.code ?? 1006, event.reason ?? "");
        return;
      }
      this.failAttempt(attempt, { kind: "network", message: event.reason || "连接已关闭" });
    };
  }

  private win(attempt: Attempt): void {
    if (this.winner || this.readyState !== READY_STATE.CONNECTING) {
      // 已经有胜者（或已被关闭）：多余的连接直接丢弃
      this.disposeAttempt(attempt);
      return;
    }
    this.winner = attempt;
    this.options.eventLog?.push({
      event: "attempt-ok",
      address: addressKey(attempt.address),
      durationMs: Date.now() - attempt.startedAt,
    });
    this.clearGrace();
    this.selectedAddress = attempt.address;
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt.timer = null;
    for (const other of this.attempts) {
      if (other !== attempt) this.disposeAttempt(other);
    }
    this.options.onAddressSelected?.(attempt.address);
    this.readyState = READY_STATE.OPEN;
    this.onopen?.({});
  }

  private failAttempt(attempt: Attempt, failure: Failure): void {
    if (attempt.done) return;
    this.disposeAttempt(attempt);
    if (this.winner || this.readyState !== READY_STATE.CONNECTING) return;
    this.options.eventLog?.push({
      event: "attempt-fail",
      address: addressKey(attempt.address),
      durationMs: attempt.startedAt > 0 ? Date.now() - attempt.startedAt : 0,
      detail: failure.kind === "auth" ? `认证被拒：${failure.reason}` : failure.message,
    });
    if (failure.kind === "auth") {
      // 认证被拒是电脑用共享密钥加密回的，只有真正的电脑能发出，因此是定论，不必等其它（可能不可达的）地址超时；
      // 唯一例外：配对时一次性密钥可能已被并发的兄弟连接用掉，这里的 invalid 只是输家，稍等兄弟连接的结果
      if (this.options.credentials.mode === "auth" || failure.reason === "expired") {
        this.finishAuthFailed(failure.reason);
      } else if (!this.graceTimer) {
        this.graceTimer = setTimeout(() => this.finishAuthFailed(failure.reason), 1_500);
      }
      return;
    }
    this.failures.push(failure);
    // 有配对 invalid 在等兄弟连接的结果时，由 graceTimer 收尾
    if (!this.graceTimer && this.attempts.every((a) => a.done)) {
      const last = this.failures[this.failures.length - 1];
      this.finishClosed(1006, last?.kind === "network" ? last.message : "无法连接");
    }
  }

  private failWinner(error: Error): void {
    const winner = this.winner;
    if (!winner || this.readyState !== READY_STATE.OPEN) return;
    this.winner = null;
    winner.done = true;
    const socket = winner.socket;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try {
        socket.close(1011, "protocol_error");
      } catch {
        // 已关闭
      }
    }
    const code = (error as { code?: unknown }).code;
    const detail = typeof code === "string" ? code : error.message;
    this.options.eventLog?.push({
      event: "protocol-error",
      address: addressKey(winner.address),
      durationMs: Date.now() - winner.startedAt,
      detail,
    });
    this.finishClosed(1011, `protocol_error:${detail}`);
  }

  private finishAuthFailed(reason: AuthFailedReason): void {
    if (this.winner || this.readyState !== READY_STATE.CONNECTING) return;
    this.clearGrace();
    for (const other of this.attempts) this.disposeAttempt(other);
    this.finishClosed(E2EE_AUTH_FAILED_CLOSE_CODE, reason);
  }

  private clearGrace(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  private disposeAttempt(attempt: Attempt): void {
    attempt.done = true;
    if (attempt.timer) clearTimeout(attempt.timer);
    if (attempt.startTimer) clearTimeout(attempt.startTimer);
    attempt.timer = null;
    attempt.startTimer = null;
    const socket = attempt.socket;
    if (socket && this.winner !== attempt) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try {
        socket.close();
      } catch {
        // 已关闭
      }
    }
  }

  private finishClosed(code: number, reason: string): void {
    if (this.readyState === READY_STATE.CLOSED) return;
    this.readyState = READY_STATE.CLOSED;
    this.onclose?.({ code, reason, wasClean: code === 1000 });
  }

  send(data: string): void {
    const winner = this.winner;
    if (this.readyState !== READY_STATE.OPEN || !winner?.session) {
      throw new Error("远程连接未打开");
    }
    winner.session.sendText(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === READY_STATE.CLOSED || this.readyState === READY_STATE.CLOSING) return;
    this.readyState = READY_STATE.CLOSING;
    this.clearGrace();
    const winner = this.winner;
    for (const attempt of this.attempts) {
      if (attempt === winner) continue;
      this.disposeAttempt(attempt);
    }
    if (winner?.socket) {
      const socket = winner.socket;
      socket.onclose = null;
      this.winner = null;
      try {
        socket.close(code, reason);
      } catch {
        // 已关闭
      }
    }
    queueMicrotask(() => this.finishClosed(code, reason));
  }
}

/** 给 SidecarClient 的 socketFactory：地址列表与 lastAddress 每次建连时取最新值 */
export function createE2eeSocketFactory(
  getOptions: () => E2eeSocketOptions,
): (url: string) => WebSocket {
  return () => new E2eeSocket(getOptions()) as unknown as WebSocket;
}
