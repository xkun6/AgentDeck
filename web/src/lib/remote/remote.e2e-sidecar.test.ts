// @vitest-environment node
// 协议级 e2e：真实 RpcServer + 远程网关（mock provider，临时数据目录）←→ 手机端 lib/remote（e2ee-socket + SidecarClient）。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { AgentSnapshot, AgentStreamEnvelope } from "@agentdeck/protocol";
import { freePort, startHarness, type Harness } from "../../../../packages/sidecar/test/remote/harness";
import type { RawSocket } from "./e2ee-socket";
import { createHostClient } from "./connection";
import { HostStore, type HostStorage, type HostsState, type PairedHost } from "./hosts";
import { PairingError, pairWithOffer, parsePairingInput } from "./pairing";
import type { SidecarClient } from "@/lib/sidecar-client";
import { createStore } from "jotai";
import { bindSidecarToStore, createAgentSessionActions } from "@/hooks/use-agent-session";
import { chatRuntimeBySessionAtom } from "@/stores/chat";

function memoryStorage(): HostStorage {
  let saved: HostsState | null = null;
  return {
    read: async () => saved,
    write: async (state) => {
      saved = JSON.parse(JSON.stringify(state)) as HostsState;
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Net {
  /** 记录每次创建的 URL（按顺序） */
  urls: string[];
  /** 创建出的原始 socket */
  sockets: WebSocket[];
  /** 为 true 时所有连接立即失败，模拟网络中断 */
  down: boolean;
  createSocket: (url: string) => RawSocket;
}

function makeNet(): Net {
  const net: Net = {
    urls: [],
    sockets: [],
    down: false,
    createSocket: (url) => {
      net.urls.push(url);
      if (net.down) throw new Error("网络中断（测试）");
      const ws = new WebSocket(url);
      net.sockets.push(ws);
      return ws as unknown as RawSocket;
    },
  };
  return net;
}

describe("手机端远程连接层 e2e", () => {
  let h: Harness;
  let net: Net;
  let store: HostStore;
  let client: SidecarClient | null = null;

  beforeEach(async () => {
    h = await startHarness({ enable: true });
    net = makeNet();
    store = new HostStore(memoryStorage());
    await store.load();
  });

  afterEach(async () => {
    client?.close();
    client = null;
    await h.close();
  });

  async function pair(addresses?: (port: number) => Array<{ host: string; port: number }>): Promise<PairedHost> {
    const { offerUrl } = await h.local.call("remote.pairing.create");
    const offer = parsePairingInput(`请扫描 ${offerUrl} 完成配对`, h.clock.now());
    if (addresses) offer.addresses = addresses(h.port).map((a) => ({ ...a, kind: "lan" as const }));
    const host = await pairWithOffer(offer, "测试手机", { createSocket: net.createSocket, staggerMs: 100 }, h.clock.now);
    await store.upsert(host);
    return host;
  }

  function connect(host: PairedHost): SidecarClient {
    client = createHostClient(host, store, {
      createSocket: net.createSocket,
      staggerMs: 100,
      client: { wakeListeners: false, reconnectBaseDelayMs: 30, reconnectMaxDelayMs: 100 },
    });
    return client;
  }

  it("配对 → 认证 → agent.list → agent.create → agent.send → 流式 → 审批 → 回合完成", async () => {
    const host = await pair();
    expect(host).toMatchObject({ name: "test-pc", lastAddress: { host: "127.0.0.1", port: h.port } });
    expect(host.deviceSecret.length).toBeGreaterThan(20);
    // 电脑端看到这台设备
    expect((await h.local.call("remote.status")).devices.map((d) => d.name)).toEqual(["测试手机"]);

    const c = connect(host);
    const stream: AgentStreamEnvelope[] = [];
    c.onStream((envelope) => stream.push(envelope));
    await c.connect();
    expect(c.state).toBe("open");

    expect((await c.request("agent.list")).agents).toEqual([]);
    const providers = await c.request("provider.list");
    expect(providers.some((p) => p.id === "mock")).toBe(true);

    const { agent } = await c.request("agent.create", { provider: "mock", cwd: process.cwd() });
    const { turnId } = await c.request("agent.send", { agentId: agent.id, prompt: "你好 /approve" });
    expect(turnId).toBeTruthy();

    await waitFor(() => stream.some((e) => e.event.type === "permission_requested"));
    const requested = stream.find((e) => e.event.type === "permission_requested")!;
    const requestId = (requested.event as { request: { id: string } }).request.id;
    await c.request("agent.permission.respond", {
      agentId: agent.id,
      requestId,
      response: { behavior: "allow" },
    });
    await waitFor(() => stream.some((e) => e.event.type === "turn_completed"));

    const types = stream.map((e) => e.event.type);
    expect(types).toContain("timeline");
    expect(types).toContain("permission_resolved");
    // 流式事件 seq 连续
    const seqs = stream.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => seqs[0]! + i));

    // 向前分页（M1 契约）经加密通道可用
    const page = await c.request("agent.timeline", { agentId: agent.id, limit: 5 });
    expect(typeof page.hasOlder).toBe("boolean");
    expect(page.entries.length).toBeGreaterThanOrEqual(5);
  });

  it("断线期间错过的事件在重连后用 sinceSeq 补齐，seq 连续无重复", async () => {
    const host = await pair();
    const c = connect(host);
    const seen: Array<{ seq: number; replay: boolean; type: string }> = [];
    c.onStream((e, meta) => seen.push({ seq: e.seq, replay: meta.replay, type: e.event.type }));
    await c.connect();
    const { agent } = await c.request("agent.create", { provider: "mock", cwd: process.cwd() });
    await c.request("agent.send", { agentId: agent.id, prompt: "第一轮" });
    await waitFor(() => seen.some((e) => e.type === "turn_completed"));
    const lastBefore = seen[seen.length - 1]!.seq;

    // 掐断网络并关闭现有连接，期间电脑端发起第二轮
    net.down = true;
    for (const ws of net.sockets) ws.close();
    await waitFor(() => c.state !== "open");
    await h.local.call("agent.send", { agentId: agent.id, prompt: "第二轮（断线期间）" });
    await waitFor(() => (h.manager.listAgents().find((a) => a.id === agent.id)?.status ?? "") !== "running");
    expect(seen[seen.length - 1]!.seq).toBe(lastBefore);

    net.down = false;
    await waitFor(() => c.state === "open");
    await waitFor(() => seen.filter((e) => e.type === "turn_completed").length === 2);

    const seqs = seen.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual(seqs.map((_, i) => seqs[0]! + i));
    expect(seen.filter((e) => e.seq > lastBefore).every((e) => e.replay)).toBe(true);
    expect(c.lastSeq(agent.id)).toBe(seqs[seqs.length - 1]);
  });

  it("凭据被吊销：报 revoked 终止错误且不再自动重连", async () => {
    const host = await pair();
    const c = connect(host);
    await c.connect();
    const terminals: Array<{ reason: string; code: number }> = [];
    c.onTerminalError((e) => terminals.push({ reason: e.reason, code: e.closeCode }));

    await h.local.call("remote.devices.revoke", { deviceId: host.deviceId });
    await waitFor(() => terminals.length > 0);
    expect(terminals[0]).toEqual({ reason: "revoked", code: 4401 });
    expect(c.state).toBe("error");
    expect(c.terminalError?.reason).toBe("revoked");

    const attempts = net.urls.length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(net.urls.length).toBe(attempts);
    expect(terminals).toHaveLength(1);
  });

  it("认证被拒是定论：不必等不可达（一直挂起）的地址超时", async () => {
    const host = await pair();
    await store.upsert({
      ...host,
      lastAddress: undefined,
      addresses: [
        { host: "127.0.0.1", port: 1, kind: "lan" },
        { host: "127.0.0.1", port: h.port, kind: "lan" },
      ],
    });
    await h.local.call("remote.devices.revoke", { deviceId: host.deviceId });
    const hanging: RawSocket = {
      binaryType: "",
      send() {},
      close() {},
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
    };
    client = createHostClient(store.get(host.id)!, store, {
      createSocket: (url) => (url.includes("127.0.0.1:1/") ? hanging : net.createSocket(url)),
      client: { wakeListeners: false },
    });
    const started = Date.now();
    await expect(client.connect()).rejects.toMatchObject({ reason: "revoked" });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(client.terminalError?.reason).toBe("revoked");
  });

  it("多地址：坏地址不影响连上好地址，并记住最近成功的地址优先尝试", async () => {
    const dead = await freePort();
    const host = await pair((port) => [
      { host: "127.0.0.1", port: dead },
      { host: "127.0.0.1", port },
    ]);
    expect(host.lastAddress).toEqual({ host: "127.0.0.1", port: h.port });

    // 坏地址排在前面，但 lastAddress（好地址）先于它被尝试
    net.urls.length = 0;
    const c = connect(host);
    await c.connect();
    expect(c.state).toBe("open");
    expect(net.urls[0]).toBe(`ws://127.0.0.1:${h.port}/remote`);
    expect(store.get(host.id)?.lastAddress).toEqual({ host: "127.0.0.1", port: h.port });
    expect((await c.request("sidecar.info")).version).toBe("9.9.9-test");

    // 好地址记录丢失时，坏地址失败后仍能靠好地址连上
    await store.upsert({ ...host, lastAddress: undefined });
    c.close();
    net.urls.length = 0;
    const second = connect(store.get(host.id)!);
    await second.connect();
    expect(second.state).toBe("open");
    expect(net.urls).toHaveLength(2);
  });

  it("配对失败的可读错误：密钥过期、已被使用", async () => {
    const { offerUrl } = await h.local.call("remote.pairing.create");
    const offer = parsePairingInput(offerUrl, h.clock.now());
    h.clock.advance(6 * 60_000);
    await expect(pairWithOffer(offer, "手机", { createSocket: net.createSocket })).rejects.toMatchObject({
      name: "PairingError",
      kind: "expired",
    });

    const second = parsePairingInput((await h.local.call("remote.pairing.create")).offerUrl, h.clock.now());
    await pairWithOffer(second, "手机", { createSocket: net.createSocket });
    const reuse = pairWithOffer(second, "手机2", { createSocket: net.createSocket });
    await expect(reuse).rejects.toBeInstanceOf(PairingError);
    await expect(reuse).rejects.toMatchObject({ kind: "invalid" });
  });

  it("全部地址不可达：网络类错误，不是凭据失效", async () => {
    const { offerUrl } = await h.local.call("remote.pairing.create");
    const offer = parsePairingInput(offerUrl, h.clock.now());
    offer.addresses = [{ host: "127.0.0.1", port: await freePort(), kind: "lan" }];
    await expect(pairWithOffer(offer, "手机", { createSocket: net.createSocket })).rejects.toMatchObject({
      kind: "network",
    });
  });

  it("向前分页：分页取回的时间线与整段回放逐条一致（消息顺序、id、文本）", async () => {
    const host = await pair();
    const { agent } = await h.local.call("agent.create", { provider: "mock", cwd: process.cwd() });
    for (const prompt of ["第一问", "第二问", "第三问 /approve", "第四问"]) {
      const approving = prompt.includes("/approve");
      await h.local.call("agent.send", { agentId: agent.id, prompt });
      if (approving) {
        await h.local.waitFor(() => h.manager.getAgent(agent.id).pendingPermissions.length > 0);
        await h.local.call("agent.permission.respond", {
          agentId: agent.id,
          requestId: h.manager.getAgent(agent.id).pendingPermissions[0]!.id,
          response: { behavior: "allow" },
        });
      }
      await waitFor(() => h.manager.getAgent(agent.id).status === "idle");
    }

    const open = async (historyLimit?: number) => {
      const c = createHostClient(store.get(host.id)!, store, {
        createSocket: net.createSocket,
        staggerMs: 100,
        client: { wakeListeners: false, ...(historyLimit ? { historyLimit } : {}) },
      });
      const jotai = createStore();
      const unbind = bindSidecarToStore(c, jotai);
      await c.connect();
      const actions = createAgentSessionActions(c, jotai);
      await actions.loadTimeline(agent.id);
      return { c, jotai, actions, unbind };
    };
    const summarize = (jotai: ReturnType<typeof createStore>) =>
      jotai.get(chatRuntimeBySessionAtom)[agent.id]!.messages.map((m) => [
        m.id,
        m.role,
        m.parts.map((p) => (p.type === "text" ? p.text : p.type)).join("|"),
      ]);

    const full = await open();
    const paged = await open(8);
    const firstPage = summarize(paged.jotai);
    expect(firstPage.length).toBeLessThan(summarize(full.jotai).length);
    expect(paged.actions.historyState(agent.id).hasOlder).toBe(true);

    let pages = 0;
    while (paged.actions.historyState(agent.id).hasOlder) {
      const { hasOlder } = await paged.actions.loadOlderTimeline(agent.id, 8);
      pages += 1;
      expect(pages).toBeLessThan(20);
      if (!hasOlder) break;
    }
    expect(pages).toBeGreaterThan(0);
    expect(summarize(paged.jotai)).toEqual(summarize(full.jotai));
    // 分页期间到达的实时事件仍然接得上：再发一轮，两边一致
    await h.local.call("agent.send", { agentId: agent.id, prompt: "第五问" });
    await waitFor(() => h.manager.getAgent(agent.id).status === "idle");
    await waitFor(() => summarize(paged.jotai).length === summarize(full.jotai).length && summarize(full.jotai).length > firstPage.length);
    expect(summarize(paged.jotai)).toEqual(summarize(full.jotai));
    full.unbind();
    paged.unbind();
    full.c.close();
    paged.c.close();
  });

  it("agent.list 返回的快照类型可用（类型冒烟）", async () => {
    const host = await pair();
    const c = connect(host);
    await c.connect();
    await c.request("agent.create", { provider: "mock", cwd: process.cwd() });
    const agents: AgentSnapshot[] = (await c.request("agent.list")).agents;
    expect(agents).toHaveLength(1);
  });
});
