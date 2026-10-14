// 握手与帧格式参照 paseo packages/relay/src/{crypto,encrypted-channel}.ts（Apache-2.0）；见 @agentdeck/remote
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import {
  deriveSharedKey,
  E2eeChannel,
  FrameError,
  importPublicKey,
  MAX_PLAINTEXT_BYTES,
  parseClientAuthMessage,
  parseE2eeHello,
  toBase64,
  type AuthFailedReason,
  type ClientAuthMessage,
  type KeyPair,
  type ServerAuthReply,
} from "@agentdeck/remote";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import { createSilentLogger, type Logger } from "../logger.js";
import type { RpcConnectionHandle } from "../server/rpc-server.js";
import type { RpcClientConnection } from "../server/client-connection.js";
import type { PairingManager } from "./pairing.js";
import { sha256Hex, type RemoteStore } from "./store.js";

export const REMOTE_PATH = "/remote";
/** 认证后单个 WS 帧最大长度 = 明文上限 + nonce(24) + 认证标签(16) */
const MAX_FRAME_BYTES = MAX_PLAINTEXT_BYTES + 24 + 16;
/** 单连接发送缓冲超过该值视为接收端卡死，直接断开 */
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;

export interface RemoteGatewayTuning {
  /** 连接建立后必须在该时间内完成认证（默认 10 秒） */
  authTimeoutMs: number;
  /** 同一来源 IP 连续认证失败多少次后进入冷却（默认 5） */
  maxAuthFailures: number;
  /** 冷却时长（默认 60 秒） */
  cooldownMs: number;
  /** WS ping 间隔，用于发现手机网络切换后的死连接（默认 30 秒；连续 2 次无 pong 才终止） */
  pingIntervalMs: number;
  /** 未完成认证的连接数上限（默认 32） */
  maxPendingConnections: number;
  /** 单条下行明文（JSON-RPC 响应 / 通知）上限，超过则回 RESPONSE_TOO_LARGE 错误或丢弃通知（默认 16 MiB，即加密帧上限） */
  maxPlaintextBytes: number;
}

export const DEFAULT_GATEWAY_TUNING: RemoteGatewayTuning = {
  authTimeoutMs: 10_000,
  maxAuthFailures: 5,
  cooldownMs: 60_000,
  pingIntervalMs: 30_000,
  maxPendingConnections: 32,
  maxPlaintextBytes: MAX_PLAINTEXT_BYTES,
};

export interface RemoteGatewayOptions {
  keyPair: KeyPair;
  store: RemoteStore;
  pairing: PairingManager;
  /** 认证成功时回给手机的电脑名称 */
  computerName: () => string;
  /** 把认证后的连接接入 RpcServer */
  attach: (connection: RpcClientConnection) => RpcConnectionHandle;
  /** 设备连接 / 断开 / 配对成功时回调（用于广播 remote.changed） */
  onChange?: () => void;
  logger?: Logger;
  now?: () => number;
  tuning?: Partial<RemoteGatewayTuning>;
}

/** 认证后的远程连接：RpcServer 看到的是明文 JSON，加解密都在这里 */
class RemoteConnection implements RpcClientConnection {
  readonly kind = "remote" as const;

  constructor(
    readonly deviceId: string,
    private readonly ws: WebSocket,
    private readonly channel: E2eeChannel,
    private readonly drop: (code: number, reason: string, path: RemoteDropPath) => void,
    private readonly logger: Logger,
    private readonly maxPlaintextBytes: number,
  ) {}

  send(payload: string): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.drop(1013, "接收过慢", "buffer-overflow");
      return;
    }
    const bytes = Buffer.byteLength(payload, "utf8");
    if (bytes > this.maxPlaintextBytes) {
      this.rejectOversize(payload, bytes);
      return;
    }
    try {
      this.ws.send(this.channel.seal(payload));
    } catch (error) {
      // 加密失败等：丢弃这条，不影响连接
      this.logger.warn("远程帧发送失败（%d 字节）：%s", bytes, String(error));
    }
  }

  /**
   * 明文超过帧上限：带 id 的 JSON-RPC 响应改发同 id 的 `RESPONSE_TOO_LARGE` 错误，让手机端那条请求立即失败（而不是挂到 120 秒超时）；
   * 通知（无 id）无法回错，只记日志。
   */
  private rejectOversize(payload: string, bytes: number): void {
    let id: string | number | null = null;
    let method: string | undefined;
    try {
      const parsed = JSON.parse(payload) as { id?: unknown; method?: unknown };
      if (typeof parsed.id === "string" || typeof parsed.id === "number") {
        id = parsed.id;
      }
      if (typeof parsed.method === "string") {
        method = parsed.method;
      }
    } catch {
      // 无法解析：当作无 id 的通知处理
    }
    this.logger.warn(
      "远程下行消息过大，未发送（device=%s %d 字节，上限 %d，method=%s id=%s）%s",
      this.deviceId.slice(0, 8),
      bytes,
      this.maxPlaintextBytes,
      method ?? "-",
      id === null ? "-" : String(id),
      id === null ? "" : "，已改发错误响应",
    );
    if (id === null) {
      return;
    }
    const mb = (bytes / 1024 / 1024).toFixed(1);
    const reply = JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: `响应过大（${mb} MiB），超过远程传输上限，已放弃发送。请缩小请求范围后重试`,
        data: { code: "RESPONSE_TOO_LARGE" },
      },
    });
    try {
      this.ws.send(this.channel.seal(reply));
    } catch (error) {
      this.logger.warn("发送 RESPONSE_TOO_LARGE 错误响应失败：%s", String(error));
    }
  }

  /** RpcServer 关闭时调用 */
  close(): void {
    this.drop(1000, "closed", "shutdown");
  }

  /** 吊销设备等本端主动断开 */
  closeBecause(path: RemoteDropPath): void {
    this.drop(1000, "closed", path);
  }
}

/**
 * 本端关闭连接的路径（写入「远程连接关闭」日志的 path 字段，定位断线原因，design.md 4.31「断线诊断」）。
 * 日志里没有 path（`peer-close`）表示对端先关闭或网络层断开。
 */
export type RemoteDropPath =
  | "auth-timeout"
  | "auth-failed"
  | "bad-hello"
  | "binary-in-hello"
  | "bad-frame"
  | "internal-error"
  | "pong-timeout"
  | "buffer-overflow"
  | "revoked"
  | "gateway-stop"
  | "shutdown";

/** 每条已升级 WS 的心跳 / 诊断状态 */
interface SocketState {
  ip: string;
  openedAt: number;
  lastPongAt: number;
  /** 已发出 ping 但仍未收到 pong 的连续次数，收到 pong 清零 */
  missedPongs: number;
  /** 认证成功后才有 */
  deviceId?: string;
  /** 本端主动关闭 / 终止的路径；未设置表示对端先关闭 */
  path?: RemoteDropPath;
}

/** 连续这么多次 ping 没收到 pong 才终止连接（单次丢失 / 手机主线程繁忙不算死） */
const MAX_MISSED_PONGS = 2;

interface FailureRecord {
  count: number;
  cooldownUntil: number;
}

function normalizeIp(address: string | undefined): string {
  if (!address) {
    return "unknown";
  }
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function safeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * 远程网关（design.md 4.31）：独立 HTTP 服务，只接受 `GET /remote` 的 WS 升级。
 * 每条连接先走明文 e2ee_hello / e2ee_ready，之后只允许加密二进制帧；
 * 认证成功后接入 RpcServer，与本机 WS 客户端同样收发 JSON-RPC 并收到全部广播。
 */
export class RemoteGateway {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly tuning: RemoteGatewayTuning;
  private readonly failures = new Map<string, FailureRecord>();
  private readonly sockets = new Map<WebSocket, SocketState>();
  private readonly connections = new Set<RemoteConnection>();
  private pending = 0;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: RemoteGatewayOptions) {
    this.logger = options.logger ?? createSilentLogger();
    this.now = options.now ?? Date.now;
    this.tuning = { ...DEFAULT_GATEWAY_TUNING, ...options.tuning };
    this.http = createServer((_req, res) => {
      // 不提供 /health 等任何明文端点
      res.writeHead(404, { "content-length": "0", connection: "close" });
      res.end();
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
    this.http.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.wss.on("connection", (ws, req) => this.serve(ws, normalizeIp(req.socket.remoteAddress)));
  }

  /** 监听并返回实际端口；端口被占用等错误以 reject 抛出 */
  listen(port: number, host = "0.0.0.0"): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.http.once("error", onError);
      this.http.listen(port, host, () => {
        this.http.off("error", onError);
        this.pingTimer = setInterval(() => this.pingAll(), this.tuning.pingIntervalMs);
        this.pingTimer.unref();
        resolve((this.http.address() as AddressInfo).port);
      });
    });
  }

  async close(): Promise<void> {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const [ws, state] of this.sockets) {
      state.path ??= "gateway-stop";
      ws.terminate();
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => {
      this.http.close(() => resolve());
      this.http.closeAllConnections();
    });
  }

  isDeviceConnected(deviceId: string): boolean {
    for (const connection of this.connections) {
      if (connection.deviceId === deviceId) {
        return true;
      }
    }
    return false;
  }

  /** 断开某设备的全部连接，返回断开数量（吊销设备时调用） */
  disconnectDevice(deviceId: string): number {
    let count = 0;
    for (const connection of Array.from(this.connections)) {
      if (connection.deviceId === deviceId) {
        connection.closeBecause("revoked");
        count += 1;
      }
    }
    return count;
  }

  // -------------------------------------------------------------------------

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== REMOTE_PATH) {
      this.rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    const ip = normalizeIp(req.socket.remoteAddress);
    if (this.isCoolingDown(ip)) {
      this.rejectUpgrade(socket, 429, "Too Many Requests");
      return;
    }
    if (this.pending >= this.tuning.maxPendingConnections) {
      this.rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit("connection", ws, req);
    });
  }

  private rejectUpgrade(socket: Duplex, status: number, reason: string): void {
    try {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } finally {
      socket.destroy();
    }
  }

  private isCoolingDown(ip: string): boolean {
    const record = this.failures.get(ip);
    return record !== undefined && this.now() < record.cooldownUntil;
  }

  private recordFailure(ip: string): void {
    const now = this.now();
    if (this.failures.size > 1_000) {
      for (const [key, record] of this.failures) {
        if (record.cooldownUntil <= now && record.count === 0) {
          this.failures.delete(key);
        }
      }
    }
    const record = this.failures.get(ip) ?? { count: 0, cooldownUntil: 0 };
    record.count += 1;
    if (record.count >= this.tuning.maxAuthFailures) {
      record.count = 0;
      record.cooldownUntil = now + this.tuning.cooldownMs;
      this.logger.warn("远程认证连续失败 %d 次，来源 %s 冷却 %d 秒", this.tuning.maxAuthFailures, ip, this.tuning.cooldownMs / 1000);
    }
    this.failures.set(ip, record);
  }

  private pingAll(): void {
    for (const [ws, state] of this.sockets) {
      if (state.missedPongs >= MAX_MISSED_PONGS) {
        const now = this.now();
        this.logger.warn(
          "远程连接连续 %d 次心跳无响应，终止（device=%s ip=%s 存活=%ds 距上次pong=%dms）",
          MAX_MISSED_PONGS,
          state.deviceId?.slice(0, 8) ?? "-",
          state.ip,
          Math.round((now - state.openedAt) / 1000),
          now - state.lastPongAt,
        );
        state.path ??= "pong-timeout";
        ws.terminate();
        continue;
      }
      state.missedPongs += 1;
      try {
        ws.ping();
      } catch {
        state.path ??= "pong-timeout";
        ws.terminate();
      }
    }
  }

  /** 处理一条已升级的连接：握手 → 认证 → 转交 RpcServer */
  private serve(ws: WebSocket, ip: string): void {
    const openedAt = this.now();
    const state: SocketState = { ip, openedAt, lastPongAt: openedAt, missedPongs: 0 };
    this.sockets.set(ws, state);
    ws.on("pong", () => {
      state.missedPongs = 0;
      state.lastPongAt = this.now();
    });

    type Phase = "hello" | "auth" | "authenticating" | "ready" | "closed";
    let phase: Phase = "hello";
    let channel: E2eeChannel | null = null;
    let challenge = "";
    let handle: RpcConnectionHandle | null = null;
    let connection: RemoteConnection | null = null;
    let countedPending = true;
    this.pending += 1;

    const leavePending = () => {
      if (countedPending) {
        countedPending = false;
        this.pending -= 1;
      }
    };

    const drop = (code: number, reason: string, path: RemoteDropPath) => {
      state.path ??= path;
      if (phase !== "closed") {
        phase = "closed";
      }
      try {
        ws.close(code, reason);
      } catch {
        ws.terminate();
        return;
      }
      // 对端不配合关闭握手时强制终止
      setTimeout(() => ws.terminate(), 1_000).unref();
    };

    const authTimer = setTimeout(() => {
      if (phase !== "ready" && phase !== "closed") {
        this.logger.warn("远程连接认证超时（来源 %s）", ip);
        drop(1008, "认证超时", "auth-timeout");
      }
    }, this.tuning.authTimeoutMs);
    authTimer.unref();

    const sendReply = (reply: ServerAuthReply) => {
      if (channel && ws.readyState === WebSocket.OPEN) {
        ws.send(channel.seal(JSON.stringify(reply)));
      }
    };

    const failAuth = (reason: AuthFailedReason) => {
      this.recordFailure(ip);
      this.logger.warn("远程认证失败（来源 %s，原因 %s）", ip, reason);
      try {
        sendReply({ type: "auth_failed", reason });
      } catch {
        // 连接已断
      }
      drop(1008, "认证失败", "auth-failed");
    };

    const completeAuth = (deviceId: string, reply: ServerAuthReply) => {
      clearTimeout(authTimer);
      leavePending();
      state.deviceId = deviceId;
      const conn = new RemoteConnection(
        deviceId,
        ws,
        channel!,
        drop,
        this.logger,
        this.tuning.maxPlaintextBytes,
      );
      connection = conn;
      this.connections.add(conn);
      phase = "ready";
      sendReply(reply);
      handle = this.options.attach(conn);
      this.failures.delete(ip);
      this.options.onChange?.();
    };

    const authenticate = async (message: ClientAuthMessage): Promise<void> => {
      if (!safeEqualString(message.challenge, challenge)) {
        failAuth("invalid");
        return;
      }
      const { store, pairing } = this.options;
      if (message.type === "pair") {
        const result = pairing.consume(message.pairingSecret);
        if (result !== "ok") {
          failAuth(result);
          return;
        }
        const deviceSecret = randomBytes(32).toString("base64");
        let deviceId: string;
        try {
          ({ deviceId } = await store.addDevice({
            name: message.deviceName,
            secretSha256: sha256Hex(deviceSecret),
            now: this.now(),
          }));
        } catch (error) {
          this.logger.error("保存配对设备失败：%s", String(error));
          drop(1011, "内部错误", "internal-error");
          return;
        }
        if (phase === "closed") {
          return;
        }
        this.logger.info("设备已配对（deviceId=%s，名称=%s）", deviceId, message.deviceName);
        completeAuth(deviceId, { type: "paired", deviceId, deviceSecret });
        return;
      }
      const device = store.find(message.deviceId);
      if (!device) {
        failAuth("invalid");
        return;
      }
      let matches = false;
      try {
        matches = timingSafeEqual(
          Buffer.from(sha256Hex(message.deviceSecret), "hex"),
          Buffer.from(device.secretSha256, "hex"),
        );
      } catch {
        matches = false;
      }
      if (!matches) {
        failAuth("invalid");
        return;
      }
      if (device.revokedAt !== undefined) {
        failAuth("revoked");
        return;
      }
      completeAuth(device.deviceId, { type: "authed", name: this.options.computerName() });
      void store.touch(device.deviceId, this.now()).catch((error: unknown) => {
        this.logger.warn("更新设备最近在线时间失败：%s", String(error));
      });
    };

    ws.on("message", (data, isBinary) => {
      if (phase === "closed") {
        return;
      }
      if (phase === "hello") {
        if (isBinary) {
          drop(1008, "首帧必须是文本", "binary-in-hello");
          return;
        }
        const hello = parseE2eeHello(toBytesToString(data));
        if (!hello) {
          drop(1008, "握手格式错误", "bad-hello");
          return;
        }
        try {
          channel = new E2eeChannel(
            deriveSharedKey(this.options.keyPair.secretKey, importPublicKey(hello.clientKey)),
            "server",
          );
        } catch {
          drop(1008, "握手格式错误", "bad-hello");
          return;
        }
        challenge = toBase64(randomBytes(32));
        ws.send(JSON.stringify({ type: "e2ee_ready", v: 1, challenge }));
        phase = "auth";
        return;
      }
      // 握手之后只允许加密二进制帧
      if (!isBinary) {
        drop(1008, "只允许二进制帧", "bad-frame");
        return;
      }
      if (phase === "authenticating") {
        drop(1008, "认证期间不允许发送其它帧", "bad-frame");
        return;
      }
      let text: string;
      try {
        text = channel!.openText(toBytes(data));
      } catch (error) {
        this.logger.warn(
          "远程帧非法，断开（来源 %s）：%s",
          ip,
          error instanceof FrameError ? error.code : "unknown",
        );
        drop(1008, "帧非法", "bad-frame");
        return;
      }
      if (phase === "auth") {
        const message = parseClientAuthMessage(text);
        if (!message) {
          failAuth("invalid");
          return;
        }
        phase = "authenticating";
        void authenticate(message).catch((error: unknown) => {
          this.logger.error("远程认证出错：%s", String(error));
          drop(1011, "内部错误", "internal-error");
        });
        return;
      }
      void handle?.receive(text);
    });

    ws.on("close", (code: number, reasonBuffer: Buffer) => {
      const closedAt = this.now();
      this.logger.info(
        "远程连接关闭 device=%s ip=%s 存活=%ds code=%d reason=%s by=%s path=%s 距上次pong=%dms buffered=%d",
        state.deviceId?.slice(0, 8) ?? "-",
        ip,
        Math.round((closedAt - state.openedAt) / 1000),
        code,
        reasonBuffer.toString("utf8") || "-",
        state.path ? "local" : "peer",
        state.path ?? "peer-close",
        closedAt - state.lastPongAt,
        ws.bufferedAmount,
      );
      clearTimeout(authTimer);
      leavePending();
      phase = "closed";
      this.sockets.delete(ws);
      if (connection) {
        this.connections.delete(connection);
        handle?.detach();
        const deviceId = connection.deviceId;
        void this.options.store.touch(deviceId, this.now()).catch((error: unknown) => {
          this.logger.warn("更新设备最近在线时间失败：%s", String(error));
        });
        this.options.onChange?.();
      }
    });
    ws.on("error", (error) => {
      this.logger.warn("远程 WS 连接错误：%s", error.message);
    });
  }
}

function toBytesToString(data: RawData): string {
  return Buffer.from(toBytes(data)).toString("utf8");
}
