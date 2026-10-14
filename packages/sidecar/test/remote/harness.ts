import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentRpcErrorObject, RemoteAddress } from "@agentdeck/protocol";
import {
  createRemoteClientSession,
  decodeOfferUrl,
  deriveSharedKey,
  E2eeChannel,
  exportKey,
  generateKeyPair,
  importPublicKey,
  type AuthFailedReason,
  type RemoteClientCredentials,
  type RemoteClientSession,
  type RemoteConnectionOffer,
} from "@agentdeck/remote";
import { WebSocket } from "ws";

import { AgentManager } from "../../src/agent/agent-manager.js";
import { MockAgentClient } from "../../src/providers/mock/index.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { AttentionService } from "../../src/remote/attention.js";
import { PresenceTracker } from "../../src/remote/presence.js";
import { RemoteService } from "../../src/remote/service.js";
import type { RemoteGatewayTuning } from "../../src/remote/gateway.js";
import { RpcServer } from "../../src/server/rpc-server.js";
import { SettingsStore } from "../../src/settings/sidecar-settings.js";
import { TestRpcClient, type RawResponse } from "../rpc-test-client.js";

export const TOKEN = "test-token-0123456789abcdef";

/** 让测试自己拨动时间（配对过期、冷却、心跳窗口） */
export class FakeClock {
  constructor(public t = 1_700_000_000_000) {}
  now = () => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export const LAN_ADDRESS = (port: number): RemoteAddress[] => [{ host: "127.0.0.1", port, kind: "lan" }];

export interface HarnessOptions {
  /** 传 null = 不设数据目录 */
  dataDir?: string | null;
  tuning?: Partial<RemoteGatewayTuning>;
  addresses?: (port: number) => RemoteAddress[];
  /** 创建完后立即启用网关 */
  enable?: boolean;
}

export interface Harness {
  clock: FakeClock;
  dataDir: string | null;
  manager: AgentManager;
  server: RpcServer;
  remote: RemoteService;
  settings: SettingsStore;
  presence: PresenceTracker;
  /** 本机 /rpc 客户端（桌面） */
  local: TestRpcClient;
  localPort: number;
  /** 远程网关端口（启用后有效） */
  port: number;
  enable(port?: number): Promise<void>;
  /** 经本机 RPC 签发配对并解码 offer */
  newOffer(): Promise<RemoteConnectionOffer>;
  /** 配对一台新设备并保持连接 */
  pairPhone(deviceName?: string): Promise<{ phone: RemotePhone; deviceId: string; deviceSecret: string; offer: RemoteConnectionOffer }>;
  close(): Promise<void>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = new FakeClock();
  const dataDir =
    options.dataDir === null ? null : (options.dataDir ?? mkdtempSync(path.join(tmpdir(), "agentdeck-remote-")));
  const registry = new ProviderRegistry([new MockAgentClient()]);
  const manager = new AgentManager({ registry });
  const settings = new SettingsStore(dataDir ? { dataDir } : {});
  await settings.load();
  const presence = new PresenceTracker(clock.now);
  const remote = new RemoteService({
    settings,
    ...(dataDir ? { dataDir } : {}),
    hostname: () => "test-pc",
    addresses: options.addresses ?? LAN_ADDRESS,
    now: clock.now,
    listenHost: "127.0.0.1",
    ...(options.tuning ? { gatewayTuning: options.tuning } : {}),
  });
  const server = new RpcServer({
    token: TOKEN,
    version: "9.9.9-test",
    manager,
    registry,
    settings,
    remote,
    presence,
  });
  remote.bind(server);
  const attention = new AttentionService({
    manager,
    presence,
    sendToRemote: (notice) => server.sendToRemote("client.attention", notice),
    now: clock.now,
  });
  const localPort = await server.listen(0);
  await remote.start();
  const local = await TestRpcClient.connect(`ws://127.0.0.1:${localPort}/rpc?token=${TOKEN}`);

  const harness: Harness = {
    clock,
    dataDir,
    manager,
    server,
    remote,
    settings,
    presence,
    local,
    localPort,
    port: 0,
    async enable(port) {
      harness.port = port ?? (await freePort());
      await local.call("settings.set", { patch: { remote: { enabled: true, port: harness.port } } });
    },
    async newOffer() {
      const { offerUrl } = await local.call("remote.pairing.create");
      return decodeOfferUrl(offerUrl);
    },
    async pairPhone(deviceName = "测试手机") {
      const offer = await harness.newOffer();
      const phone = await RemotePhone.open(harness.port, { mode: "pair", offer, deviceName });
      const outcome = await phone.outcome;
      if (outcome.type !== "paired") {
        throw new Error(`配对失败：${JSON.stringify(outcome)}`);
      }
      return { phone, deviceId: outcome.deviceId, deviceSecret: outcome.deviceSecret, offer };
    },
    async close() {
      await local.close().catch(() => undefined);
      attention.dispose();
      await remote.stop();
      await manager.shutdown();
      await server.close();
      if (dataDir) {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  };
  if (options.enable) {
    await harness.enable();
  }
  return harness;
}

export type PhoneOutcome =
  | { type: "paired"; deviceId: string; deviceSecret: string }
  | { type: "authed"; name: string }
  | { type: "auth_failed"; reason: AuthFailedReason }
  | { type: "protocol_error"; message: string }
  | { type: "closed"; code: number };

/** 用 @agentdeck/remote 的客户端状态机连网关的「手机」，并附带 JSON-RPC 请求能力 */
export class RemotePhone {
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  readonly outcome: Promise<PhoneOutcome>;
  readonly closed: Promise<number>;
  private readonly session: RemoteClientSession;
  private nextId = 1;
  private readonly pending = new Map<number, (response: RawResponse) => void>();
  private resolveOutcome!: (outcome: PhoneOutcome) => void;
  private outcomeSettled = false;

  private constructor(readonly ws: WebSocket, credentials: RemoteClientCredentials) {
    this.outcome = new Promise((resolve) => {
      this.resolveOutcome = (outcome) => {
        if (!this.outcomeSettled) {
          this.outcomeSettled = true;
          resolve(outcome);
        }
      };
    });
    this.closed = new Promise((resolve) => {
      ws.once("close", (code) => {
        this.resolveOutcome({ type: "closed", code });
        resolve(code);
      });
    });
    this.session = createRemoteClientSession({
      credentials,
      send: (data) => ws.send(data),
      onMessage: (text) => this.onMessage(text),
      onPaired: (r) => this.resolveOutcome({ type: "paired", ...r }),
      onAuthed: (r) => this.resolveOutcome({ type: "authed", name: r.name }),
      onAuthFailed: (reason) => this.resolveOutcome({ type: "auth_failed", reason }),
      onProtocolError: (error) => {
        this.resolveOutcome({ type: "protocol_error", message: error.message });
        ws.close(1002);
      },
    });
    ws.on("message", (data, isBinary) => {
      this.session.handleFrame(isBinary ? new Uint8Array(data as Buffer) : (data as Buffer).toString("utf8"));
    });
    this.session.start();
  }

  static open(port: number, credentials: RemoteClientCredentials, host = "127.0.0.1"): Promise<RemotePhone> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${host}:${port}/remote`);
      ws.once("open", () => resolve(new RemotePhone(ws, credentials)));
      ws.once("error", reject);
    });
  }

  private onMessage(text: string): void {
    const message = JSON.parse(text) as Record<string, unknown>;
    if (typeof message.method === "string" && !("id" in message)) {
      this.notifications.push({ method: message.method, params: message.params });
      return;
    }
    const resolve = this.pending.get(message.id as number);
    this.pending.delete(message.id as number);
    resolve?.(message as unknown as RawResponse);
  }

  request(method: string, params?: unknown): Promise<RawResponse> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.session.sendText(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }));
    });
  }

  /** 发请求，失败时返回 error 对象 */
  async errorOf(method: string, params?: unknown): Promise<AgentRpcErrorObject | undefined> {
    return (await this.request(method, params)).error;
  }

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const response = await this.request(method, params);
    if (response.error) {
      throw new Error(`${method} 失败：${JSON.stringify(response.error)}`);
    }
    return response.result as T;
  }

  async waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error("RemotePhone.waitFor 超时");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  notificationsOf(method: string): unknown[] {
    return this.notifications.filter((n) => n.method === method).map((n) => n.params);
  }

  close(): void {
    this.ws.close();
  }
}

/** 手动控制每一步的「恶意 / 有缺陷」客户端，用来测协议违规 */
export class RawPhone {
  readonly texts: string[] = [];
  readonly binaries: Uint8Array[] = [];
  readonly closed: Promise<number>;
  channel: E2eeChannel | null = null;
  challenge = "";
  shared: Uint8Array | null = null;

  private constructor(readonly ws: WebSocket) {
    this.closed = new Promise((resolve) => ws.once("close", (code) => resolve(code)));
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        this.binaries.push(new Uint8Array(data as Buffer));
      } else {
        this.texts.push((data as Buffer).toString("utf8"));
      }
    });
  }

  static open(port: number, pathName = "/remote"): Promise<RawPhone> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${pathName}`);
      ws.once("open", () => resolve(new RawPhone(ws)));
      ws.once("error", reject);
    });
  }

  /** 发 hello 并收 ready，建立加密通道 */
  async handshake(daemonPublicKey: string): Promise<void> {
    const keyPair = generateKeyPair();
    this.ws.send(JSON.stringify({ type: "e2ee_hello", v: 1, clientKey: exportKey(keyPair.publicKey) }));
    await this.until(() => this.texts.length > 0);
    const ready = JSON.parse(this.texts[0]!) as { challenge: string };
    this.challenge = ready.challenge;
    this.shared = deriveSharedKey(keyPair.secretKey, importPublicKey(daemonPublicKey));
    this.channel = new E2eeChannel(this.shared, "client");
  }

  sendJson(value: unknown): Uint8Array {
    const frame = this.channel!.seal(JSON.stringify(value));
    this.ws.send(frame);
    return frame;
  }

  async readJson(): Promise<Record<string, unknown>> {
    const before = this.binaries.length;
    await this.until(() => this.binaries.length > before);
    return JSON.parse(this.channel!.openText(this.binaries[before]!)) as Record<string, unknown>;
  }

  async until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error("RawPhone.until 超时");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/** 以不带升级的方式连接，返回 HTTP 状态码（被拒绝升级时） */
export function upgradeStatus(port: number, pathName = "/remote"): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${pathName}`);
    ws.once("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.once("open", () => {
      resolve(101);
      ws.close();
    });
    ws.once("error", () => resolve(0));
  });
}
