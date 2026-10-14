import { afterEach, describe, expect, it } from "vitest";
import type { AgentSnapshot, AgentStreamEnvelope } from "@agentdeck/protocol";
import { QueryClient } from "@tanstack/react-query";
import { SidecarClient, SidecarConnectionLostError, SidecarRpcError } from "./sidecar-client";
import { bindProviderChangesToQueries } from "@/hooks/use-agent-session";

interface RpcFrame {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: Record<string, unknown>;
}

type ServerHandler = (frame: RpcFrame, socket: FakeSocket) => void;

class FakeSocket {
  readyState = 0;
  sent: RpcFrame[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(readonly url: string, private readonly server: ServerHandler) {}

  send(data: string): void {
    const frame = JSON.parse(data) as RpcFrame;
    this.sent.push(frame);
    queueMicrotask(() => this.server(frame, this));
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  /** 模拟服务端断开。 */
  drop(): void {
    this.close();
  }

  push(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  reply(id: string, result: unknown): void {
    this.push({ jsonrpc: "2.0", id, result });
  }

  replyError(id: string, error: { code: number; message: string; data?: unknown }): void {
    this.push({ jsonrpc: "2.0", id, error });
  }
}

function envelope(agentId: string, seq: number, epoch = "e1", text = `t${seq}`): AgentStreamEnvelope {
  return {
    agentId,
    seq,
    epoch,
    timestamp: 1_000 + seq,
    event: { type: "timeline", turnId: "turn-1", item: { type: "assistant_message", text } },
  };
}

function snapshot(id: string): AgentSnapshot {
  return {
    id,
    provider: "mock",
    cwd: "/tmp",
    status: "idle",
    pendingPermissions: [],
    lastSeq: 0,
    resumable: false,
    createdAt: 1,
    updatedAt: 2,
  };
}

async function waitFor(check: () => boolean, label = "条件", timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

interface Harness {
  client: SidecarClient;
  sockets: FakeSocket[];
  delivered: AgentStreamEnvelope[];
  current: () => FakeSocket;
}

function setup(server: ServerHandler, options: { autoReconnect?: boolean } = {}): Harness {
  const sockets: FakeSocket[] = [];
  const client = new SidecarClient({
    resolveUrl: async () => "ws://fake/rpc?token=t",
    socketFactory: (url) => {
      const socket = new FakeSocket(url, server);
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket as unknown as WebSocket;
    },
    wakeListeners: false,
    reconnectBaseDelayMs: 1,
    reconnectMaxDelayMs: 2,
    requestTimeoutMs: 2_000,
  });
  if (options.autoReconnect) client.enableAutoReconnect();
  const delivered: AgentStreamEnvelope[] = [];
  client.onStream((item) => delivered.push(item));
  clients.push(client);
  return { client, sockets, delivered, current: () => sockets[sockets.length - 1]! };
}

const clients: SidecarClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

/** 默认服务端：agent.list 返回空列表，其它方法交给 extra。 */
function server(extra?: (frame: RpcFrame, socket: FakeSocket) => boolean): ServerHandler {
  return (frame, socket) => {
    if (extra?.(frame, socket)) return;
    if (frame.method === "agent.list") socket.reply(frame.id, { agents: [] });
  };
}

describe("SidecarClient", () => {
  it("按 id 匹配请求与响应（乱序返回也不串）", async () => {
    const held: RpcFrame[] = [];
    const { client, current } = setup(server((frame) => {
      if (frame.method === "provider.listModels") {
        held.push(frame);
        return true;
      }
      return false;
    }));

    const first = client.request("provider.listModels", { provider: "a" });
    const second = client.request("provider.listModels", { provider: "b" });
    await waitFor(() => held.length === 2, "两个请求发出");
    const socket = current();
    socket.reply(held[1]!.id, { models: [{ provider: "b", id: "m-b", label: "B" }], modes: [] });
    socket.reply(held[0]!.id, { models: [{ provider: "a", id: "m-a", label: "A" }], modes: [] });

    expect((await first).models[0]!.id).toBe("m-a");
    expect((await second).models[0]!.id).toBe("m-b");
    expect(held[0]!.params).toEqual({ provider: "a" });
    expect(held[0]!.jsonrpc).toBe("2.0");
  });

  it("业务错误抛出 SidecarRpcError 并带 businessCode", async () => {
    const { client } = setup(server((frame, socket) => {
      if (frame.method === "agent.send") {
        socket.replyError(frame.id, { code: -32000, message: "忙", data: { code: "TURN_IN_PROGRESS" } });
        return true;
      }
      return false;
    }));

    const error = await client.request("agent.send", { agentId: "a1", prompt: "hi" }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SidecarRpcError);
    expect((error as SidecarRpcError).code).toBe(-32000);
    expect((error as SidecarRpcError).businessCode).toBe("TURN_IN_PROGRESS");
  });

  it("分发 agent.stream / agent.state 通知并按 seq 去重", async () => {
    const { client, current, delivered } = setup(server());
    const states: AgentSnapshot[] = [];
    client.onAgentState((agent) => states.push(agent));
    await client.connect();
    const socket = current();

    socket.push({ jsonrpc: "2.0", method: "agent.stream", params: envelope("a1", 1) });
    socket.push({ jsonrpc: "2.0", method: "agent.stream", params: envelope("a1", 2) });
    socket.push({ jsonrpc: "2.0", method: "agent.stream", params: envelope("a1", 2) });
    socket.push({ jsonrpc: "2.0", method: "agent.state", params: { agent: snapshot("a1") } });

    expect(delivered.map((item) => item.seq)).toEqual([1, 2]);
    expect(states.map((agent) => agent.id)).toEqual(["a1"]);
    expect(client.lastSeq("a1")).toBe(2);
  });

  it("出现序号缺口时用 agent.timeline 补齐，并按序投递缓冲的实时事件", async () => {
    const timelineCalls: Record<string, unknown>[] = [];
    const { client, current, delivered } = setup(server((frame, socket) => {
      if (frame.method === "agent.timeline") {
        timelineCalls.push(frame.params);
        socket.reply(frame.id, { epoch: "e1", entries: [envelope("a1", 2), envelope("a1", 3), envelope("a1", 4)] });
        return true;
      }
      return false;
    }));
    await client.connect();
    const socket = current();
    socket.push({ jsonrpc: "2.0", method: "agent.stream", params: envelope("a1", 1) });
    socket.push({ jsonrpc: "2.0", method: "agent.stream", params: envelope("a1", 4) });
    socket.push({ jsonrpc: "2.0", method: "agent.stream", params: envelope("a1", 5) });

    await waitFor(() => delivered.length === 5, "补齐完成");
    expect(timelineCalls).toEqual([{ agentId: "a1", sinceSeq: 1 }]);
    expect(delivered.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("断线重连后对已知 agent 用 sinceSeq 补齐，再拉 agent.list", async () => {
    const methods: string[] = [];
    let afterReconnect = false;
    const { client, current, delivered, sockets } = setup(server((frame, socket) => {
      methods.push(frame.method);
      if (frame.method === "agent.timeline") {
        socket.reply(frame.id, {
          epoch: "e1",
          entries: afterReconnect ? [envelope("a1", 3), envelope("a1", 4)] : [],
        });
        return true;
      }
      return false;
    }), { autoReconnect: true });
    const agentsLists: AgentSnapshot[][] = [];
    client.onAgents((agents) => agentsLists.push(agents));

    await client.connect();
    await waitFor(() => agentsLists.length === 1, "首次 agent.list");
    const first = current();
    first.push({ jsonrpc: "2.0", method: "agent.stream", params: envelope("a1", 1) });
    first.push({ jsonrpc: "2.0", method: "agent.stream", params: envelope("a1", 2) });
    methods.length = 0;

    afterReconnect = true;
    first.drop();
    await waitFor(() => sockets.length === 2 && client.state === "open", "重连成功");
    await waitFor(() => agentsLists.length === 2, "重连后 agent.list");

    const timelineFrame = sockets[1]!.sent.find((frame) => frame.method === "agent.timeline");
    expect(timelineFrame?.params).toEqual({ agentId: "a1", sinceSeq: 2 });
    expect(methods).toEqual(["agent.timeline", "agent.list"]);
    expect(delivered.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
  });

  it("epoch 变化时丢弃旧序号、通知订阅方并重新拉 agent.list", async () => {
    let listCalls = 0;
    const { client, current, delivered } = setup(server((frame, socket) => {
      if (frame.method === "agent.list") {
        listCalls += 1;
        socket.reply(frame.id, { agents: [snapshot("a2")] });
        return true;
      }
      return false;
    }));
    const epochs: { epoch: string | null; previous: string | null }[] = [];
    client.onEpochChange((change) => epochs.push(change));
    const lists: AgentSnapshot[][] = [];
    client.onAgents((agents) => lists.push(agents));

    await client.connect();
    await waitFor(() => listCalls === 1, "首次 agent.list");
    const socket = current();
    socket.push({ jsonrpc: "2.0", method: "agent.stream", params: envelope("a1", 1, "e1") });
    socket.push({ jsonrpc: "2.0", method: "agent.stream", params: envelope("a1", 2, "e1") });
    expect(client.epoch).toBe("e1");

    // sidecar 重启：新 epoch 的序号从 1 重新开始
    socket.push({ jsonrpc: "2.0", method: "agent.stream", params: envelope("a2", 1, "e2") });

    expect(epochs).toEqual([{ epoch: "e2", previous: "e1" }]);
    expect(client.epoch).toBe("e2");
    expect(client.lastSeq("a1")).toBe(0);
    expect(delivered.map((item) => `${item.epoch}:${item.agentId}:${item.seq}`)).toEqual([
      "e1:a1:1",
      "e1:a1:2",
      "e2:a2:1",
    ]);
    await waitFor(() => listCalls === 2, "epoch 变化后重新拉 agent.list");
    await waitFor(() => lists.length === 2, "列表通知");
    expect(lists[1]!.map((agent) => agent.id)).toEqual(["a2"]);
  });

  it("打开持久化会话：timeline 历史条目保留原 epoch 也照常投递（只按 seq 去重），并标记 replay", async () => {
    const { client, current, delivered } = setup(server((frame, socket) => {
      if (frame.method === "agent.timeline") {
        // 顶层 epoch 为当前进程；历史条目来自之前两次 sidecar 进程
        socket.reply(frame.id, {
          epoch: "e-now",
          entries: [envelope("a1", 1, "e-old1"), envelope("a1", 2, "e-old2"), envelope("a1", 3, "e-old2")],
        });
        return true;
      }
      return false;
    }));
    const metas: boolean[] = [];
    client.onStream((_item, meta) => metas.push(meta.replay));
    await client.connect();

    await client.syncAgent("a1");
    current().push({ jsonrpc: "2.0", method: "agent.stream", params: envelope("a1", 4, "e-now") });
    current().push({ jsonrpc: "2.0", method: "agent.stream", params: envelope("a1", 3, "e-now") });

    expect(delivered.map((item) => [item.seq, item.epoch])).toEqual([
      [1, "e-old1"],
      [2, "e-old2"],
      [3, "e-old2"],
      [4, "e-now"],
    ]);
    expect(metas).toEqual([true, true, true, false]);
    expect(client.epoch).toBe("e-now");
  });

  it("agent.removed 通知：清掉该 agent 的序号并通知订阅方", async () => {
    const { client, current } = setup(server());
    const removed: string[] = [];
    client.onAgentRemoved((agentId) => removed.push(agentId));
    await client.connect();
    const socket = current();
    socket.push({ jsonrpc: "2.0", method: "agent.stream", params: envelope("a1", 1) });
    expect(client.lastSeq("a1")).toBe(1);

    socket.push({ jsonrpc: "2.0", method: "agent.removed", params: { agentId: "a1" } });
    expect(removed).toEqual(["a1"]);
    expect(client.lastSeq("a1")).toBe(0);
  });

  it("agent.subagents.update 通知：原样分发给订阅方", async () => {
    const { client, current } = setup(server());
    const updates: unknown[] = [];
    client.onSubagentUpdate((update) => updates.push(update));
    await client.connect();
    const update = { kind: "remove", agentId: "a1", subagentId: "s1" };
    current().push({ jsonrpc: "2.0", method: "agent.subagents.update", params: update });
    expect(updates).toEqual([update]);
  });

  it("agent.tasks.update 通知：原样分发给订阅方", async () => {
    const { client, current } = setup(server());
    const updates: unknown[] = [];
    client.onTasksUpdate((update) => updates.push(update));
    await client.connect();
    const params = {
      agentId: "a1",
      tasks: [{ taskId: "t1", kind: "command", description: "pnpm build", status: "running", startedAt: 1 }],
    };
    current().push({ jsonrpc: "2.0", method: "agent.tasks.update", params });
    expect(updates).toEqual([params]);
  });

  it("remote.changed 通知：把 RemoteStatus 分发给订阅方，退订后不再收到", async () => {
    const { client, current } = setup(server());
    const seen: unknown[] = [];
    const unsubscribe = client.onRemoteChanged((status) => seen.push(status));
    await client.connect();
    const status = { enabled: true, port: 47631, listening: true, addresses: [], devices: [] };
    current().push({ jsonrpc: "2.0", method: "remote.changed", params: status });
    expect(seen).toEqual([status]);
    unsubscribe();
    current().push({ jsonrpc: "2.0", method: "remote.changed", params: status });
    expect(seen).toHaveLength(1);
  });

  it("provider.changed 通知：通知订阅方，经 bindProviderChangesToQueries 让 provider 相关查询失效", async () => {
    const { client, current } = setup(server());
    const queryClient = new QueryClient();
    const seeds: Array<[readonly unknown[], unknown]> = [
      [["agentdeck", "providers"], []],
      [["agentdeck", "catalog", "custom:relay", "/w"], { models: [], modes: [] }],
      [["agentdeck", "catalog", "claude", ""], { models: [], modes: [] }],
      [["agentdeck", "provider-config"], { providers: [], path: null }],
      [["agentdeck", "unrelated"], 1],
    ];
    for (const [key, value] of seeds) queryClient.setQueryData(key, value);
    let notified = 0;
    client.onProviderChanged(() => {
      notified += 1;
    });
    const unbind = bindProviderChangesToQueries(client, queryClient);
    await client.connect();

    current().push({ jsonrpc: "2.0", method: "provider.changed", params: {} });
    expect(notified).toBe(1);
    await waitFor(
      () => queryClient.getQueryState(["agentdeck", "provider-config"])?.isInvalidated === true,
      "缓存失效",
    );
    const invalidated = (key: readonly unknown[]) => queryClient.getQueryState(key)?.isInvalidated;
    expect(invalidated(["agentdeck", "providers"])).toBe(true);
    expect(invalidated(["agentdeck", "catalog", "custom:relay", "/w"])).toBe(true);
    expect(invalidated(["agentdeck", "catalog", "claude", ""])).toBe(true);
    expect(invalidated(["agentdeck", "unrelated"])).toBe(false);

    unbind();
    queryClient.setQueryData(["agentdeck", "providers"], []);
    current().push({ jsonrpc: "2.0", method: "provider.changed", params: {} });
    expect(notified).toBe(2);
    expect(invalidated(["agentdeck", "providers"])).toBe(false);
    queryClient.clear();
  });
});

describe("agent.send 因断线失败后的核对（confirmUserMessage）", () => {
  function userMessage(seq: number, clientMessageId: string): AgentStreamEnvelope {
    return {
      agentId: "a1",
      seq,
      epoch: "e1",
      timestamp: 1_000 + seq,
      event: { type: "timeline", turnId: "turn-9", item: { type: "user_message", text: "hi", clientMessageId } },
    };
  }

  it("请求发出后连接断开：请求以 SidecarConnectionLostError 失败，与未连接 / RPC 错误可区分", async () => {
    const { client, current } = setup(server((frame, socket) => {
      if (frame.method === "agent.send") {
        socket.drop();
        return true;
      }
      return false;
    }));
    const error = await client.request("agent.send", { agentId: "a1", prompt: "hi" }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SidecarConnectionLostError);
    expect(current().readyState).toBe(3);
  });

  it("重连补齐后时间线里已有同 clientMessageId 的 user_message：返回其 turnId（服务端其实已执行）", async () => {
    let firstSend = true;
    const { client, delivered } = setup(
      server((frame, socket) => {
        if (frame.method === "agent.send" && firstSend) {
          firstSend = false;
          socket.drop(); // 页面挂起期间服务端已收到并开始处理，只是响应丢了
          return true;
        }
        if (frame.method === "agent.timeline") {
          socket.reply(frame.id, { epoch: "e1", entries: [envelope("a1", 1), userMessage(2, "cm-lost"), envelope("a1", 3)] });
          return true;
        }
        return false;
      }),
      { autoReconnect: true },
    );
    client.onStream(() => {});
    // 先让客户端认识 a1
    await client.connect();
    const error = await client.request("agent.send", { agentId: "a1", prompt: "hi", clientMessageId: "cm-lost" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SidecarConnectionLostError);
    await expect(client.confirmUserMessage("a1", "cm-lost")).resolves.toEqual({ turnId: "turn-9" });
    expect(delivered.map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  it("补齐后时间线里没有该 clientMessageId：返回 null（确实没发出去）", async () => {
    const { client } = setup(
      server((frame, socket) => {
        if (frame.method === "agent.timeline") {
          socket.reply(frame.id, { epoch: "e1", entries: [envelope("a1", 1), userMessage(2, "cm-other")] });
          return true;
        }
        return false;
      }),
    );
    await client.connect();
    await expect(client.confirmUserMessage("a1", "cm-none")).resolves.toBeNull();
  });

  it("已经收到过的 user_message 直接确认，不再发请求", async () => {
    const timelineCalls: unknown[] = [];
    const { client, current } = setup(
      server((frame) => {
        if (frame.method === "agent.timeline") timelineCalls.push(frame.params);
        return false;
      }),
    );
    await client.connect();
    current().push({ jsonrpc: "2.0", method: "agent.stream", params: userMessage(1, "cm-live") });
    await expect(client.confirmUserMessage("a1", "cm-live")).resolves.toEqual({ turnId: "turn-9" });
    expect(timelineCalls).toEqual([]);
  });
});
