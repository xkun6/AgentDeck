import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentPermissionRequest,
  AgentPersistenceHandle,
  AgentSnapshot,
  AgentStreamEnvelope,
  AgentStreamEvent,
} from "@agentdeck/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";

import { AgentManager, RESUME_NOT_SUPPORTED_MESSAGE, toPreview } from "../src/agent/agent-manager.js";
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
}

function fakeClient(options: FakeClientOptions = {}) {
  const sessions: FakeSession[] = [];
  const resumeCalls: AgentPersistenceHandle[] = [];
  const client: AgentClient = {
    provider: "fake",
    kind: "mock",
    label: "Fake",
    isAvailable: async () => ({ available: true }),
    fetchCatalog: async () => ({ models: [], modes: [] }),
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
  return { client, sessions, resumeCalls };
}

function createManager(client: AgentClient, dataDir?: string, now?: () => number) {
  const store = dataDir ? new AgentStore({ dataDir }) : undefined;
  const manager = new AgentManager({
    registry: { get: (id) => (id === client.provider ? client : undefined) },
    ...(store ? { store } : {}),
    ...(now ? { now } : {}),
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
