import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentMcpStatusResult,
  AgentPermissionRequest,
  AgentPersistenceHandle,
  AgentSlashCommand,
  AgentSnapshot,
  AgentStreamEnvelope,
  AgentStreamEvent,
} from "@agentdeck/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  AgentManager,
  RECLAIM_NOT_SUPPORTED_MESSAGE,
  RESUME_NOT_SUPPORTED_MESSAGE,
  toPreview,
  type AgentManagerOptions,
} from "../src/agent/agent-manager.js";
import { AgentStore } from "../src/agent/agent-store.js";
import type { AgentClient, AgentSession } from "../src/agent/types.js";
import { CLAUDE_MODES } from "../src/providers/claude/claude-agent.js";
import { CODEX_MODES } from "../src/providers/codex/codex-agent.js";
import { MockAgentClient } from "../src/providers/mock/mock-agent.js";

const tempDirs: string[] = [];
const managers: AgentManager[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(managers.splice(0).map((manager) => manager.shutdown()));
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function makeDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agentdeck-persist-"));
  tempDirs.push(dir);
  return dir;
}

/** 由测试手动驱动的假会话；首轮发 thread_started，使快照拿到 persistence */
class FakeSession implements AgentSession {
  readonly provider = "fake";
  private listeners = new Set<(event: AgentStreamEvent) => void>();
  private turnCounter = 0;
  closed = false;
  model: string | null = null;
  modeId: string | null = null;

  constructor(public id: string | null = null) {}

  async startTurn(): Promise<{ turnId: string }> {
    this.turnCounter += 1;
    const turnId = `turn-${this.turnCounter}`;
    if (!this.id) {
      this.id = `native-${Math.random().toString(16).slice(2)}`;
      this.emit({ type: "thread_started", sessionId: this.id });
    }
    this.emit({ type: "turn_started", turnId });
    return { turnId };
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

  async close(): Promise<void> {
    this.closed = true;
  }

  describePersistence(): AgentPersistenceHandle | null {
    return this.id ? { provider: "fake", sessionId: this.id } : null;
  }

  async setModel(modelId: string | null): Promise<void> {
    this.model = modelId;
    this.emit({ type: "model_changed", modelId });
  }

  async setMode(modeId: string): Promise<void> {
    this.modeId = modeId;
    this.emit({ type: "mode_changed", modeId });
  }
}

interface FakeClientOptions {
  resumable?: boolean;
  resume?: (handle: AgentPersistenceHandle) => Promise<AgentSession>;
  /** fetchCatalog 返回的斜杠命令（design.md 4.14） */
  commands?: AgentSlashCommand[];
}

function fakeClient(options: FakeClientOptions = {}) {
  const sessions: FakeSession[] = [];
  const resumeCalls: AgentPersistenceHandle[] = [];
  const catalogCalls: Array<{ cwd?: string } | undefined> = [];
  const client: AgentClient = {
    provider: "fake",
    kind: "mock",
    label: "Fake",
    isAvailable: async () => ({ available: true }),
    fetchCatalog: async (opts) => {
      catalogCalls.push(opts);
      return { models: [], modes: [], ...(options.commands ? { commands: options.commands } : {}) };
    },
    createSession: async () => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
  };
  if (options.resumable !== false) {
    client.resumeSession = async (handle) => {
      resumeCalls.push(handle);
      if (options.resume) {
        return options.resume(handle);
      }
      const session = new FakeSession(handle.sessionId);
      sessions.push(session);
      return session;
    };
  }
  return { client, sessions, resumeCalls, catalogCalls };
}

function createManager(
  client: AgentClient,
  dataDir?: string,
  now?: () => number,
  idleReclaim?: AgentManagerOptions["idleReclaim"],
) {
  const store = dataDir ? new AgentStore({ dataDir }) : undefined;
  const manager = new AgentManager({
    registry: { get: (id) => (id === client.provider ? client : undefined) },
    ...(store ? { store } : {}),
    ...(now ? { now } : {}),
    ...(idleReclaim ? { idleReclaim } : {}),
  });
  managers.push(manager);
  const streams: AgentStreamEnvelope[] = [];
  const states: AgentSnapshot[] = [];
  const removed: string[] = [];
  manager.subscribe({
    onStream: (envelope) => streams.push(envelope),
    onState: (snapshot) => states.push(snapshot),
    onRemoved: (agentId) => removed.push(agentId),
  });
  return { manager, streams, states, removed };
}

/** 跑一轮：send → 等 running → 手动完成 */
async function runTurn(manager: AgentManager, sessions: FakeSession[], agentId: string, text: string) {
  const { turnId } = await manager.sendPrompt(agentId, text);
  sessions.at(-1)!.emit({ type: "turn_completed", turnId });
  await vi.waitFor(() => expect(manager.getAgent(agentId).status).toBe("idle"));
  return turnId;
}

/** 建一个有历史的会话后关闭 manager，再用同一目录起新 manager */
async function seedDormant(options: FakeClientOptions = {}) {
  const dataDir = makeDataDir();
  const first = fakeClient(options);
  const one = createManager(first.client, dataDir);
  const agent = await one.manager.createAgent({ provider: "fake", cwd: "/work" });
  await runTurn(one.manager, first.sessions, agent.id, "第一轮");
  const before = one.manager.getAgent(agent.id);
  await one.manager.shutdown();

  const second = fakeClient(options);
  const two = createManager(second.client, dataDir);
  await two.manager.restore();
  return { dataDir, agentId: agent.id, before, ...two, ...second };
}

describe("快照新字段：preview / lastSeq / resumable", () => {
  test("preview 取首条用户消息、压缩空白、截断 120 字", async () => {
    expect(toPreview("  第一行\r\n  第二行\n\n第三行  ")).toBe("第一行 第二行 第三行");
    expect(toPreview(" \n ")).toBeUndefined();
    expect(Array.from(toPreview("字".repeat(200))!)).toHaveLength(120);

    const { client, sessions } = fakeClient();
    const { manager, states } = createManager(client);
    const agent = await manager.createAgent({ provider: "fake", cwd: "/w" });
    expect(agent).toMatchObject({ lastSeq: 0, resumable: false });
    expect(agent.preview).toBeUndefined();

    await runTurn(manager, sessions, agent.id, "  你好\n世界  ");
    await runTurn(manager, sessions, agent.id, "第二条不覆盖");
    const snapshot = manager.getAgent(agent.id);
    expect(snapshot.preview).toBe("你好 世界");
    expect(states.some((s) => s.preview === "你好 世界")).toBe(true);
  });

  test("lastSeq 实时等于最大 seq；thread_started 后 resumable 变 true", async () => {
    const { client, sessions } = fakeClient();
    const { manager, streams } = createManager(client);
    const agent = await manager.createAgent({ provider: "fake", cwd: "/w" });
    await runTurn(manager, sessions, agent.id, "hi");
    const snapshot = manager.getAgent(agent.id);
    expect(snapshot.lastSeq).toBe(streams.at(-1)!.seq);
    expect(snapshot.lastSeq).toBeGreaterThan(0);
    expect(snapshot.resumable).toBe(true);
    expect(snapshot.persistence).toMatchObject({ provider: "fake" });
  });

  test("client 不支持 resumeSession 时 resumable 为 false", async () => {
    const { client, sessions } = fakeClient({ resumable: false });
    const { manager } = createManager(client);
    const agent = await manager.createAgent({ provider: "fake", cwd: "/w" });
    await runTurn(manager, sessions, agent.id, "hi");
    expect(manager.getAgent(agent.id)).toMatchObject({ resumable: false });
    expect(manager.getAgent(agent.id).persistence).not.toBeNull();
  });

  test("危险模式：Claude bypassPermissions、Codex full-access 带 dangerous: true", async () => {
    expect(CLAUDE_MODES.filter((m) => m.dangerous).map((m) => m.id)).toEqual(["bypassPermissions"]);
    expect(CODEX_MODES.filter((m) => m.dangerous).map((m) => m.id)).toEqual(["full-access"]);
  });
});

describe("会话累计用量 totalUsage（design.md 4.4）", () => {
  test("usage_updated 浅合并进 lastUsage，中途事件不计入累计", async () => {
    const { client, sessions } = fakeClient();
    const { manager } = createManager(client, makeDataDir());
    const agent = await manager.createAgent({ provider: "fake", cwd: "/w" });
    const turn = (await manager.sendPrompt(agent.id, "hi")).turnId;
    sessions.at(-1)!.emit({
      type: "turn_completed",
      turnId: turn,
      usage: { inputTokens: 100, outputTokens: 10, totalCostUsd: 0.5 },
    });
    await vi.waitFor(() => expect(manager.getAgent(agent.id).status).toBe("idle"));
    sessions.at(-1)!.emit({ type: "usage_updated", usage: { contextWindowUsedTokens: 777 } });
    sessions.at(-1)!.emit({ type: "usage_updated", usage: { contextWindowUsedTokens: 800, contextWindowMaxTokens: 1000 } });
    await vi.waitFor(() => expect(manager.getAgent(agent.id).lastUsage?.contextWindowUsedTokens).toBe(800));
    const snapshot = manager.getAgent(agent.id);
    expect(snapshot.lastUsage).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      totalCostUsd: 0.5,
      contextWindowUsedTokens: 800,
      contextWindowMaxTokens: 1000,
    });
    expect(snapshot.totalUsage).toEqual({ inputTokens: 100, outputTokens: 10 });
    await manager.shutdown();
  });

  test("多轮累加、重复 turn_completed 不重复累加、持久化后重启仍保留", async () => {
    const dataDir = makeDataDir();
    const first = fakeClient();
    const one = createManager(first.client, dataDir);
    const { manager, states } = one;
    const agent = await manager.createAgent({ provider: "fake", cwd: "/w" });
    expect(agent.totalUsage).toBeUndefined();

    const turn1 = (await manager.sendPrompt(agent.id, "第一轮")).turnId;
    first.sessions.at(-1)!.emit({
      type: "turn_completed",
      turnId: turn1,
      usage: { inputTokens: 100, outputTokens: 10, contextWindowUsedTokens: 999 },
    });
    await vi.waitFor(() => expect(manager.getAgent(agent.id).status).toBe("idle"));
    expect(manager.getAgent(agent.id).totalUsage).toEqual({ inputTokens: 100, outputTokens: 10 });
    expect(states.at(-1)?.totalUsage).toEqual({ inputTokens: 100, outputTokens: 10 });

    // 同一 turn 的重复 turn_completed 不重复累加
    first.sessions.at(-1)!.emit({
      type: "turn_completed",
      turnId: turn1,
      usage: { inputTokens: 100, outputTokens: 10 },
    });
    // 缺失的一项按 0；没有 token 的 usage 不累加
    const turn2 = (await manager.sendPrompt(agent.id, "第二轮")).turnId;
    first.sessions.at(-1)!.emit({ type: "turn_completed", turnId: turn2, usage: { outputTokens: 5 } });
    await vi.waitFor(() => expect(manager.getAgent(agent.id).status).toBe("idle"));
    const turn3 = (await manager.sendPrompt(agent.id, "第三轮")).turnId;
    first.sessions.at(-1)!.emit({ type: "turn_completed", turnId: turn3, usage: { totalCostUsd: 1 } });
    await vi.waitFor(() => expect(manager.getAgent(agent.id).status).toBe("idle"));
    expect(manager.getAgent(agent.id).totalUsage).toEqual({ inputTokens: 100, outputTokens: 15 });
    await manager.shutdown();

    const meta = JSON.parse(
      readFileSync(path.join(dataDir, "agents", agent.id, "meta.json"), "utf8"),
    ) as AgentSnapshot;
    expect(meta.totalUsage).toEqual({ inputTokens: 100, outputTokens: 15 });

    const second = fakeClient();
    const two = createManager(second.client, dataDir);
    await two.manager.restore();
    expect(two.manager.getAgent(agent.id).totalUsage).toEqual({ inputTokens: 100, outputTokens: 15 });
  });
});

describe("额度与输出速度（design.md 4.30）", () => {
  const limits = {
    windows: [{ id: "five_hour", label: "5 小时", usedPercent: 3, resetsAt: 1_791_891_600_000 }],
    status: "allowed" as const,
    updatedAt: 1_700_000_000_000,
  };

  test("rate_limits_updated 写快照、推 agent.state、随 meta 持久化并在重启后恢复，不计入 totalUsage", async () => {
    const dataDir = makeDataDir();
    const first = fakeClient();
    const { manager, states } = createManager(first.client, dataDir);
    const agent = await manager.createAgent({ provider: "fake", cwd: "/w" });
    expect(agent.rateLimits).toBeUndefined();
    const statesBefore = states.length;
    first.sessions.at(-1)!.emit({ type: "rate_limits_updated", rateLimits: limits });
    await vi.waitFor(() => expect(manager.getAgent(agent.id).rateLimits).toEqual(limits));
    expect(states.length).toBeGreaterThan(statesBefore);
    expect(states.at(-1)?.rateLimits).toEqual(limits);
    expect(manager.getAgent(agent.id).totalUsage).toBeUndefined();
    expect(manager.getAgent(agent.id).lastUsage).toBeUndefined();
    await manager.shutdown();

    const meta = JSON.parse(
      readFileSync(path.join(dataDir, "agents", agent.id, "meta.json"), "utf8"),
    ) as AgentSnapshot;
    expect(meta.rateLimits).toEqual(limits);

    const second = fakeClient();
    const two = createManager(second.client, dataDir);
    await two.manager.restore();
    expect(two.manager.getAgent(agent.id).rateLimits).toEqual(limits);
  });

  test("outputTokensPerSecond 浅合并进 lastUsage 并在 turn_completed 后保留，但不进入 totalUsage", async () => {
    const { client, sessions } = fakeClient();
    const { manager } = createManager(client, makeDataDir());
    const agent = await manager.createAgent({ provider: "fake", cwd: "/w" });
    const turn = (await manager.sendPrompt(agent.id, "hi")).turnId;
    sessions.at(-1)!.emit({ type: "usage_updated", usage: { outputTokensPerSecond: 42.5 } });
    await vi.waitFor(() => expect(manager.getAgent(agent.id).lastUsage?.outputTokensPerSecond).toBe(42.5));
    sessions.at(-1)!.emit({
      type: "turn_completed",
      turnId: turn,
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        outputTokensPerSecond: 38.2,
        speedOutputTokens: 10,
        speedGenerationMs: 262,
      },
    });
    await vi.waitFor(() => expect(manager.getAgent(agent.id).status).toBe("idle"));
    const snapshot = manager.getAgent(agent.id);
    expect(snapshot.lastUsage?.outputTokensPerSecond).toBe(38.2);
    expect(snapshot.totalUsage).toEqual({ inputTokens: 100, outputTokens: 10 });
    expect(snapshot.lastUsage).toMatchObject({ speedOutputTokens: 10, speedGenerationMs: 262 });
    expect(snapshot.totalUsage).not.toHaveProperty("outputTokensPerSecond");
    expect(snapshot.totalUsage).not.toHaveProperty("speedOutputTokens");
    expect(snapshot.totalUsage).not.toHaveProperty("speedGenerationMs");
    await manager.shutdown();
  });
});

describe("持久化与启动恢复", () => {
  test("shutdown 后重启：dormant、timeline 惰性读取、seq 续号、resume 后跑一轮", async () => {
    const seeded = await seedDormant();
    const { manager, agentId, before, resumeCalls, sessions, states, streams } = seeded;

    const [listed] = manager.listAgents();
    expect(listed).toMatchObject({
      id: agentId,
      status: "dormant",
      resumable: true,
      preview: "第一轮",
      lastSeq: before.lastSeq,
      pendingPermissions: [],
      activeTurnId: null,
    });

    const history = await manager.timeline(agentId);
    expect(history.epoch).toBe(manager.epoch);
    expect(history.entries.map((e) => e.seq)).toEqual(
      Array.from({ length: before.lastSeq }, (_, i) => i + 1),
    );
    expect(history.entries[0]!.event).toMatchObject({
      type: "timeline",
      item: { type: "user_message", text: "第一轮" },
    });

    const { turnId } = await manager.sendPrompt(agentId, "第二轮");
    expect(resumeCalls).toEqual([before.persistence]);
    expect(states.map((s) => s.status)).toEqual(
      expect.arrayContaining(["starting", "idle", "running"]),
    );
    const statusOrder = states.map((s) => s.status);
    expect(statusOrder.indexOf("starting")).toBeLessThan(statusOrder.indexOf("idle"));
    expect(statusOrder.indexOf("idle")).toBeLessThan(statusOrder.lastIndexOf("running"));

    sessions.at(-1)!.emit({ type: "turn_completed", turnId });
    await vi.waitFor(() => expect(manager.getAgent(agentId).status).toBe("idle"));
    expect(streams[0]!.seq).toBe(before.lastSeq + 1);
    const all = (await manager.timeline(agentId)).entries.map((e) => e.seq);
    expect(all).toEqual(Array.from({ length: all.length }, (_, i) => i + 1));
  });

  test("启动扫描：状态映射为 dormant / closed，list 按 updatedAt 倒序", async () => {
    const dataDir = makeDataDir();
    const statuses = ["starting", "idle", "running", "error", "closed"] as const;
    statuses.forEach((status, index) => {
      const dir = path.join(dataDir, "agents", `agent-${status}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify({
          id: `agent-${status}`,
          provider: "fake",
          cwd: "/w",
          status,
          persistence: { provider: "fake", sessionId: `s-${status}` },
          lastSeq: 3,
          createdAt: 1,
          updatedAt: 100 + index,
        }),
      );
    });
    const { client } = fakeClient();
    const { manager } = createManager(client, dataDir);
    await expect(manager.restore()).resolves.toBe(5);
    const listed = manager.listAgents();
    expect(listed.map((a) => a.id)).toEqual([
      "agent-closed",
      "agent-error",
      "agent-running",
      "agent-idle",
      "agent-starting",
    ]);
    expect(listed.map((a) => a.status)).toEqual([
      "closed",
      "dormant",
      "dormant",
      "dormant",
      "dormant",
    ]);
    expect(listed.every((a) => a.resumable && a.lastSeq === 3)).toBe(true);
  });

  test("meta.lastSeq 落后于 timeline 时以 timeline 为准续号", async () => {
    const seeded = await seedDormant();
    const metaFile = path.join(seeded.dataDir, "agents", seeded.agentId, "meta.json");
    const meta = JSON.parse(readFileSync(metaFile, "utf8")) as Record<string, unknown>;
    writeFileSync(metaFile, JSON.stringify({ ...meta, lastSeq: 1 }));

    const { client, sessions } = fakeClient();
    const { manager, streams } = createManager(client, seeded.dataDir);
    await manager.restore();
    await runTurn(manager, sessions, seeded.agentId, "继续");
    expect(streams[0]!.seq).toBe(seeded.before.lastSeq + 1);
  });

  test("恢复后重放快照中的 model / modeId", async () => {
    const dataDir = makeDataDir();
    const first = fakeClient();
    const one = createManager(first.client, dataDir);
    const agent = await one.manager.createAgent({ provider: "fake", cwd: "/w" });
    await runTurn(one.manager, first.sessions, agent.id, "hi");
    await one.manager.setModel(agent.id, "m-2");
    await one.manager.setMode(agent.id, "plan");
    await one.manager.shutdown();

    const second = fakeClient();
    const two = createManager(second.client, dataDir);
    await two.manager.restore();
    await two.manager.sendPrompt(agent.id, "again");
    const resumed = second.sessions.at(-1)!;
    expect(resumed.model).toBe("m-2");
    expect(resumed.modeId).toBe("plan");
    // 重放产生的 model_changed / mode_changed 与快照相同，被去重
    const changes = two.streams.filter(
      (e) => e.event.type === "model_changed" || e.event.type === "mode_changed",
    );
    expect(changes).toEqual([]);
  });

  test("用真实 mock provider：dormant 恢复并完成一轮", async () => {
    const dataDir = makeDataDir();
    const one = createManager(new MockAgentClient(), dataDir);
    const agent = await one.manager.createAgent({ provider: "mock", cwd: "/w" });
    await one.manager.sendPrompt(agent.id, "你好");
    await vi.waitFor(() => expect(one.manager.getAgent(agent.id).status).toBe("idle"), {
      timeout: 5_000,
    });
    const lastSeq = one.manager.getAgent(agent.id).lastSeq;
    await one.manager.shutdown();

    const resumeSpy = vi.spyOn(MockAgentClient.prototype, "resumeSession");
    const two = createManager(new MockAgentClient(), dataDir);
    await two.manager.restore();
    expect(two.manager.getAgent(agent.id)).toMatchObject({ status: "dormant", resumable: true });
    await two.manager.sendPrompt(agent.id, "再来");
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(two.manager.getAgent(agent.id).status).toBe("idle"), {
      timeout: 5_000,
    });
    expect(two.streams[0]!.seq).toBe(lastSeq + 1);
    expect(two.streams.some((e) => e.event.type === "turn_completed")).toBe(true);
  });

  test("未设置数据目录时不落盘", async () => {
    const dataDir = makeDataDir();
    const { client, sessions } = fakeClient();
    const { manager } = createManager(client);
    const agent = await manager.createAgent({ provider: "fake", cwd: dataDir });
    await runTurn(manager, sessions, agent.id, "hi");
    await manager.shutdown();
    expect(existsSync(path.join(dataDir, "agents"))).toBe(false);
    expect(manager.getAgent(agent.id).status).toBe("closed");
  });
});

describe("恢复的错误与并发", () => {
  test("不可恢复（provider 不支持 resumeSession）：NOT_SUPPORTED", async () => {
    const { manager, agentId } = await seedDormant({ resumable: false });
    expect(manager.getAgent(agentId)).toMatchObject({ status: "dormant", resumable: false });
    await expect(manager.sendPrompt(agentId, "x")).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: RESUME_NOT_SUPPORTED_MESSAGE,
    });
  });

  test("provider 抛 NOT_SUPPORTED（如 ACP 未声明 loadSession）：NOT_SUPPORTED 且 resumable 置 false", async () => {
    const { AgentRpcError } = await import("../src/agent/errors.js");
    const { manager, agentId } = await seedDormant({
      resume: async () => {
        throw new AgentRpcError("NOT_SUPPORTED", "不支持 loadSession");
      },
    });
    await expect(manager.sendPrompt(agentId, "x")).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: RESUME_NOT_SUPPORTED_MESSAGE,
    });
    expect(manager.getAgent(agentId)).toMatchObject({ status: "dormant", resumable: false });
  });

  test("恢复失败：PROVIDER_UNAVAILABLE，lastError 写入快照与 meta.json，状态回到 dormant", async () => {
    const seeded = await seedDormant({
      resume: async () => {
        throw new Error("会话文件不存在");
      },
    });
    const { manager, agentId, dataDir, states } = seeded;
    await expect(manager.sendPrompt(agentId, "x")).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    const snapshot = manager.getAgent(agentId);
    expect(snapshot.status).toBe("dormant");
    expect(snapshot.lastError).toContain("会话文件不存在");
    expect(states.map((s) => s.status)).toEqual(["starting", "dormant"]);
    const meta = JSON.parse(
      readFileSync(path.join(dataDir, "agents", agentId, "meta.json"), "utf8"),
    ) as AgentSnapshot;
    expect(meta.lastError).toContain("会话文件不存在");
    expect(meta).not.toHaveProperty("pendingPermissions");
    expect(meta).not.toHaveProperty("activeTurnId");
  });

  test("并发 send：只触发一次恢复，第二个返回 TURN_IN_PROGRESS", async () => {
    let release!: (session: AgentSession) => void;
    const seeded = await seedDormant({
      resume: (handle) =>
        new Promise<AgentSession>((resolve) => {
          release = resolve;
          void handle;
        }),
    });
    const { manager, agentId, resumeCalls } = seeded;
    const first = manager.sendPrompt(agentId, "一");
    await vi.waitFor(() => expect(resumeCalls).toHaveLength(1));
    await expect(manager.sendPrompt(agentId, "二")).rejects.toMatchObject({
      code: "TURN_IN_PROGRESS",
    });
    const session = new FakeSession(resumeCalls[0]!.sessionId);
    release(session);
    await expect(first).resolves.toMatchObject({ turnId: "turn-1" });
    expect(resumeCalls).toHaveLength(1);
    expect(manager.getAgent(agentId).status).toBe("running");
  });

  test("同进程 close 后再 send：可恢复则自动恢复；不可恢复返回 AGENT_CLOSED", async () => {
    const resumable = fakeClient();
    const a = createManager(resumable.client);
    const agent = await a.manager.createAgent({ provider: "fake", cwd: "/w" });
    await runTurn(a.manager, resumable.sessions, agent.id, "hi");
    await a.manager.close(agent.id);
    expect(a.manager.getAgent(agent.id).status).toBe("closed");
    await a.manager.sendPrompt(agent.id, "again");
    expect(resumable.resumeCalls).toHaveLength(1);
    expect(a.manager.getAgent(agent.id).status).toBe("running");

    const plain = fakeClient({ resumable: false });
    const b = createManager(plain.client);
    const other = await b.manager.createAgent({ provider: "fake", cwd: "/w" });
    await b.manager.close(other.id);
    await expect(b.manager.sendPrompt(other.id, "x")).rejects.toMatchObject({
      code: "AGENT_CLOSED",
    });
  });
});

describe("agent.delete", () => {
  test("关闭运行中的会话、删目录、移出注册表并通知 onRemoved", async () => {
    const dataDir = makeDataDir();
    const { client, sessions } = fakeClient();
    const { manager, removed, states } = createManager(client, dataDir);
    const agent = await manager.createAgent({ provider: "fake", cwd: "/w" });
    await manager.sendPrompt(agent.id, "running");
    expect(manager.getAgent(agent.id).status).toBe("running");
    await manager.flush();
    const dir = path.join(dataDir, "agents", agent.id);
    expect(existsSync(dir)).toBe(true);

    await manager.deleteAgent(agent.id);
    expect(sessions[0]!.closed).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(removed).toEqual([agent.id]);
    expect(() => manager.getAgent(agent.id)).toThrow();
    expect(manager.listAgents()).toEqual([]);
    const stateCount = states.length;
    await manager.flush();
    expect(existsSync(dir)).toBe(false);
    expect(states).toHaveLength(stateCount);
    await expect(manager.deleteAgent(agent.id)).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  test("删除 dormant 会话；重启后不再出现", async () => {
    const seeded = await seedDormant();
    await seeded.manager.deleteAgent(seeded.agentId);
    expect(seeded.removed).toEqual([seeded.agentId]);

    const { client } = fakeClient();
    const { manager } = createManager(client, seeded.dataDir);
    await expect(manager.restore()).resolves.toBe(0);
  });
});

describe("斜杠命令与 MCP（design.md 4.14）", () => {
  const MCP_STATUS: AgentMcpStatusResult = {
    servers: [{ name: "fs", status: "connected", toolCount: 2 }],
    reconnect: "server",
  };

  /** 带斜杠命令与 MCP 方法的假会话 */
  class McpSession extends FakeSession {
    reconnects: Array<string | undefined> = [];
    async listCommands(): Promise<AgentSlashCommand[]> {
      return [{ name: "live" }, { name: "live", description: "重名" }];
    }
    async getMcpStatus(): Promise<AgentMcpStatusResult> {
      return MCP_STATUS;
    }
    async reconnectMcp(serverName?: string): Promise<void> {
      this.reconnects.push(serverName);
    }
  }

  test("agent.commands：dormant 走 fetchCatalog（按 name 去重）且不恢复会话", async () => {
    const seeded = await seedDormant({
      commands: [{ name: "compact", description: "压缩" }, { name: "compact" }, { name: "mcp" }],
    });
    const { manager, agentId, resumeCalls, catalogCalls } = seeded;
    await expect(manager.listCommands(agentId)).resolves.toEqual([
      { name: "compact", description: "压缩" },
      { name: "mcp" },
    ]);
    expect(catalogCalls.at(-1)).toEqual({ cwd: "/work" });
    expect(resumeCalls).toHaveLength(0);
    expect(manager.getAgent(agentId).status).toBe("dormant");
    await expect(manager.listCommands("missing")).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  test("agent.commands：活会话实现了 listCommands 时用它；未实现时退回目录", async () => {
    const withList = fakeClient({ commands: [{ name: "catalog" }] });
    withList.client.createSession = async () => new McpSession();
    const a = createManager(withList.client);
    const live = await a.manager.createAgent({ provider: "fake", cwd: "/w" });
    await expect(a.manager.listCommands(live.id)).resolves.toEqual([{ name: "live" }]);

    const plain = fakeClient({ commands: [{ name: "catalog" }] });
    const b = createManager(plain.client);
    const other = await b.manager.createAgent({ provider: "fake", cwd: "/w" });
    await expect(b.manager.listCommands(other.id)).resolves.toEqual([{ name: "catalog" }]);
  });

  test("agent.mcp.*：dormant 先自动恢复再查询 / 重连；回合进行中也可用", async () => {
    const seeded = await seedDormant({
      resume: async (handle) => new McpSession(handle.sessionId),
    });
    const { manager, agentId, resumeCalls } = seeded;
    await expect(manager.getMcpStatus(agentId)).resolves.toEqual(MCP_STATUS);
    expect(resumeCalls).toHaveLength(1);
    expect(manager.getAgent(agentId).status).toBe("idle");

    await manager.sendPrompt(agentId, "跑一轮");
    expect(manager.getAgent(agentId).status).toBe("running");
    await expect(manager.reconnectMcp(agentId, "fs")).resolves.toEqual(MCP_STATUS);
    expect(resumeCalls).toHaveLength(1);
  });

  test("agent.mcp.*：并发调用只恢复一次", async () => {
    let release!: (session: AgentSession) => void;
    const seeded = await seedDormant({
      resume: () =>
        new Promise<AgentSession>((resolve) => {
          release = resolve;
        }),
    });
    const { manager, agentId, resumeCalls } = seeded;
    const first = manager.getMcpStatus(agentId);
    const second = manager.getMcpStatus(agentId);
    await vi.waitFor(() => expect(resumeCalls).toHaveLength(1));
    release(new McpSession(resumeCalls[0]!.sessionId));
    await expect(Promise.all([first, second])).resolves.toEqual([MCP_STATUS, MCP_STATUS]);
    expect(resumeCalls).toHaveLength(1);
  });

  test("agent.status：dormant 先自动恢复再取状态；会话未实现返回 NOT_SUPPORTED", async () => {
    class StatusSession extends FakeSession {
      async getStatus() {
        return [{ title: "会话", rows: [{ label: "会话 ID", value: "s1" }] }];
      }
    }
    const { manager, agentId, resumeCalls } = await seedDormant({
      resume: async (handle) => new StatusSession(handle.sessionId),
    });
    await expect(manager.getStatus(agentId)).resolves.toEqual({
      sections: [{ title: "会话", rows: [{ label: "会话 ID", value: "s1" }] }],
    });
    expect(resumeCalls).toHaveLength(1);

    const plain = await seedDormant();
    await expect(plain.manager.getStatus(plain.agentId)).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: "该 Agent 不支持查看状态",
    });
    await expect(plain.manager.getStatus("missing")).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  test("agent.mcp.*：会话未实现返回 NOT_SUPPORTED；不可恢复按原规则报错", async () => {
    const seeded = await seedDormant();
    await expect(seeded.manager.getMcpStatus(seeded.agentId)).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: "该 Agent 不支持查看 MCP 服务器",
    });
    await expect(seeded.manager.reconnectMcp(seeded.agentId, "fs")).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: "该 Agent 不支持重连 MCP 服务器",
    });

    const unresumable = await seedDormant({ resumable: false });
    await expect(unresumable.manager.getMcpStatus(unresumable.agentId)).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: RESUME_NOT_SUPPORTED_MESSAGE,
    });
  });
});

describe("agent.update：重命名 / 置顶 / 归档（design.md 4.17）", () => {
  test("改名、清除标题、置顶归档：推 agent.state、落盘 meta，不改 updatedAt", async () => {
    const dataDir = makeDataDir();
    const { client } = fakeClient();
    const { manager, states } = createManager(client, dataDir, () => 5000);
    const agent = await manager.createAgent({ provider: "fake", cwd: "/w", title: "旧标题" });
    const updatedAt = manager.getAgent(agent.id).updatedAt;
    const stateCount = states.length;

    const renamed = await manager.updateAgent(agent.id, { title: "  新标题  " });
    expect(renamed.title).toBe("新标题");
    expect(states).toHaveLength(stateCount + 1);
    const metaFile = path.join(dataDir, "agents", agent.id, "meta.json");
    // 立即落盘，不等 500ms 防抖
    expect(JSON.parse(readFileSync(metaFile, "utf8")).title).toBe("新标题");

    const flagged = await manager.updateAgent(agent.id, { pinned: true, archived: true });
    expect(flagged).toMatchObject({ title: "新标题", pinned: true, archived: true });
    expect(JSON.parse(readFileSync(metaFile, "utf8"))).toMatchObject({ pinned: true, archived: true });

    const cleared = await manager.updateAgent(agent.id, { title: null });
    expect("title" in cleared).toBe(false);
    expect("title" in JSON.parse(readFileSync(metaFile, "utf8"))).toBe(false);
    const blank = await manager.updateAgent(agent.id, { title: "   " });
    expect("title" in blank).toBe(false);

    expect(manager.getAgent(agent.id).updatedAt).toBe(updatedAt);
  });

  test("dormant 会话可改且不被恢复；重启后 pinned / archived / title 仍在", async () => {
    const seeded = await seedDormant();
    const { manager, agentId, resumeCalls, sessions } = seeded;
    const loadedUpdatedAt = manager.getAgent(agentId).updatedAt;

    const updated = await manager.updateAgent(agentId, { title: "改名", pinned: true, archived: true });
    expect(updated).toMatchObject({ status: "dormant", title: "改名", pinned: true, archived: true });
    expect(updated.updatedAt).toBe(loadedUpdatedAt);
    expect(resumeCalls).toEqual([]);
    expect(sessions).toEqual([]);
    await manager.shutdown();

    const { client } = fakeClient();
    const { manager: third } = createManager(client, seeded.dataDir);
    await third.restore();
    expect(third.getAgent(agentId)).toMatchObject({
      status: "dormant",
      title: "改名",
      pinned: true,
      archived: true,
      updatedAt: loadedUpdatedAt,
    });
  });

  test("运行中也可改，不受单 turn 约束", async () => {
    const { client } = fakeClient();
    const { manager } = createManager(client);
    const agent = await manager.createAgent({ provider: "fake", cwd: "/w" });
    await manager.sendPrompt(agent.id, "go");
    const updated = await manager.updateAgent(agent.id, { pinned: true });
    expect(updated).toMatchObject({ status: "running", pinned: true });
  });

  test("send 到已归档会话自动取消归档并推送", async () => {
    const seeded = await seedDormant();
    const { manager, agentId, states } = seeded;
    await manager.updateAgent(agentId, { archived: true, pinned: true });
    states.length = 0;

    await manager.sendPrompt(agentId, "回来了");
    expect(manager.getAgent(agentId)).toMatchObject({ archived: false, pinned: true });
    expect(states.every((s) => s.archived === false)).toBe(true);
  });

  test("agent 不存在：AGENT_NOT_FOUND", async () => {
    const { client } = fakeClient();
    const { manager } = createManager(client);
    await expect(manager.updateAgent("nope", { pinned: true })).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
  });
});

describe("空闲会话回收（design.md 4.34）", () => {
  /** 建一个已跑过一轮（resumable）的 idle 会话，时钟可手动拨动 */
  async function idleAgent(
    options: FakeClientOptions = {},
    reclaimSettings: { enabled: boolean; idleMinutes: number } = { enabled: true, idleMinutes: 15 },
  ) {
    const fake = fakeClient(options);
    const clock = { value: 1_000_000 };
    const created = createManager(fake.client, undefined, () => clock.value, () => reclaimSettings);
    const agent = await created.manager.createAgent({ provider: "fake", cwd: "/w" });
    await runTurn(created.manager, fake.sessions, agent.id, "hi");
    return { ...fake, ...created, clock, agentId: agent.id };
  }

  /** 直接改内部快照字段（后台任务 / 挂起审批很难经事件低成本构造） */
  function internalAgent(manager: AgentManager, agentId: string) {
    return (manager as unknown as { agents: Map<string, { snapshot: AgentSnapshot }> }).agents.get(agentId)!;
  }

  test("手动回收：结束 provider 会话、转为 dormant，下次发送自动恢复", async () => {
    const { manager, sessions, resumeCalls, agentId } = await idleAgent();
    const reclaimed = await manager.reclaim(agentId);
    expect(reclaimed.status).toBe("dormant");
    expect(manager.getAgent(agentId).status).toBe("dormant");
    expect(sessions[0]!.closed).toBe(true);

    const { turnId } = await manager.sendPrompt(agentId, "回来");
    expect(resumeCalls).toHaveLength(1);
    sessions.at(-1)!.emit({ type: "turn_completed", turnId });
    await vi.waitFor(() => expect(manager.getAgent(agentId).status).toBe("idle"));
  });

  test("回合进行中 TURN_IN_PROGRESS；不可恢复 NOT_SUPPORTED；已 dormant 原样返回", async () => {
    const running = await idleAgent();
    await running.manager.sendPrompt(running.agentId, "go");
    await expect(running.manager.reclaim(running.agentId)).rejects.toMatchObject({
      code: "TURN_IN_PROGRESS",
    });

    const fixed = await idleAgent({ resumable: false });
    await expect(fixed.manager.reclaim(fixed.agentId)).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: RECLAIM_NOT_SUPPORTED_MESSAGE,
    });
    expect(fixed.sessions[0]!.closed).toBe(false);

    const dormant = await seedDormant();
    const snapshot = await dormant.manager.reclaim(dormant.agentId);
    expect(snapshot.status).toBe("dormant");
    await expect(dormant.manager.reclaim("nope")).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  test("自动回收：未达阈值不回收，达到阈值回收，已 dormant 不重复回收", async () => {
    const { manager, sessions, clock, agentId } = await idleAgent();
    clock.value += 14 * 60_000;
    expect(await manager.reclaimIdleAgents()).toEqual([]);
    expect(manager.getAgent(agentId).status).toBe("idle");

    clock.value += 60_000;
    expect(await manager.reclaimIdleAgents()).toEqual([agentId]);
    expect(manager.getAgent(agentId).status).toBe("dormant");
    expect(sessions[0]!.closed).toBe(true);
    expect(await manager.reclaimIdleAgents()).toEqual([]);
  });

  test("自动回收：置顶、关闭开关、挂起审批、后台活动、不可恢复、运行中都跳过", async () => {
    const pinned = await idleAgent();
    await pinned.manager.updateAgent(pinned.agentId, { pinned: true });
    pinned.clock.value += 60 * 60_000;
    expect(await pinned.manager.reclaimIdleAgents()).toEqual([]);
    // 置顶只挡自动回收，手动仍可回收
    expect((await pinned.manager.reclaim(pinned.agentId)).status).toBe("dormant");

    const disabled = await idleAgent({}, { enabled: false, idleMinutes: 15 });
    disabled.clock.value += 60 * 60_000;
    expect(await disabled.manager.reclaimIdleAgents()).toEqual([]);

    const background = await idleAgent();
    internalAgent(background.manager, background.agentId).snapshot.backgroundActive = true;
    background.clock.value += 60 * 60_000;
    expect(await background.manager.reclaimIdleAgents()).toEqual([]);

    const approval = await idleAgent();
    internalAgent(approval.manager, approval.agentId).snapshot.pendingPermissions = [
      { requestId: "r1", kind: "tool", name: "Bash", title: "Bash" } as unknown as AgentPermissionRequest,
    ];
    approval.clock.value += 60 * 60_000;
    expect(await approval.manager.reclaimIdleAgents()).toEqual([]);

    const fixed = await idleAgent({ resumable: false });
    fixed.clock.value += 60 * 60_000;
    expect(await fixed.manager.reclaimIdleAgents()).toEqual([]);

    const busy = await idleAgent();
    await busy.manager.sendPrompt(busy.agentId, "go");
    busy.clock.value += 60 * 60_000;
    expect(await busy.manager.reclaimIdleAgents()).toEqual([]);
  });

  test("自动回收：开启保活的派单会话一直不回收（不要求置顶、不要求还有任务）；关掉保活或干活的会话照常回收（design.md 4.26）", async () => {
    const dispatcher = await idleAgent();
    await dispatcher.manager.createAgent({ provider: "fake", cwd: "/w", reportToAgentId: dispatcher.agentId });
    internalAgent(dispatcher.manager, dispatcher.agentId).snapshot.cacheKeepAlive = true;
    dispatcher.clock.value += 60 * 60_000;
    expect(await dispatcher.manager.reclaimIdleAgents()).not.toContain(dispatcher.agentId);
    expect(dispatcher.manager.getAgent(dispatcher.agentId).pinned).toBeUndefined();

    internalAgent(dispatcher.manager, dispatcher.agentId).snapshot.cacheKeepAlive = false;
    expect(await dispatcher.manager.reclaimIdleAgents()).toContain(dispatcher.agentId);

    const archived = await idleAgent();
    await archived.manager.createAgent({ provider: "fake", cwd: "/w", reportToAgentId: archived.agentId });
    internalAgent(archived.manager, archived.agentId).snapshot.cacheKeepAlive = true;
    internalAgent(archived.manager, archived.agentId).snapshot.archived = true;
    archived.clock.value += 60 * 60_000;
    expect(await archived.manager.reclaimIdleAgents()).toContain(archived.agentId);

    const top = await idleAgent();
    const worker = await top.manager.createAgent({ provider: "fake", cwd: "/w", reportToAgentId: top.agentId });
    await top.manager.createAgent({ provider: "fake", cwd: "/w", reportToAgentId: worker.id });
    internalAgent(top.manager, worker.id).snapshot.cacheKeepAlive = true;
    internalAgent(top.manager, worker.id).snapshot.resumable = true;
    expect(await top.manager.reclaimIfIdle(worker.id)).toBe(true);
  });

  test("reclaimIfIdle：不等空闲时长；置顶、运行中、不可恢复、仍有派单任务时不回收（design.md 4.26）", async () => {
    const { manager, sessions, agentId } = await idleAgent();
    expect(await manager.reclaimIfIdle(agentId)).toBe(true);
    expect(manager.getAgent(agentId).status).toBe("dormant");
    expect(sessions[0]!.closed).toBe(true);
    expect(await manager.reclaimIfIdle("nope")).toBe(false);

    const disabled = await idleAgent({}, { enabled: false, idleMinutes: 15 });
    expect(await disabled.manager.reclaimIfIdle(disabled.agentId)).toBe(false);

    const pinned = await idleAgent();
    await pinned.manager.updateAgent(pinned.agentId, { pinned: true });
    expect(await pinned.manager.reclaimIfIdle(pinned.agentId)).toBe(false);

    const busy = await idleAgent();
    await busy.manager.sendPrompt(busy.agentId, "go");
    expect(await busy.manager.reclaimIfIdle(busy.agentId)).toBe(false);

    const fixed = await idleAgent({ resumable: false });
    expect(await fixed.manager.reclaimIfIdle(fixed.agentId)).toBe(false);

    const dispatcher = await idleAgent();
    const task = await dispatcher.manager.createAgent({
      provider: "fake",
      cwd: "/w",
      reportToAgentId: dispatcher.agentId,
    });
    await dispatcher.manager.sendPrompt(task.id, "并行开发");
    expect(await dispatcher.manager.reclaimIfIdle(dispatcher.agentId)).toBe(false);
  });

  test("自动回收：派单出去的会话仍在工作时跳过，不要求开启保活；子会话不算派单时照常回收（design.md 4.26）", async () => {
    const dispatcher = await idleAgent();
    const task = await dispatcher.manager.createAgent({
      provider: "fake",
      cwd: "/w",
      reportToAgentId: dispatcher.agentId,
    });
    const { turnId } = await dispatcher.manager.sendPrompt(task.id, "并行开发");
    dispatcher.clock.value += 60 * 60_000;
    expect(await dispatcher.manager.reclaimIdleAgents()).toEqual([]);

    dispatcher.sessions.at(-1)!.emit({ type: "turn_completed", turnId });
    await vi.waitFor(() => expect(dispatcher.manager.getAgent(task.id).status).toBe("idle"));
    dispatcher.clock.value += 60 * 60_000;
    expect(await dispatcher.manager.reclaimIdleAgents()).toContain(dispatcher.agentId);

    const parent = await idleAgent();
    const child = await parent.manager.createAgent({ provider: "fake", cwd: "/w", parentAgentId: parent.agentId });
    await parent.manager.sendPrompt(child.id, "没有回传的子会话");
    parent.clock.value += 60 * 60_000;
    expect(await parent.manager.reclaimIdleAgents()).toEqual([parent.agentId]);
  });

  test("自动回收：开启缓存保活且委派子会话仍在工作时跳过，子会话结束后照常回收（design.md 4.36）", async () => {
    const parent = await idleAgent();
    internalAgent(parent.manager, parent.agentId).snapshot.cacheKeepAlive = true;
    const child = await parent.manager.createAgent({ provider: "fake", cwd: "/w", parentAgentId: parent.agentId });
    const { turnId } = await parent.manager.sendPrompt(child.id, "长时间构建");
    parent.clock.value += 60 * 60_000;
    expect(await parent.manager.reclaimIdleAgents()).toEqual([]);

    parent.sessions.at(-1)!.emit({ type: "turn_completed", turnId });
    await vi.waitFor(() => expect(parent.manager.getAgent(child.id).status).toBe("idle"));
    parent.clock.value += 60 * 60_000;
    expect(await parent.manager.reclaimIdleAgents()).toContain(parent.agentId);
  });

  test("回收进行中并发 send：等关闭完成后恢复，不返回 AGENT_CLOSED", async () => {
    const { manager, sessions, resumeCalls, agentId } = await idleAgent();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = sessions[0]!;
    first.close = async () => {
      await gate;
      first.closed = true;
    };

    const reclaiming = manager.reclaim(agentId);
    const sending = manager.sendPrompt(agentId, "并发");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resumeCalls).toHaveLength(0);
    release();
    await reclaiming;
    const { turnId } = await sending;
    expect(resumeCalls).toHaveLength(1);
    sessions.at(-1)!.emit({ type: "turn_completed", turnId });
    await vi.waitFor(() => expect(manager.getAgent(agentId).status).toBe("idle"));
  });
});
