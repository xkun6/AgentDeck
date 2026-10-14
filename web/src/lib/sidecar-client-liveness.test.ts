// @vitest-environment jsdom
// 手机端新增的连接韧性：回前台 / online / 网络切换时的死连接探活与强制重连，以及重连补齐期间的 syncing 状态。
// 用假定时器 + 假 socket 驱动；不配置 livenessProbe（桌面）时行为保持不变。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStreamEnvelope } from "@agentdeck/protocol";
import { DEFAULT_LIVENESS_PROBE, SidecarClient } from "./sidecar-client";

interface Frame {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

class FakeSocket {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readonly sent: Frame[] = [];

  constructor(private readonly server: (frame: Frame, socket: FakeSocket) => void) {}

  send(data: string): void {
    const frame = JSON.parse(data) as Frame;
    this.sent.push(frame);
    queueMicrotask(() => this.server(frame, this));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  push(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function envelope(seq: number): AgentStreamEnvelope {
  return {
    agentId: "a1",
    seq,
    epoch: "e1",
    timestamp: 1_000 + seq,
    event: { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: `x${seq}` } },
  };
}

interface Rig {
  client: SidecarClient;
  sockets: FakeSocket[];
  /** sidecar.info 是否应答（false = 死连接，什么都不回） */
  answerInfo: { value: boolean };
  /** 暂存 agent.timeline 的应答，用来观察补齐进行中的状态 */
  hold: { value: boolean; pending: Array<() => void> };
}

const clients: SidecarClient[] = [];

async function setup(options: { probe?: boolean } = {}): Promise<Rig> {
  const sockets: FakeSocket[] = [];
  const answerInfo = { value: true };
  const hold = { value: false, pending: [] as Array<() => void> };
  const server = (frame: Frame, socket: FakeSocket) => {
    const reply = (result: unknown) => socket.push({ jsonrpc: "2.0", id: frame.id, result });
    if (frame.method === "agent.list") return reply({ agents: [] });
    if (frame.method === "sidecar.info") {
      if (answerInfo.value) reply({ version: "1", pid: 1 });
      return;
    }
    if (frame.method === "agent.timeline") {
      const respond = () => reply({ epoch: "e1", entries: [envelope(2)] });
      if (hold.value) hold.pending.push(respond);
      else respond();
    }
  };
  const client = new SidecarClient({
    resolveUrl: async () => "e2ee://x",
    socketFactory: () => {
      const socket = new FakeSocket(server);
      sockets.push(socket);
      queueMicrotask(() => {
        socket.readyState = 1;
        socket.onopen?.({});
      });
      return socket as unknown as WebSocket;
    },
    reconnectBaseDelayMs: 1,
    reconnectMaxDelayMs: 2,
    ...(options.probe === false ? {} : { livenessProbe: DEFAULT_LIVENESS_PROBE }),
  });
  client.enableAutoReconnect();
  clients.push(client);
  await client.connect();
  // 让客户端认识 a1（重连时才有东西可补齐）
  sockets[0]!.push({ jsonrpc: "2.0", method: "agent.stream", params: envelope(1) });
  await vi.advanceTimersByTimeAsync(0);
  return { client, sockets, answerInfo, hold };
}

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

const infoCount = (socket: FakeSocket) => socket.sent.filter((f) => f.method === "sidecar.info").length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  vi.useRealTimers();
  setVisibility("visible");
});

describe("回前台探活", () => {
  it("空闲超过阈值：立即发 sidecar.info，3 秒内无回应则强制重连并按 sinceSeq 补齐", async () => {
    const rig = await setup();
    rig.answerInfo.value = false;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(rig.sockets).toHaveLength(1);

    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(infoCount(rig.sockets[0]!)).toBe(1);
    // 还没到 3 秒：不动
    await vi.advanceTimersByTimeAsync(2_900);
    expect(rig.sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(200);
    expect(rig.sockets[0]!.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(rig.sockets).toHaveLength(2);
    expect(rig.client.state).toBe("open");
    const timeline = rig.sockets[1]!.sent.find((f) => f.method === "agent.timeline");
    expect(timeline?.params).toEqual({ agentId: "a1", sinceSeq: 1 });
    expect(rig.client.lastSeq("a1")).toBe(2);
  });

  it("探活有回应：连接保持，不重连", async () => {
    const rig = await setup();
    await vi.advanceTimersByTimeAsync(20_000);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(infoCount(rig.sockets[0]!)).toBe(1);
    expect(rig.sockets).toHaveLength(1);
    expect(rig.client.state).toBe("open");
  });

  it("对端回 RPC 错误也算有回应（连接是活的）", async () => {
    const rig = await setup();
    rig.sockets[0]!.send = function (this: FakeSocket, data: string) {
      const frame = JSON.parse(data) as Frame;
      this.sent.push(frame);
      queueMicrotask(() => this.push({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "方法不存在" } }));
    };
    await vi.advanceTimersByTimeAsync(20_000);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(rig.sockets).toHaveLength(1);
  });

  it("最近 15 秒内收到过数据：不探活", async () => {
    const rig = await setup();
    await vi.advanceTimersByTimeAsync(10_000);
    rig.sockets[0]!.push({ jsonrpc: "2.0", method: "agent.stream", params: envelope(2) });
    await vi.advanceTimersByTimeAsync(10_000);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(infoCount(rig.sockets[0]!)).toBe(0);
    expect(rig.sockets).toHaveLength(1);
  });

  it("切到后台（hidden）不探活；连续多次回前台只发一次探活", async () => {
    const rig = await setup();
    rig.answerInfo.value = false;
    await vi.advanceTimersByTimeAsync(20_000);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(10);
    expect(infoCount(rig.sockets[0]!)).toBe(0);
    setVisibility("visible");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(10);
    expect(infoCount(rig.sockets[0]!)).toBe(1);
  });
});

describe("online 与网络切换", () => {
  it("online 事件触发同样的探活与强制重连", async () => {
    const rig = await setup();
    rig.answerInfo.value = false;
    await vi.advanceTimersByTimeAsync(20_000);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(3_100);
    await vi.advanceTimersByTimeAsync(10);
    expect(rig.sockets).toHaveLength(2);
    expect(rig.client.state).toBe("open");
  });

  it("Network Information 的 change 事件触发探活", async () => {
    const connection = new EventTarget();
    Object.defineProperty(navigator, "connection", { value: connection, configurable: true });
    try {
      const rig = await setup();
      rig.answerInfo.value = false;
      await vi.advanceTimersByTimeAsync(20_000);
      connection.dispatchEvent(new Event("change"));
      await vi.advanceTimersByTimeAsync(3_100);
      await vi.advanceTimersByTimeAsync(10);
      expect(rig.sockets).toHaveLength(2);
    } finally {
      delete (navigator as { connection?: unknown }).connection;
    }
  });
});

describe("未配置 livenessProbe（桌面）行为不变", () => {
  it("回前台 / online 在连接仍开着时什么都不做", async () => {
    const rig = await setup({ probe: false });
    rig.answerInfo.value = false;
    await vi.advanceTimersByTimeAsync(20_000);
    setVisibility("visible");
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(infoCount(rig.sockets[0]!)).toBe(0);
    expect(rig.sockets).toHaveLength(1);
    expect(rig.client.state).toBe("open");
  });
});

describe("重连补齐期间的 syncing 状态", () => {
  it("首次连接不算同步；重连后补齐进行中为 true，补齐完成变回 false，订阅方收到变化", async () => {
    const rig = await setup();
    const seen: boolean[] = [];
    rig.client.onSyncing((value) => seen.push(value));
    expect(seen).toEqual([false]);
    expect(rig.client.syncing).toBe(false);

    rig.hold.value = true;
    rig.client.forceReconnect("manual");
    await vi.advanceTimersByTimeAsync(10);
    expect(rig.sockets).toHaveLength(2);
    expect(rig.client.syncing).toBe(true);
    expect(seen).toEqual([false, true]);

    rig.hold.value = false;
    for (const respond of rig.hold.pending.splice(0)) respond();
    await vi.advanceTimersByTimeAsync(10);
    expect(rig.client.syncing).toBe(false);
    expect(seen).toEqual([false, true, false]);
  });

  it("补齐中途又断线：不会卡在 syncing=true", async () => {
    const rig = await setup();
    rig.hold.value = true;
    rig.client.forceReconnect("manual");
    await vi.advanceTimersByTimeAsync(10);
    expect(rig.client.syncing).toBe(true);
    rig.hold.value = false;
    rig.sockets[1]!.close(1006, "断了");
    await vi.advanceTimersByTimeAsync(50);
    expect(rig.client.state).toBe("open");
    expect(rig.sockets.length).toBeGreaterThanOrEqual(3);
    expect(rig.client.syncing).toBe(false);
  });
});
