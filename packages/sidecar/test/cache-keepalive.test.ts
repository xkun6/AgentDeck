// 缓存保活（design.md 4.36）：等待子代理 / 后台任务 / 委派子会话时满 50 分钟保活；置顶会话结束后也保活
import type {
  AgentPermissionRequest,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentSnapshot,
  AgentStreamEnvelope,
} from "@agentdeck/protocol";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AgentManager } from "../src/agent/agent-manager.js";
import { CacheKeepAlive, KEEPALIVE_PROMPT } from "../src/agent/cache-keepalive.js";
import type { AgentClient, AgentSession, AgentSessionEvent } from "../src/agent/types.js";

const MIN = 60_000;

/** 由测试驱动的假会话：startTurn 后回合保持运行，直到 finish() */
class FakeSession implements AgentSession {
  private listeners = new Set<(event: AgentSessionEvent) => void>();
  private turnCounter = 0;
  prompts: string[] = [];
  currentTurnId: string | null = null;

  constructor(
    readonly provider: string,
    public id: string,
  ) {}

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.turnCounter += 1;
    const turnId = `${this.id}-t${this.turnCounter}`;
    this.currentTurnId = turnId;
    this.prompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
    this.emit({ type: "turn_started", turnId });
    return { turnId };
  }

  finish(): void {
    const turnId = this.currentTurnId!;
    this.currentTurnId = null;
    this.emit({ type: "turn_completed", turnId });
  }

  setBackgroundTask(status: "running" | "completed"): void {
    this.emit({
      type: "provider_background_tasks",
      tasks: [{ taskId: "task-1", kind: "command", description: "构建", status, startedAt: 0 }],
    });
  }

  subscribe(cb: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }
  async respondToPermission(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
  describePersistence(): AgentPersistenceHandle | null {
    return { provider: this.provider, sessionId: this.id };
  }
}

interface Harness {
  manager: AgentManager;
  /** agentId → 它的假会话 */
  sessionOf(agentId: string): FakeSession;
  /** 全部 turn_started 事件 */
  started: AgentStreamEnvelope[];
  /** 建会话并记下它的假会话 */
  create(opts?: { provider?: string; parentAgentId?: string; reportToAgentId?: string }): Promise<string>;
  /** 建会话并跑完一轮普通回合（让保活看到一次请求） */
  createIdle(opts: { cacheKeepAlive?: boolean; pinned?: boolean }): Promise<string>;
}

const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 0, 5, 9, 0, 0) });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  vi.useRealTimers();
});

/** 把已有会话标成干活的会话（它的 reportToAgentId 只能在创建时给，这里补上以便先跑一轮回合） */
function internalReportTo(manager: AgentManager, agentId: string, reportTo: string): void {
  (manager as unknown as { agents: Map<string, { snapshot: AgentSnapshot }> }).agents.get(agentId)!.snapshot.reportToAgentId =
    reportTo;
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const settle = () => vi.advanceTimersByTimeAsync(0);

function setup(): Harness {
  const created: FakeSession[] = [];
  const sessions = new Map<string, FakeSession>();
  const makeClient = (provider: string, kind: AgentClient["kind"]): AgentClient => ({
    provider,
    kind,
    label: provider,
    isAvailable: async () => ({ available: true }),
    fetchCatalog: async () => ({ models: [], modes: [] }),
    createSession: async () => {
      const session = new FakeSession(provider, `native-${created.length + 1}`);
      created.push(session);
      return session;
    },
  });
  const clients = new Map([
    ["claude", makeClient("claude", "claude")],
    ["fake", makeClient("fake", "mock")],
  ]);
  const manager = new AgentManager({ registry: { get: (id) => clients.get(id) } });
  const keepAlive = new CacheKeepAlive({
    manager,
    isClaude: (provider) => clients.get(provider)?.kind === "claude",
  });
  keepAlive.start();
  const started: AgentStreamEnvelope[] = [];
  manager.subscribe({
    onStream: (envelope) => {
      if (envelope.event.type === "turn_started") {
        started.push(envelope);
      }
    },
  });
  cleanups.push(async () => {
    keepAlive.stop();
    await manager.shutdown();
  });
  const sessionOf = (agentId: string) => sessions.get(agentId)!;
  const create: Harness["create"] = async (opts = {}) => {
    const agent = await manager.createAgent({
      provider: opts.provider ?? "claude",
      cwd: "/work",
      ...(opts.parentAgentId ? { parentAgentId: opts.parentAgentId, origin: "delegate" as const } : {}),
      ...(opts.reportToAgentId ? { reportToAgentId: opts.reportToAgentId, origin: "delegate" as const } : {}),
    });
    sessions.set(agent.id, created.at(-1)!);
    return agent.id;
  };
  return {
    manager,
    sessionOf,
    started,
    create,
    async createIdle(opts) {
      const id = await create();
      if (opts.cacheKeepAlive || opts.pinned) {
        await manager.updateAgent(id, {
          ...(opts.cacheKeepAlive ? { cacheKeepAlive: true } : {}),
          ...(opts.pinned ? { pinned: true } : {}),
        });
      }
      await manager.sendPrompt(id, "开始任务");
      sessionOf(id).finish();
      await settle();
      return id;
    },
  };
}

describe("agent.update cacheKeepAlive", () => {
  test("Claude 类会话可开关；其它 provider 开启返回 NOT_SUPPORTED 且整个 patch 不生效，关闭总是允许", async () => {
    const h = setup();
    const claude = await h.create();
    expect((await h.manager.updateAgent(claude, { cacheKeepAlive: true })).cacheKeepAlive).toBe(true);
    expect((await h.manager.updateAgent(claude, { cacheKeepAlive: false })).cacheKeepAlive).toBe(false);

    const other = await h.create({ provider: "fake" });
    await expect(h.manager.updateAgent(other, { cacheKeepAlive: true, pinned: true })).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: "该 Agent 不支持缓存保活",
    });
    expect(h.manager.getAgent(other)).not.toHaveProperty("pinned");
    expect(h.manager.getAgent(other)).not.toHaveProperty("cacheKeepAlive");
    expect((await h.manager.updateAgent(other, { cacheKeepAlive: false })).cacheKeepAlive).toBe(false);
  });
});

describe("保活触发", () => {
  test("等待后台任务时每满 50 分钟保活一次，回合标 origin keepalive；后台任务结束后停止", async () => {
    const h = setup();
    const id = await h.createIdle({ cacheKeepAlive: true });
    const session = h.sessionOf(id);
    session.setBackgroundTask("running");
    await settle();
    expect(h.manager.getAgent(id)).toMatchObject({ status: "idle", backgroundActive: true });

    await advance(49 * MIN);
    expect(session.prompts).toEqual(["开始任务"]);
    await advance(MIN);
    await settle();
    expect(session.prompts).toEqual(["开始任务", KEEPALIVE_PROMPT]);
    expect(h.started.at(-1)?.event).toMatchObject({ type: "turn_started", origin: "keepalive" });
    // 用户的第一轮不带 origin
    expect(h.started[0]?.event).not.toHaveProperty("origin");
    session.finish();
    await settle();

    // 下一次从保活回合开始计时
    await advance(49 * MIN);
    expect(session.prompts).toHaveLength(2);
    await advance(MIN);
    await settle();
    expect(session.prompts).toHaveLength(3);
    session.finish();

    session.setBackgroundTask("completed");
    await settle();
    await advance(120 * MIN);
    expect(session.prompts).toHaveLength(3);
  });

  test("置顶会话任务全部结束后也继续保活；未置顶不在等待、未开启保活的置顶会话都不保活", async () => {
    const h = setup();
    const pinned = await h.createIdle({ cacheKeepAlive: true, pinned: true });
    const plain = await h.createIdle({ cacheKeepAlive: true });
    const off = await h.createIdle({ pinned: true });

    await advance(50 * MIN);
    await settle();
    expect(h.sessionOf(pinned).prompts).toEqual(["开始任务", KEEPALIVE_PROMPT]);
    expect(h.sessionOf(plain).prompts).toEqual(["开始任务"]);
    expect(h.sessionOf(off).prompts).toEqual(["开始任务"]);

    h.sessionOf(pinned).finish();
    await settle();
    await advance(50 * MIN);
    await settle();
    expect(h.sessionOf(pinned).prompts).toHaveLength(3);
  });

  test("派单会话开着保活就空闲也保活（不要求置顶）；关掉保活后停止；干活的会话再派单不算派单会话", async () => {
    const h = setup();
    const dispatcher = await h.createIdle({ cacheKeepAlive: true });
    const worker = await h.createIdle({ cacheKeepAlive: true });
    const off = await h.createIdle({});
    await h.create({ reportToAgentId: dispatcher });
    await h.create({ reportToAgentId: off });
    internalReportTo(h.manager, worker, dispatcher);
    await h.create({ reportToAgentId: worker });

    await advance(50 * MIN);
    await settle();
    expect(h.sessionOf(dispatcher).prompts).toEqual(["开始任务", KEEPALIVE_PROMPT]);
    expect(h.sessionOf(worker).prompts).toEqual(["开始任务"]);
    expect(h.sessionOf(off).prompts).toEqual(["开始任务"]);
    expect(h.manager.getAgent(dispatcher).pinned).toBeUndefined();

    h.sessionOf(dispatcher).finish();
    await settle();
    await h.manager.updateAgent(dispatcher, { cacheKeepAlive: false });
    await advance(50 * MIN);
    await settle();
    expect(h.sessionOf(dispatcher).prompts).toHaveLength(2);
  });

  test("已归档的会话不保活，也不会因此被取消归档", async () => {
    const h = setup();
    const dispatcher = await h.createIdle({ cacheKeepAlive: true });
    const pinned = await h.createIdle({ cacheKeepAlive: true, pinned: true });
    await h.create({ reportToAgentId: dispatcher });
    await h.manager.updateAgent(dispatcher, { archived: true });
    await h.manager.updateAgent(pinned, { archived: true });

    await advance(120 * MIN);
    await settle();
    expect(h.sessionOf(dispatcher).prompts).toEqual(["开始任务"]);
    expect(h.sessionOf(pinned).prompts).toEqual(["开始任务"]);
    expect(h.manager.getAgent(dispatcher).archived).toBe(true);
  });

  test("委派的子会话仍在运行时父会话保活，子会话本身不被打扰", async () => {
    const h = setup();
    const parent = await h.createIdle({ cacheKeepAlive: true });
    const child = await h.create({ parentAgentId: parent });
    await h.manager.sendPrompt(child, "长时间构建");
    await settle();

    await advance(50 * MIN);
    await settle();
    expect(h.sessionOf(parent).prompts).toEqual(["开始任务", KEEPALIVE_PROMPT]);
    expect(h.sessionOf(child).prompts).toEqual(["长时间构建"]);
  });

  test("usage_updated 也刷新计时；sidecar 启动后没见过请求的会话不保活", async () => {
    const h = setup();
    const seen = await h.createIdle({ cacheKeepAlive: true, pinned: true });
    const unseen = await h.create();
    await h.manager.updateAgent(unseen, { cacheKeepAlive: true, pinned: true });

    await advance(30 * MIN);
    h.sessionOf(seen).emit({ type: "usage_updated", usage: { inputTokens: 1 } });
    await advance(20 * MIN);
    await settle();
    expect(h.sessionOf(seen).prompts).toEqual(["开始任务"]);
    await advance(30 * MIN);
    await settle();
    expect(h.sessionOf(seen).prompts).toEqual(["开始任务", KEEPALIVE_PROMPT]);
    expect(h.sessionOf(unseen).prompts).toEqual([]);
  });

  test("发送失败后等满一个间隔再试", async () => {
    const h = setup();
    const id = await h.createIdle({ cacheKeepAlive: true, pinned: true });
    const session = h.sessionOf(id);
    const startTurn = vi.spyOn(session, "startTurn").mockRejectedValueOnce(new Error("暂时不可用"));

    await advance(50 * MIN);
    await settle();
    expect(startTurn).toHaveBeenCalledTimes(1);
    await advance(49 * MIN);
    expect(startTurn).toHaveBeenCalledTimes(1);
    await advance(MIN);
    await settle();
    expect(startTurn).toHaveBeenCalledTimes(2);
    expect(session.prompts).toEqual(["开始任务", KEEPALIVE_PROMPT]);
  });
});
