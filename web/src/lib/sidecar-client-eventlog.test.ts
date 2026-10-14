// @vitest-environment jsdom
// 手机端连接事件记录（design.md 4.31「断线诊断」）：forceReconnect 的触发原因、close 的 code / reason、探活各阶段、
// 时钟跳变的 gap 都要落进环形缓冲；未注入 eventLog（桌面）时什么都不记。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionEventLog } from "./connection-log";
import { DEFAULT_LIVENESS_PROBE, SidecarClient } from "./sidecar-client";

class FakeSocket {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(private readonly respond: (frame: { id: string; method: string }, socket: FakeSocket) => void) {}

  send(data: string): void {
    const frame = JSON.parse(data) as { id: string; method: string };
    queueMicrotask(() => this.respond(frame, this));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: code === 1000 });
  }

  /** 服务端先断开（对端关闭） */
  serverClose(code: number, reason: string, wasClean = false): void {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean });
  }

  push(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const clients: SidecarClient[] = [];

async function setup(options: { probe?: boolean; answerInfo?: boolean; withLog?: boolean } = {}) {
  const log = new ConnectionEventLog();
  const sockets: FakeSocket[] = [];
  const answer = { info: options.answerInfo ?? true };
  const respond = (frame: { id: string; method: string }, socket: FakeSocket) => {
    if (frame.method === "agent.list") socket.push({ jsonrpc: "2.0", id: frame.id, result: { agents: [] } });
    else if (frame.method === "sidecar.info" && answer.info) socket.push({ jsonrpc: "2.0", id: frame.id, result: {} });
  };
  const client = new SidecarClient({
    resolveUrl: async () => "e2ee://x",
    socketFactory: () => {
      const socket = new FakeSocket(respond);
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
    ...(options.withLog === false ? {} : { eventLog: log }),
  });
  client.enableAutoReconnect();
  clients.push(client);
  await client.connect();
  await vi.advanceTimersByTimeAsync(0);
  return { client, sockets, log, answer };
}

const events = (log: ConnectionEventLog) => log.entries().map((e) => e.event);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  vi.useRealTimers();
});

describe("连接事件记录", () => {
  it("建连记 open；forceReconnect 的原因被保留（不再丢弃 reason）", async () => {
    const { client, log, sockets } = await setup();
    expect(log.entries()[0]).toMatchObject({ event: "open" });
    client.forceReconnect("sidecar-status");
    await vi.advanceTimersByTimeAsync(10);
    const forced = log.entries().find((e) => e.event === "force-reconnect");
    expect(forced).toMatchObject({ trigger: "sidecar-status" });
    expect(sockets).toHaveLength(2);
    expect(events(log).filter((e) => e === "open")).toHaveLength(2);
  });

  it("对端关闭：close 事件带 code / reason / wasClean 与本连接存活毫秒、foreground，随后记 schedule-reconnect", async () => {
    const { log, sockets } = await setup();
    await vi.advanceTimersByTimeAsync(4_000);
    sockets[0]!.serverClose(1011, "protocol_error:replay");
    const close = log.entries().find((e) => e.event === "close")!;
    expect(close).toMatchObject({ code: 1011, reason: "protocol_error:replay", wasClean: false, foreground: true });
    expect(close.aliveMs).toBeGreaterThanOrEqual(4_000);
    expect(close.idleMs).toBeGreaterThanOrEqual(4_000);
    expect(events(log)).toContain("schedule-reconnect");
  });

  it("时钟跳变：记录 gap-watchdog 触发路径与 gapMs，探活超时后再记 probe-timeout 与 force-reconnect(probe)", async () => {
    const { log, answer } = await setup();
    answer.info = false;
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(2_000);
    const start = log.entries().find((e) => e.event === "probe-start")!;
    expect(start.trigger).toBe("gap-watchdog");
    expect(start.gapMs).toBeGreaterThanOrEqual(60_000);
    await vi.advanceTimersByTimeAsync(10_100);
    const names = events(log);
    expect(names).toContain("probe-timeout");
    expect(log.entries().find((e) => e.event === "force-reconnect")).toMatchObject({ trigger: "probe" });
  });

  it("online 唤醒的探活有回应：probe-start / probe-ok 带 trigger=online", async () => {
    const { log } = await setup();
    await vi.advanceTimersByTimeAsync(20_000);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(100);
    expect(log.entries().find((e) => e.event === "probe-start")).toMatchObject({ trigger: "online" });
    expect(log.entries().find((e) => e.event === "probe-ok")).toMatchObject({ trigger: "online" });
  });

  it("手动 close 记 manual-close", async () => {
    const { client, log } = await setup();
    client.close();
    expect(events(log)).toContain("manual-close");
  });

  it("未注入 eventLog（桌面）：不记任何事件", async () => {
    const { client, log } = await setup({ probe: false, withLog: false });
    client.forceReconnect("manual");
    await vi.advanceTimersByTimeAsync(10);
    expect(log.entries()).toEqual([]);
  });
});
