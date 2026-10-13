// 会话分叉（design.md 4.23）：AgentManager.forkAgent + agent.fork RPC
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentPermissionRequest,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentStreamEnvelope,
  AgentStreamEvent,
} from "@agentdeck/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  AgentManager,
  buildForkTranscript,
  FORK_TRANSCRIPT_MAX_CHARS,
} from "../src/agent/agent-manager.js";
import { AgentStore } from "../src/agent/agent-store.js";
import type { AgentClient, AgentSession, AgentSessionConfig } from "../src/agent/types.js";
import { MockAgentClient } from "../src/providers/mock/index.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { RpcServer } from "../src/server/rpc-server.js";
import { TestRpcClient } from "./rpc-test-client.js";

/** 每次 startTurn 自动完成一轮：回显 prompt 的助手文本 + turn_completed（带 nativeRef） */
class FakeSession implements AgentSession {
  readonly provider = "fake";
  readonly prompts: AgentPromptInput[] = [];
  /** 为 true 时 startTurn 只发 turn_started，不结束（模拟运行中） */
  hold = false;
  private listeners = new Set<(event: AgentStreamEvent) => void>();
  private turnCounter = 0;

  constructor(
    public id: string | null,
    private readonly tag: string,
  ) {}

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.prompts.push(prompt);
    this.turnCounter += 1;
    const turnId = `${this.tag}-turn-${this.turnCounter}`;
    if (!this.id) {
      this.id = `${this.tag}-native`;
      this.emit({ type: "thread_started", sessionId: this.id });
    }
    this.emit({ type: "turn_started", turnId });
    if (!this.hold) {
      this.emit({
        type: "timeline",
        turnId,
        item: { type: "assistant_message", text: `回答${this.turnCounter}`, messageId: `m${this.turnCounter}` },
      });
      this.emit({ type: "turn_completed", turnId, nativeRef: `ref-${this.turnCounter}` });
    }
    return { turnId };
  }

  finish(turnId: string): void {
    this.emit({ type: "turn_completed", turnId });
  }

  subscribe(cb: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emit(event: AgentStreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }
  async respondToPermission(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
  describePersistence(): AgentPersistenceHandle | null {
    return this.id ? { provider: "fake", sessionId: this.id } : null;
  }
}

interface Harness {
  manager: AgentManager;
  summary: AgentClient;
  native: AgentClient;
  sessions: FakeSession[];
  forkCalls: Array<{ handle: AgentPersistenceHandle; cfg: AgentSessionConfig & { nativeRef?: string } }>;
  failFork: { error: Error | null };
  /** native 分叉出的会话是否像 Claude 一样懒启动（没有自己的原生 id） */
  lazyFork: { value: boolean };
  dataDir: string | null;
}

const tempDirs: string[] = [];
const managers: AgentManager[] = [];

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.shutdown()));
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function createHarness(opts: { persist?: boolean } = {}): Harness {
  const sessions: FakeSession[] = [];
  const forkCalls: Harness["forkCalls"] = [];
  const failFork: Harness["failFork"] = { error: null };
  const lazyFork = { value: false };
  const base = {
    kind: "mock" as const,
    label: "Fake",
    isAvailable: async () => ({ available: true }),
    fetchCatalog: async () => ({ models: [], modes: [{ id: "default", label: "默认" }] }),
  };
  const summary: AgentClient = {
    ...base,
    provider: "summary",
    createSession: async () => {
      const session = new FakeSession(null, `s${sessions.length}`);
      sessions.push(session);
      return session;
    },
  };
  const native: AgentClient = {
    ...base,
    provider: "native",
    createSession: async () => {
      const session = new FakeSession(null, `n${sessions.length}`);
      sessions.push(session);
      return session;
    },
    resumeSession: async (handle) => {
      const session = new FakeSession(handle.sessionId, `r${sessions.length}`);
      sessions.push(session);
      return session;
    },
    forkSession: async (handle, cfg) => {
      forkCalls.push({ handle, cfg });
      if (failFork.error) throw failFork.error;
      const session = new FakeSession(lazyFork.value ? null : `forked-${forkCalls.length}`, `f${sessions.length}`);
      sessions.push(session);
      return session;
    },
  };
  const clients = new Map([
    [summary.provider, summary],
    [native.provider, native],
  ]);
  let dataDir: string | null = null;
  let store: AgentStore | undefined;
  if (opts.persist) {
    dataDir = mkdtempSync(path.join(tmpdir(), "agentdeck-fork-"));
    tempDirs.push(dataDir);
    store = new AgentStore({ dataDir });
  }
  const manager = new AgentManager({
    registry: { get: (id) => clients.get(id) },
    ...(store ? { store } : {}),
  });
  managers.push(manager);
  return { manager, summary, native, sessions, forkCalls, failFork, lazyFork, dataDir };
}

/** 发送一轮并等它结束 */
async function runTurn(manager: AgentManager, agentId: string, text: string): Promise<void> {
  await manager.sendPrompt(agentId, text);
  await vi.waitFor(() => expect(manager.getAgent(agentId).status).toBe("idle"));
}

/** 建一个已有两轮对话的会话，返回时间线 */
async function twoTurnAgent(h: Harness, provider: "summary" | "native") {
  const agent = await h.manager.createAgent({ provider, cwd: "/work", title: "原会话" });
  await runTurn(h.manager, agent.id, "第一问");
  await runTurn(h.manager, agent.id, "第二问");
  const { entries } = await h.manager.timeline(agent.id);
  return { agent, entries };
}

const eventTypes = (entries: AgentStreamEnvelope[]) =>
  entries.map((entry) =>
    entry.event.type === "timeline" ? `timeline:${entry.event.item.type}` : entry.event.type,
  );

describe("agent.fork：时间线复制", () => {
  test("整会话：复制全部条目、重编 seq（1 起）、当前 epoch，末尾追加分叉提示，标题缺省「<原标题>（分叉）」", async () => {
    const h = createHarness();
    const { agent, entries } = await twoTurnAgent(h, "summary");

    const forked = await h.manager.forkAgent(agent.id);
    expect(forked.id).not.toBe(agent.id);
    expect(forked).toMatchObject({
      provider: "summary",
      cwd: "/work",
      title: "原会话（分叉）",
      status: "idle",
      lastSeq: entries.length + 1,
      preview: "第一问",
    });

    const copy = (await h.manager.timeline(forked.id)).entries;
    expect(copy).toHaveLength(entries.length + 1);
    expect(copy.map((entry) => entry.seq)).toEqual(copy.map((_, index) => index + 1));
    expect(new Set(copy.map((entry) => entry.agentId))).toEqual(new Set([forked.id]));
    expect(new Set(copy.map((entry) => entry.epoch))).toEqual(new Set([h.manager.epoch]));
    expect(eventTypes(copy.slice(0, -1))).toEqual(eventTypes(entries));
    expect(copy.at(-1)!.event).toEqual({
      type: "timeline",
      item: { type: "notice", text: "已从「原会话」分叉" },
    });
    // 原会话不受影响
    expect((await h.manager.timeline(agent.id)).entries).toEqual(entries);
  });

  test("throughSeq：只保留到所在回合结束为止（含），不论 seq 落在回合内哪里", async () => {
    const h = createHarness();
    const { agent, entries } = await twoTurnAgent(h, "summary");
    const firstTurnEnd = entries.find((entry) => entry.event.type === "turn_completed")!;
    // 取第一回合内的助手消息 seq，而不是回合结束条目本身
    const assistant = entries.find(
      (entry) => entry.event.type === "timeline" && entry.event.item.type === "assistant_message",
    )!;
    expect(assistant.seq).toBeLessThan(firstTurnEnd.seq);

    const forked = await h.manager.forkAgent(agent.id, { throughSeq: assistant.seq, title: "只看第一问" });
    expect(forked.title).toBe("只看第一问");
    const copy = (await h.manager.timeline(forked.id)).entries;
    expect(copy).toHaveLength(firstTurnEnd.seq + 1);
    expect(copy.at(-2)!.event.type).toBe("turn_completed");
    expect(copy.at(-1)!.event).toMatchObject({ type: "timeline", item: { type: "notice" } });
    expect(JSON.stringify(copy)).not.toContain("第二问");
  });

  test("throughSeq 非法：0 / 超出范围 / 落在未结束的回合上 → AgentInvalidParamsError", async () => {
    const h = createHarness();
    const { agent, entries } = await twoTurnAgent(h, "summary");
    const lastSeq = entries.at(-1)!.seq;
    for (const bad of [0, -1, lastSeq + 1, 1.5]) {
      await expect(h.manager.forkAgent(agent.id, { throughSeq: bad })).rejects.toMatchObject({
        name: "AgentInvalidParamsError",
      });
    }
    // 第三回合运行中：throughSeq 落在其中 → 非法
    h.sessions[0]!.hold = true;
    await h.manager.sendPrompt(agent.id, "第三问");
    await vi.waitFor(() => expect(h.manager.getAgent(agent.id).status).toBe("running"));
    const running = (await h.manager.timeline(agent.id)).entries;
    await expect(
      h.manager.forkAgent(agent.id, { throughSeq: running.at(-1)!.seq }),
    ).rejects.toMatchObject({ name: "AgentInvalidParamsError" });
  });

  test("原会话运行中：整会话分叉 TURN_IN_PROGRESS；throughSeq 指向已结束回合时允许", async () => {
    const h = createHarness();
    const { agent, entries } = await twoTurnAgent(h, "summary");
    h.sessions[0]!.hold = true;
    await h.manager.sendPrompt(agent.id, "第三问");
    await vi.waitFor(() => expect(h.manager.getAgent(agent.id).status).toBe("running"));

    await expect(h.manager.forkAgent(agent.id)).rejects.toMatchObject({ code: "TURN_IN_PROGRESS" });
    const ended = entries.filter((entry) => entry.event.type === "turn_completed")[1]!;
    const forked = await h.manager.forkAgent(agent.id, { throughSeq: ended.seq });
    const copy = (await h.manager.timeline(forked.id)).entries;
    expect(copy).toHaveLength(ended.seq + 1);
    // 原会话仍在运行
    expect(h.manager.getAgent(agent.id).status).toBe("running");
  });
});

describe("agent.fork：summary 方式", () => {
  test("transcript 在首次 send 时前置注入，之后清除；不进快照，随 meta 持久化并在注入后落盘清除", async () => {
    const h = createHarness({ persist: true });
    const { agent } = await twoTurnAgent(h, "summary");
    const forked = await h.manager.forkAgent(agent.id);
    expect(forked).not.toHaveProperty("pendingForkContext");
    expect(h.manager.listAgents().find((a) => a.id === forked.id)).not.toHaveProperty("pendingForkContext");

    await h.manager.flush();
    const metaPath = path.join(h.dataDir!, "agents", forked.id, "meta.json");
    const metaBefore = JSON.parse(readFileSync(metaPath, "utf8")) as { pendingForkContext?: string };
    expect(metaBefore.pendingForkContext).toBe("用户：第一问\n\n助手：回答1\n\n用户：第二问\n\n助手：回答2");

    const session = h.sessions.at(-1)!;
    await runTurn(h.manager, forked.id, "继续");
    await runTurn(h.manager, forked.id, "再来");
    expect(session.prompts[0]).toBe(
      "以下是从另一个会话分叉过来的历史对话，仅供参考：\n<transcript>用户：第一问\n\n助手：回答1\n\n用户：第二问\n\n助手：回答2</transcript>\n\n继续",
    );
    expect(session.prompts[1]).toBe("再来");

    // 时间线里的用户消息仍是用户自己的文本
    const entries = (await h.manager.timeline(forked.id)).entries;
    const userTexts = entries.flatMap((entry) =>
      entry.event.type === "timeline" && entry.event.item.type === "user_message"
        ? [entry.event.item.text]
        : [],
    );
    expect(userTexts).toEqual(["第一问", "第二问", "继续", "再来"]);

    await h.manager.flush();
    const metaAfter = JSON.parse(readFileSync(metaPath, "utf8")) as { pendingForkContext?: string };
    expect(metaAfter).not.toHaveProperty("pendingForkContext");
  });

  test("数组 prompt：前置一个文本块", async () => {
    const h = createHarness();
    const { agent } = await twoTurnAgent(h, "summary");
    const forked = await h.manager.forkAgent(agent.id);
    await h.manager.sendPrompt(forked.id, [{ type: "image", data: "AAAA", mimeType: "image/png" }]);
    const prompt = h.sessions.at(-1)!.prompts[0] as Array<{ type: string; text?: string }>;
    expect(prompt).toHaveLength(2);
    expect(prompt[0]).toMatchObject({ type: "text" });
    expect(prompt[0]!.text).toMatch(/^以下是从另一个会话分叉过来的历史对话，仅供参考：/);
    expect(prompt[1]).toMatchObject({ type: "image" });
  });

  test("sidecar 重启后：分叉上下文从 meta 读回，仍不进快照", async () => {
    const h = createHarness({ persist: true });
    const { agent } = await twoTurnAgent(h, "summary");
    const forked = await h.manager.forkAgent(agent.id);
    await h.manager.shutdown();

    const store = new AgentStore({ dataDir: h.dataDir! });
    const manager2 = new AgentManager({ registry: { get: (id) => (id === "summary" ? h.summary : undefined) }, store });
    managers.push(manager2);
    await manager2.restore();
    expect(manager2.getAgent(forked.id)).toMatchObject({ status: "dormant", title: "原会话（分叉）" });
    expect(manager2.getAgent(forked.id)).not.toHaveProperty("pendingForkContext");
    expect((await manager2.timeline(forked.id)).entries.at(-1)!.event).toMatchObject({
      item: { type: "notice" },
    });
  });

  test("buildForkTranscript：工具一行摘要、撤回的用户消息不计入、超长保留最后 60k", () => {
    const entry = (seq: number, event: AgentStreamEvent): AgentStreamEnvelope => ({
      agentId: "a",
      seq,
      epoch: "e",
      timestamp: 0,
      event,
    });
    const transcript = buildForkTranscript([
      entry(1, { type: "timeline", item: { type: "user_message", text: "撤回的", clientMessageId: "c1" } }),
      entry(2, { type: "user_message_retracted", turnId: "t0", clientMessageId: "c1" }),
      entry(3, { type: "timeline", item: { type: "user_message", text: "跑一下" } }),
      entry(4, { type: "timeline", item: { type: "assistant_message", text: "好", messageId: "m" } }),
      entry(5, { type: "timeline", item: { type: "assistant_message", text: "的", messageId: "m" } }),
      entry(6, {
        type: "timeline",
        item: {
          type: "tool_call",
          callId: "c",
          name: "Bash",
          status: "running",
          detail: { type: "shell", command: "ls\n-la" },
        },
      }),
      entry(7, {
        type: "timeline",
        item: {
          type: "tool_call",
          callId: "c",
          name: "Bash",
          status: "completed",
          detail: { type: "shell", command: "ls -la", output: "很长的输出" },
        },
      }),
      entry(8, { type: "timeline", item: { type: "reasoning", text: "想" } }),
    ]);
    expect(transcript).toBe("用户：跑一下\n\n助手：好的\n\n[工具 Bash：ls -la]");

    const long = buildForkTranscript([
      entry(1, { type: "timeline", item: { type: "user_message", text: `开头${"x".repeat(70_000)}结尾` } }),
    ]);
    expect(long).toHaveLength(FORK_TRANSCRIPT_MAX_CHARS);
    expect(long.endsWith("结尾")).toBe(true);
    expect(long.startsWith("用户：")).toBe(false);
  });
});

describe("agent.fork：native 方式", () => {
  test("整会话：调用 provider.forkSession（不带 nativeRef），新会话直接拿到原生 id，不注入上下文", async () => {
    const h = createHarness();
    const { agent } = await twoTurnAgent(h, "native");
    const forked = await h.manager.forkAgent(agent.id);

    expect(h.forkCalls).toHaveLength(1);
    expect(h.forkCalls[0]!.handle).toEqual({ provider: "fake", sessionId: "n0-native" });
    expect(h.forkCalls[0]!.cfg).toEqual({ cwd: "/work" });
    expect(forked.persistence).toEqual({ provider: "fake", sessionId: "forked-1" });
    expect(forked.resumable).toBe(true);

    await runTurn(h.manager, forked.id, "继续");
    expect(h.sessions.at(-1)!.prompts[0]).toBe("继续");
  });

  test("throughSeq 指向最后一个回合：等价于整会话分叉，不需要 nativeRef", async () => {
    const h = createHarness();
    const { agent, entries } = await twoTurnAgent(h, "native");
    await h.manager.forkAgent(agent.id, { throughSeq: entries.at(-1)!.seq });
    expect(h.forkCalls[0]!.cfg).not.toHaveProperty("nativeRef");
  });

  test("throughSeq 指向较早回合：带该回合的 nativeRef；复制出的时间线里 nativeRef 被去掉", async () => {
    const h = createHarness();
    const { agent, entries } = await twoTurnAgent(h, "native");
    const firstEnd = entries.find((entry) => entry.event.type === "turn_completed")!;
    const forked = await h.manager.forkAgent(agent.id, { throughSeq: firstEnd.seq });
    expect(h.forkCalls[0]!.cfg).toMatchObject({ nativeRef: "ref-1" });
    const copy = (await h.manager.timeline(forked.id)).entries;
    const copiedEnd = copy.find((entry) => entry.event.type === "turn_completed")!;
    expect(copiedEnd.event).not.toHaveProperty("nativeRef");

    // 分叉会话再跑一轮后，在复制出的历史上截断分叉：没有 nativeRef，退回 summary（带摘要新开）
    await runTurn(h.manager, forked.id, "继续");
    const second = await h.manager.forkAgent(forked.id, { throughSeq: 1 });
    expect(h.forkCalls).toHaveLength(1);
    await runTurn(h.manager, second.id, "再继续");
    expect(h.sessions.at(-1)!.prompts[0]).toMatch(/<transcript>用户：第一问/);
  });

  test("原会话没有 nativeRef（旧会话）且需要截断 → 退回 summary，不调 forkSession", async () => {
    const h = createHarness();
    const { agent, entries } = await twoTurnAgent(h, "native");
    // 去掉内存时间线里的 nativeRef，模拟旧会话
    for (const entry of entries) {
      if (entry.event.type === "turn_completed") delete entry.event.nativeRef;
    }
    const firstEnd = entries.find((entry) => entry.event.type === "turn_completed")!;
    const forked = await h.manager.forkAgent(agent.id, { throughSeq: firstEnd.seq });
    expect(h.forkCalls).toHaveLength(0);
    await runTurn(h.manager, forked.id, "继续");
    expect(h.sessions.at(-1)!.prompts[0]).toMatch(/<transcript>用户：第一问/);
  });

  test("原生分叉失败 → PROVIDER_UNAVAILABLE，不留下新会话（内存与磁盘）", async () => {
    const h = createHarness({ persist: true });
    const { agent } = await twoTurnAgent(h, "native");
    await h.manager.flush();
    const before = h.manager.listAgents().map((a) => a.id);
    h.failFork.error = new Error("thread/fork 炸了");

    await expect(h.manager.forkAgent(agent.id)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      message: expect.stringContaining("thread/fork 炸了"),
    });
    expect(h.manager.listAgents().map((a) => a.id)).toEqual(before);
    await h.manager.flush();
    expect(existsSync(path.join(h.dataDir!, "agents"))).toBe(true);
    const dirs = readdirSync(path.join(h.dataDir!, "agents"));
    expect(dirs).toEqual(before);
    // 原会话仍可用
    await runTurn(h.manager, agent.id, "还能用");
  });

  test("懒启动的原生分叉（Claude）：记下待完成的分叉；重启后恢复仍走 forkSession，拿到原生 id 后不再需要", async () => {
    const h = createHarness({ persist: true });
    h.lazyFork.value = true;
    const { agent } = await twoTurnAgent(h, "native");
    const forked = await h.manager.forkAgent(agent.id);
    expect(forked.persistence).toBeNull();
    expect(forked.resumable).toBe(true);
    await h.manager.flush();
    const metaPath = path.join(h.dataDir!, "agents", forked.id, "meta.json");
    expect(JSON.parse(readFileSync(metaPath, "utf8"))).toMatchObject({
      pendingFork: { handle: { provider: "fake", sessionId: "n0-native" } },
    });

    // 首次 send 拿到自己的原生 id（thread_started）后，待完成的分叉清除
    await runTurn(h.manager, forked.id, "继续");
    await h.manager.flush();
    expect(JSON.parse(readFileSync(metaPath, "utf8"))).not.toHaveProperty("pendingFork");
    expect(h.manager.getAgent(forked.id).persistence?.sessionId).toBe("f1-native");
  });

  test("懒启动分叉在首次 send 前重启：恢复时再次 forkSession", async () => {
    const h = createHarness({ persist: true });
    h.lazyFork.value = true;
    const { agent } = await twoTurnAgent(h, "native");
    const forked = await h.manager.forkAgent(agent.id);
    await h.manager.shutdown();

    const store = new AgentStore({ dataDir: h.dataDir! });
    const manager2 = new AgentManager({ registry: { get: (id) => (id === "native" ? h.native : undefined) }, store });
    managers.push(manager2);
    await manager2.restore();
    expect(manager2.getAgent(forked.id)).toMatchObject({ status: "dormant", resumable: true });
    await manager2.sendPrompt(forked.id, "继续");
    await vi.waitFor(() => expect(manager2.getAgent(forked.id).status).toBe("idle"));
    expect(h.forkCalls).toHaveLength(2);
    expect(h.forkCalls[1]!.handle.sessionId).toBe("n0-native");
  });
});

describe("agent.fork RPC", () => {
  test("provider.list 带 capabilities.fork；throughSeq 非法返回 -32602；成功返回新会话快照", async () => {
    const registry = new ProviderRegistry([new MockAgentClient(), h0().native]);
    const manager = new AgentManager({ registry });
    managers.push(manager);
    const server = new RpcServer({ token: "tok-0123456789abcdef", version: "t", manager, registry });
    const port = await server.listen(0);
    const client = await TestRpcClient.connect(`ws://127.0.0.1:${port}/rpc?token=tok-0123456789abcdef`);
    try {
      const providers = await client.call("provider.list");
      expect(providers.find((p) => p.id === "mock")?.capabilities?.fork).toBe("summary");
      expect(providers.find((p) => p.id === "native")?.capabilities?.fork).toBe("native");

      const { agent } = await client.call("agent.create", { provider: "mock", cwd: process.cwd(), title: "T" });
      await client.call("agent.send", { agentId: agent.id, prompt: "你好" });
      await client.waitForTurnEnd(agent.id);

      const bad = await client.request("agent.fork", { agentId: agent.id, throughSeq: 9999 });
      expect(bad.error?.code).toBe(-32602);
      const zero = await client.request("agent.fork", { agentId: agent.id, throughSeq: 0 });
      expect(zero.error?.code).toBe(-32602);
      const missing = await client.request("agent.fork", { agentId: "nope" });
      expect(missing.error).toMatchObject({ code: -32000, data: { code: "AGENT_NOT_FOUND" } });

      const { agent: forked } = await client.call("agent.fork", { agentId: agent.id, title: "分叉" });
      expect(forked).toMatchObject({ title: "分叉", provider: "mock" });
      const { entries } = await client.call("agent.timeline", { agentId: forked.id });
      expect(entries.at(-1)!.event).toMatchObject({ type: "timeline", item: { type: "notice" } });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

/** RPC 测试里只需要一个带 forkSession 的 client 来验证 capabilities */
function h0(): Harness {
  return createHarness();
}
