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


describe("AgentManager 撤回（design.md 4.16）", () => {
  const image = { type: "image" as const, data: "QUJD", mimeType: "image/png" };
  const prompt = [{ type: "text" as const, text: "你好" }, image];

  test("无输出时撤回成功：返回 prompt（含图片）、写 retracted 事件并中断，回放含该事件", async () => {
    const { manager, agent, session, streams } = await setup();
    const { turnId } = await manager.sendPrompt(agent.id, prompt, "cm-1");
    session.emit({ type: "usage_updated", usage: { inputTokens: 1 } });
    const result = await manager.retract(agent.id);
    expect(result).toEqual({ prompt, clientMessageId: "cm-1" });
    expect(session.interrupts).toBe(1);
    session.emit({ type: "turn_canceled", turnId, reason: "interrupted" });
    await vi.waitFor(() => expect(manager.getAgent(agent.id).status).toBe("idle"));
    const events = (await manager.timeline(agent.id)).entries.map((e) => e.event);
    expect(events).toContainEqual({
      type: "user_message_retracted",
      turnId,
      clientMessageId: "cm-1",
    });
    expect(streams.map((e) => e.event.type)).toContain("user_message_retracted");
    // 回合结束后不可再撤回
    await expect(manager.retract(agent.id)).rejects.toMatchObject({ code: "RETRACT_UNAVAILABLE" });
  });

  test("重复撤回返回 RETRACT_UNAVAILABLE", async () => {
    const { manager, agent } = await setup();
    await manager.sendPrompt(agent.id, "hi");
    const first = manager.retract(agent.id);
    await expect(manager.retract(agent.id)).rejects.toMatchObject({ code: "RETRACT_UNAVAILABLE" });
    await first;
  });

  test("已有 assistant 输出时不可撤回", async () => {
    const { manager, agent, session } = await setup();
    await manager.sendPrompt(agent.id, "hi");
    session.emit({ type: "timeline", item: { type: "assistant_message", text: "嗯" } });
    await expect(manager.retract(agent.id)).rejects.toMatchObject({
      code: "RETRACT_UNAVAILABLE",
      message: "Agent 已开始响应，无法撤回",
    });
    expect(session.interrupts).toBe(0);
  });

  test("已有权限请求时不可撤回", async () => {
    const { manager, agent, session } = await setup();
    await manager.sendPrompt(agent.id, "hi");
    session.emit({ type: "permission_requested", request: permissionRequest });
    await expect(manager.retract(agent.id)).rejects.toMatchObject({ code: "RETRACT_UNAVAILABLE" });
  });

  test("自发轮次与空闲时不可撤回", async () => {
    const { manager, agent, session } = await setup();
    await expect(manager.retract(agent.id)).rejects.toMatchObject({ code: "RETRACT_UNAVAILABLE" });
    session.emit({ type: "turn_started", turnId: "bg-1", origin: "background" });
    await vi.waitFor(() => expect(manager.getAgent(agent.id).status).toBe("running"));
    await expect(manager.retract(agent.id)).rejects.toMatchObject({ code: "RETRACT_UNAVAILABLE" });
  });
});
