// @vitest-environment jsdom
// 重连后的补齐（afterOpen）：单个会话补齐失败只记录，不能中断其它会话的补齐和最后的 agent.list 刷新。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStreamEnvelope } from "@agentdeck/protocol";
import { ConnectionEventLog } from "./connection-log";
import { SidecarClient } from "./sidecar-client";

interface Frame {
  id: string;
  method: string;
  params: { agentId?: string; sinceSeq?: number };
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

function envelope(agentId: string, seq: number): AgentStreamEnvelope {
  return {
    agentId,
    seq,
    epoch: "e1",
    timestamp: 1_000 + seq,
    event: { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: `x${seq}` } },
  };
}

const clients: SidecarClient[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function setup(failing: Set<string>) {
  const log = new ConnectionEventLog();
  const sockets: FakeSocket[] = [];
  const server = (frame: Frame, socket: FakeSocket) => {
    const reply = (result: unknown) => socket.push({ jsonrpc: "2.0", id: frame.id, result });
    if (frame.method === "agent.list") return reply({ agents: [] });
    if (frame.method === "agent.timeline") {
      const agentId = frame.params.agentId!;
      if (failing.has(agentId)) {
        socket.push({
          jsonrpc: "2.0",
          id: frame.id,
          error: { code: -32000, message: "内部错误", data: { code: "INTERNAL_ERROR" } },
        });
        return;
      }
      return reply({ epoch: "e1", entries: [envelope(agentId, (frame.params.sinceSeq ?? 0) + 1)] });
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
    eventLog: log,
  });
  client.enableAutoReconnect();
  clients.push(client);
  await client.connect();
  // 让客户端认识 a1 / a2 / a3（重连时才有东西可补齐）
  for (const id of ["a1", "a2", "a3"]) {
    sockets[0]!.push({ jsonrpc: "2.0", method: "agent.stream", params: envelope(id, 1) });
  }
  await vi.advanceTimersByTimeAsync(0);
  return { client, sockets, log };
}

describe("重连后补齐：单个会话失败不影响其它", () => {
  it("a1 补齐失败：a2 / a3 仍按 sinceSeq 补齐，最后照常刷新 agent.list，失败被记录", async () => {
    const { client, sockets, log } = await setup(new Set(["a1"]));
    const lists: number[] = [];
    client.onAgents(() => lists.push(1));
    client.forceReconnect("manual");
    await vi.advanceTimersByTimeAsync(50);
    expect(sockets).toHaveLength(2);

    const methods = sockets[1]!.sent.map((f) => `${f.method}:${f.params.agentId ?? ""}`);
    expect(methods).toEqual(["agent.timeline:a1", "agent.timeline:a2", "agent.timeline:a3", "agent.list:"]);
    expect(client.lastSeq("a1")).toBe(1);
    expect(client.lastSeq("a2")).toBe(2);
    expect(client.lastSeq("a3")).toBe(2);
    expect(lists).toHaveLength(1);
    expect(client.syncing).toBe(false);
    expect(log.entries().find((e) => e.event === "sync-fail")?.detail).toContain("a1");
  });

  it("全部成功时行为不变", async () => {
    const { client, sockets } = await setup(new Set());
    client.forceReconnect("manual");
    await vi.advanceTimersByTimeAsync(50);
    expect(sockets[1]!.sent.map((f) => f.method)).toEqual([
      "agent.timeline",
      "agent.timeline",
      "agent.timeline",
      "agent.list",
    ]);
    expect(client.lastSeq("a3")).toBe(2);
  });
});
