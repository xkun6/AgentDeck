// SidecarClient 为手机端 / 多入口新增的能力：终止性关闭码、首次同步只取最近一页 + 向前翻页、client.attention、入口注入。
import { afterEach, describe, expect, it } from "vitest";
import type { AgentStreamEnvelope, AttentionNotice } from "@agentdeck/protocol";
import {
  SIDECAR_TERMINAL_CLOSE_MIN,
  SidecarClient,
  SidecarTerminalError,
  __setSidecarClientForTests,
  configureSidecarClient,
  getSidecarClient,
} from "./sidecar-client";

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

const clients: SidecarClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  __setSidecarClientForTests(null);
});

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function setup(
  server: (frame: Frame, socket: FakeSocket) => void,
  options: { historyLimit?: number; openAs?: (socket: FakeSocket, index: number) => void } = {},
) {
  const sockets: FakeSocket[] = [];
  const client = new SidecarClient({
    resolveUrl: async () => "e2ee://x",
    socketFactory: () => {
      const socket = new FakeSocket(server);
      sockets.push(socket);
      const index = sockets.length;
      queueMicrotask(() => {
        if (options.openAs) options.openAs(socket, index);
        else {
          socket.readyState = 1;
          socket.onopen?.({});
        }
      });
      return socket as unknown as WebSocket;
    },
    wakeListeners: false,
    reconnectBaseDelayMs: 1,
    reconnectMaxDelayMs: 2,
    ...(options.historyLimit ? { historyLimit: options.historyLimit } : {}),
  });
  client.enableAutoReconnect();
  clients.push(client);
  return { client, sockets };
}

const defaultServer = (frame: Frame, socket: FakeSocket) => {
  if (frame.method === "agent.list") socket.push({ jsonrpc: "2.0", id: frame.id, result: { agents: [] } });
};

describe("终止性关闭码", () => {
  it("认证被拒（4401 + reason）：上报终止错误、状态 error、不再自动重连；手动重连后清除", async () => {
    let attempt = 0;
    const { client, sockets } = setup(defaultServer, {
      openAs: (socket) => {
        attempt += 1;
        if (attempt === 1) socket.close(4401, "revoked");
        else {
          socket.readyState = 1;
          socket.onopen?.({});
        }
      },
    });
    const terminals: SidecarTerminalError[] = [];
    client.onTerminalError((e) => terminals.push(e));

    await expect(client.connect()).rejects.toBeInstanceOf(SidecarTerminalError);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ closeCode: 4401, reason: "revoked" });
    expect(client.state).toBe("error");
    expect(client.terminalError?.reason).toBe("revoked");

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sockets).toHaveLength(1);

    client.forceReconnect("manual");
    await waitFor(() => client.state === "open");
    expect(client.terminalError).toBeNull();
    expect(sockets).toHaveLength(2);
  });

  it("普通断线（1006）仍然自动重连，lastError 记录原因", async () => {
    let attempt = 0;
    const { client, sockets } = setup(defaultServer, {
      openAs: (socket) => {
        attempt += 1;
        if (attempt === 1) socket.close(1006, "连接超时");
        else {
          socket.readyState = 1;
          socket.onopen?.({});
        }
      },
    });
    await client.connect().catch(() => undefined);
    expect(client.lastError).toBe("连接超时");
    await waitFor(() => client.state === "open");
    expect(sockets).toHaveLength(2);
    expect(client.lastError).toBeNull();
    expect(SIDECAR_TERMINAL_CLOSE_MIN).toBe(4400);
  });
});

describe("historyLimit：首次同步只取最近一页", () => {
  it("见到有历史的 agent 时用 limit 取最近一页，之后 fetchOlder 以最早 seq 为 beforeSeq 向前翻", async () => {
    const pages: Frame[] = [];
    const server = (frame: Frame, socket: FakeSocket) => {
      if (frame.method === "agent.list") return socket.push({ jsonrpc: "2.0", id: frame.id, result: { agents: [] } });
      if (frame.method !== "agent.timeline") return;
      pages.push(frame);
      if (frame.params.beforeSeq === undefined) {
        socket.push({ jsonrpc: "2.0", id: frame.id, result: { epoch: "e1", entries: [envelope(48), envelope(49), envelope(50)], hasOlder: true } });
      } else {
        socket.push({ jsonrpc: "2.0", id: frame.id, result: { epoch: "e1", entries: [envelope(40), envelope(41)], hasOlder: false } });
      }
    };
    const { client, sockets } = setup(server, { historyLimit: 300 });
    const delivered: Array<{ seq: number; replay: boolean }> = [];
    client.onStream((e, meta) => delivered.push({ seq: e.seq, replay: meta.replay }));
    await client.connect();

    // 第一次见到 a1 就是 seq 50（有大量历史）：不能从 0 拉全量
    sockets[0]!.push({ jsonrpc: "2.0", method: "agent.stream", params: envelope(50) });
    await waitFor(() => delivered.length >= 3);
    expect(pages[0]!.params).toEqual({ agentId: "a1", limit: 300 });
    expect(delivered.map((d) => d.seq)).toEqual([48, 49, 50]);
    expect(delivered.every((d) => d.replay)).toBe(true);
    expect(client.historyState("a1")).toEqual({ oldestSeq: 48, hasOlder: true });

    // 实时事件继续接得上
    sockets[0]!.push({ jsonrpc: "2.0", method: "agent.stream", params: envelope(51) });
    await waitFor(() => delivered.length === 4);
    expect(delivered[3]).toEqual({ seq: 51, replay: false });

    const older = await client.fetchOlder("a1", 300);
    expect(pages[1]!.params).toEqual({ agentId: "a1", beforeSeq: 48, limit: 300 });
    expect(older.entries.map((e) => e.seq)).toEqual([40, 41]);
    expect(older.hasOlder).toBe(false);
    // 向前翻的条目不经 onStream 投递（由调用方前插）
    expect(delivered).toHaveLength(4);
    expect(client.historyState("a1")).toEqual({ oldestSeq: 40, hasOlder: false });
    // 没有更早的了：不再发请求
    expect(await client.fetchOlder("a1", 300)).toEqual({ entries: [], hasOlder: false });
    expect(pages).toHaveLength(2);
  });

  it("不设 historyLimit（桌面）保持原行为：从 sinceSeq 0 补齐", async () => {
    const frames: Frame[] = [];
    const server = (frame: Frame, socket: FakeSocket) => {
      if (frame.method === "agent.list") return socket.push({ jsonrpc: "2.0", id: frame.id, result: { agents: [] } });
      frames.push(frame);
      socket.push({ jsonrpc: "2.0", id: frame.id, result: { epoch: "e1", entries: [envelope(1), envelope(2), envelope(3)] } });
    };
    const { client, sockets } = setup(server);
    await client.connect();
    sockets[0]!.push({ jsonrpc: "2.0", method: "agent.stream", params: envelope(3) });
    await waitFor(() => client.lastSeq("a1") === 3);
    expect(frames[0]!.params).toEqual({ agentId: "a1", sinceSeq: 0 });
  });
});

describe("client.attention 与入口注入", () => {
  it("分发 client.attention 通知", async () => {
    const { client, sockets } = setup(defaultServer);
    const received: AttentionNotice[] = [];
    client.onAttention((n) => received.push(n));
    await client.connect();
    const notice: AttentionNotice = { id: "n1", kind: "finished", agentId: "a1", title: "t", body: "b", timestamp: 1 };
    sockets[0]!.push({ jsonrpc: "2.0", method: "client.attention", params: notice });
    expect(received).toEqual([notice]);
  });

  it("未配置入口时 getSidecarClient 抛错；create 只创建一次；client 直接注入；可清空", () => {
    configureSidecarClient({ client: null });
    expect(() => getSidecarClient()).toThrow(/configureSidecarClient/);

    let created = 0;
    const fake = { id: "f" } as unknown as SidecarClient;
    configureSidecarClient({
      create: () => {
        created += 1;
        return fake;
      },
    });
    expect(getSidecarClient()).toBe(fake);
    expect(getSidecarClient()).toBe(fake);
    expect(created).toBe(1);

    const other = { id: "o" } as unknown as SidecarClient;
    configureSidecarClient({ client: other });
    expect(getSidecarClient()).toBe(other);
    __setSidecarClientForTests(null);
    expect(() => getSidecarClient()).toThrow();
  });
});
