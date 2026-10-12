import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentSnapshot,
  AgentStreamEnvelope,
  AgentStreamEvent,
} from "@agentdeck/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";

import { AgentManager } from "../src/agent/agent-manager.js";
import { AgentRpcError } from "../src/agent/errors.js";
import type { AgentClient, AgentSession } from "../src/agent/types.js";

/** 由测试手动驱动事件的假会话 */
class ScriptedSession implements AgentSession {
  readonly provider = "fake";
  id: string | null = null;
  private listeners = new Set<(event: AgentStreamEvent) => void>();
  private turnCounter = 0;
  /** startTurn 里同步发出的事件（返回 turnId 之前） */
  onStartTurn: (turnId: string) => void = (turnId) =>
    this.emit({ type: "turn_started", turnId });
  /** respondToPermission 时是否自己发 permission_resolved */
  emitsPermissionResolved = true;
  emitsModelChanged = true;
  closed = false;
  responses: Array<{ requestId: string; response: AgentPermissionResponse }> = [];
  interrupts = 0;

  async startTurn(): Promise<{ turnId: string }> {
    this.turnCounter += 1;
    const turnId = `turn-${this.turnCounter}`;
    this.onStartTurn(turnId);
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

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    this.responses.push({ requestId, response });
    if (this.emitsPermissionResolved) {
      this.emit({ type: "permission_resolved", requestId, response });
    }
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  describePersistence(): AgentPersistenceHandle | null {
    return this.id ? { provider: "fake", sessionId: this.id } : null;
  }

  async setModel(modelId: string | null): Promise<void> {
    if (this.emitsModelChanged) {
      this.emit({ type: "model_changed", modelId });
    }
  }
}

function createHarness() {
  const sessions: ScriptedSession[] = [];
  const client: AgentClient = {
    provider: "fake",
    kind: "mock",
    label: "Fake",
    isAvailable: async () => ({ available: true }),
    fetchCatalog: async () => ({ models: [], modes: [{ id: "default", label: "默认" }] }),
    createSession: async () => {
      const session = new ScriptedSession();
      sessions.push(session);
      return session;
    },
  };
  const unavailable: AgentClient = {
    ...client,
    provider: "down",
    isAvailable: async () => ({ available: false, reason: "未安装" }),
  };
  const clients = new Map([
    [client.provider, client],
    [unavailable.provider, unavailable],
  ]);
  const manager = new AgentManager({ registry: { get: (id) => clients.get(id) } });
  const streams: AgentStreamEnvelope[] = [];
  const states: AgentSnapshot[] = [];
  manager.subscribe({
    onStream: (envelope) => streams.push(envelope),
    onState: (snapshot) => states.push(snapshot),
  });
  return { manager, sessions, streams, states };
}

const permissionRequest: AgentPermissionRequest = {
  id: "perm-1",
  provider: "fake",
  name: "shell",
  kind: "tool",
};

let current: ReturnType<typeof createHarness> | null = null;

afterEach(async () => {
  await current?.manager.shutdown();
  current = null;
});

async function setup() {
  current = createHarness();
  const agent = await current.manager.createAgent({ provider: "fake", cwd: "/work" });
  return { ...current, agent, session: current.sessions[0]! };
}

describe("AgentManager", () => {
  test("创建：idle 快照 + agent.state 推送", async () => {
    const { agent, states } = await setup();
    expect(agent).toMatchObject({
      provider: "fake",
      cwd: "/work",
      status: "idle",
      activeTurnId: null,
      pendingPermissions: [],
      availableModes: [{ id: "default", label: "默认" }],
    });
    expect(agent.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(states).toEqual([agent]);
  });

  test("provider 不存在 / 不可用时报业务错误", async () => {
    current = createHarness();
    await expect(current.manager.createAgent({ provider: "x", cwd: "/" })).rejects.toMatchObject({
      code: "PROVIDER_NOT_FOUND",
    });
    await expect(
      current.manager.createAgent({ provider: "down", cwd: "/" }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", message: "未安装" });
  });

  test("状态迁移：turn_started → running，turn_completed → idle", async () => {
    const { manager, agent, session, streams } = await setup();
    const { turnId } = await manager.sendPrompt(agent.id, "hi");
    await vi.waitFor(() => expect(manager.getAgent(agent.id).status).toBe("running"));
    expect(manager.getAgent(agent.id).activeTurnId).toBe(turnId);

    session.emit({ type: "turn_completed", turnId, usage: { outputTokens: 3 } });
    await vi.waitFor(() => expect(manager.getAgent(agent.id).status).toBe("idle"));
    expect(manager.getAgent(agent.id)).toMatchObject({
      activeTurnId: null,
      lastUsage: { outputTokens: 3 },
    });
    expect(streams.map((s) => s.seq)).toEqual([1, 2, 3]);
    expect(streams.map((s) => s.event.type)).toEqual([
      "timeline",
      "turn_started",
      "turn_completed",
    ]);
  });

  test("turn_failed 记 lastError，下一轮 turn_started 清空", async () => {
    const { manager, agent, session } = await setup();
    const { turnId } = await manager.sendPrompt(agent.id, "hi");
    session.emit({ type: "turn_failed", turnId, error: "炸了" });
    await vi.waitFor(() =>
      expect(manager.getAgent(agent.id)).toMatchObject({ status: "idle", lastError: "炸了" }),
    );
    await manager.sendPrompt(agent.id, "again");
    await vi.waitFor(() =>
      expect(manager.getAgent(agent.id)).toMatchObject({ status: "running", lastError: null }),
    );
  });

  test("session 不发 turn_started 时，startTurn 返回后也标记 running", async () => {
    const { manager, agent, session } = await setup();
    session.onStartTurn = () => undefined;
    const { turnId } = await manager.sendPrompt(agent.id, "hi");
    await vi.waitFor(() =>
      expect(manager.getAgent(agent.id)).toMatchObject({ status: "running", activeTurnId: turnId }),
    );
  });

  test("turn 在 startTurn 返回前就结束时保持 idle", async () => {
    const { manager, agent, session } = await setup();
    session.onStartTurn = (turnId) => {
      session.emit({ type: "turn_started", turnId });
      session.emit({ type: "turn_completed", turnId });
    };
    await manager.sendPrompt(agent.id, "hi");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(manager.getAgent(agent.id)).toMatchObject({ status: "idle", activeTurnId: null });
  });

  test("单 turn 约束：running 时 send 抛 TURN_IN_PROGRESS", async () => {
    const { manager, agent } = await setup();
    await manager.sendPrompt(agent.id, "first");
    await expect(manager.sendPrompt(agent.id, "second")).rejects.toMatchObject({
      code: "TURN_IN_PROGRESS",
    });
    await expect(manager.sendPrompt(agent.id, "second")).rejects.toBeInstanceOf(AgentRpcError);
  });

  test("permission_requested / permission_resolved 维护 pendingPermissions", async () => {
    const { manager, agent, session, states } = await setup();
    const { turnId } = await manager.sendPrompt(agent.id, "hi");
    session.emit({ type: "permission_requested", request: permissionRequest });
    await vi.waitFor(() =>
      expect(manager.getAgent(agent.id).pendingPermissions).toEqual([permissionRequest]),
    );
    expect(states.at(-1)?.pendingPermissions).toEqual([permissionRequest]);

    await manager.respondToPermission(agent.id, "perm-1", { behavior: "allow" });
    expect(session.responses).toEqual([{ requestId: "perm-1", response: { behavior: "allow" } }]);
    expect(manager.getAgent(agent.id).pendingPermissions).toEqual([]);
    expect(states.at(-1)?.pendingPermissions).toEqual([]);

    const timeline = manager.timeline(agent.id).entries.map((e) => e.event);
    // permission_requested 自动补上当前 turnId；permission_resolved 不重复
    expect(timeline).toContainEqual({
      type: "permission_requested",
      turnId,
      request: permissionRequest,
    });
    expect(timeline.filter((e) => e.type === "permission_resolved")).toHaveLength(1);
  });

  test("session 不发 permission_resolved 时由 manager 兜底补发", async () => {
    const { manager, agent, session } = await setup();
    session.emitsPermissionResolved = false;
    await manager.sendPrompt(agent.id, "hi");
    session.emit({ type: "permission_requested", request: permissionRequest });
    await vi.waitFor(() => expect(manager.getAgent(agent.id).pendingPermissions).toHaveLength(1));
    await manager.respondToPermission(agent.id, "perm-1", { behavior: "deny" });
    expect(manager.getAgent(agent.id).pendingPermissions).toEqual([]);
    const resolved = manager
      .timeline(agent.id)
      .entries.filter((e) => e.event.type === "permission_resolved");
    expect(resolved).toHaveLength(1);
  });

  test("respond 未知请求抛 PERMISSION_NOT_FOUND", async () => {
    const { manager, agent } = await setup();
    await expect(
      manager.respondToPermission(agent.id, "nope", { behavior: "allow" }),
    ).rejects.toMatchObject({ code: "PERMISSION_NOT_FOUND" });
  });

  test("turn 结束时清空残留的 pendingPermissions", async () => {
    const { manager, agent, session } = await setup();
    const { turnId } = await manager.sendPrompt(agent.id, "hi");
    session.emit({ type: "permission_requested", request: permissionRequest });
    session.emit({ type: "turn_canceled", turnId, reason: "interrupted" });
    await vi.waitFor(() =>
      expect(manager.getAgent(agent.id)).toMatchObject({ status: "idle", pendingPermissions: [] }),
    );
  });

  test("文本 chunk 经 coalescer 合并后按顺序发出", async () => {
    const { manager, agent, session } = await setup();
    const { turnId } = await manager.sendPrompt(agent.id, "hi");
    for (const text of ["a", "b", "c", "d"]) {
      session.emit({ type: "timeline", item: { type: "assistant_message", text } });
    }
    session.emit({ type: "turn_completed", turnId });
    await vi.waitFor(() => expect(manager.getAgent(agent.id).status).toBe("idle"));
    const events = manager.timeline(agent.id).entries.map((e) => e.event);
    const texts = events.flatMap((e) =>
      e.type === "timeline" && e.item.type === "assistant_message" ? [e.item.text] : [],
    );
    expect(texts.join("")).toBe("abcd");
    expect(texts.length).toBeLessThan(4); // 首个 chunk 立即发出，其余合并
    expect(events.at(-1)?.type).toBe("turn_completed");
    // timeline 事件补上了 turnId
    expect(
      events.filter((e) => e.type === "timeline" && e.item.type === "assistant_message"),
    ).toSatisfy((list: AgentStreamEvent[]) =>
      list.every((e) => e.type === "timeline" && e.turnId === turnId),
    );
  });

  test("thread_started 更新 persistence", async () => {
    const { manager, agent, session } = await setup();
    session.id = "native-1";
    session.emit({ type: "thread_started", sessionId: "native-1" });
    await vi.waitFor(() =>
      expect(manager.getAgent(agent.id).persistence).toEqual({
        provider: "fake",
        sessionId: "native-1",
      }),
    );
  });

  test("setModel：session 不发 model_changed 时兜底补发；重复值去重", async () => {
    const { manager, agent, session } = await setup();
    session.emitsModelChanged = false;
    await expect(manager.setModel(agent.id, "m1")).resolves.toMatchObject({ model: "m1" });
    session.emitsModelChanged = true;
    await manager.setModel(agent.id, "m1");
    const changes = manager
      .timeline(agent.id)
      .entries.filter((e) => e.event.type === "model_changed");
    expect(changes).toHaveLength(1);
  });

  test("setMode 不支持时抛 NOT_SUPPORTED", async () => {
    const { manager, agent } = await setup();
    await expect(manager.setMode(agent.id, "plan")).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
    });
  });

  test("cancel 调用 session.interrupt；空闲时不调用", async () => {
    const { manager, agent, session } = await setup();
    await manager.cancel(agent.id);
    expect(session.interrupts).toBe(0);
    await manager.sendPrompt(agent.id, "hi");
    await manager.cancel(agent.id);
    expect(session.interrupts).toBe(1);
  });

  test("close 关闭会话并置 closed；shutdown 关闭全部", async () => {
    const { manager, agent, session, states } = await setup();
    const second = await manager.createAgent({ provider: "fake", cwd: "/b" });
    await manager.close(agent.id);
    expect(session.closed).toBe(true);
    expect(manager.getAgent(agent.id).status).toBe("closed");
    expect(states.at(-1)).toMatchObject({ id: agent.id, status: "closed" });
    await expect(manager.sendPrompt(agent.id, "x")).rejects.toMatchObject({
      code: "AGENT_CLOSED",
    });
    // close 幂等
    await manager.close(agent.id);

    await manager.shutdown();
    expect(current!.sessions[1]!.closed).toBe(true);
    expect(manager.getAgent(second.id).status).toBe("closed");
  });

  test("timeline sinceSeq 与 epoch", async () => {
    const { manager, agent, session } = await setup();
    const { turnId } = await manager.sendPrompt(agent.id, "hi");
    session.emit({ type: "usage_updated", usage: { inputTokens: 1 } });
    session.emit({ type: "turn_completed", turnId });
    await vi.waitFor(() => expect(manager.getAgent(agent.id).status).toBe("idle"));
    const all = manager.timeline(agent.id);
    expect(all.epoch).toBe(manager.epoch);
    expect(all.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(manager.timeline(agent.id, 2).entries.map((e) => e.seq)).toEqual([3, 4]);
    expect(manager.timeline(agent.id, 4).entries).toEqual([]);
    expect(() => manager.timeline("missing")).toThrow(AgentRpcError);
  });
});
