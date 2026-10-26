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
import { PERMISSION_FIELD_MAX_BYTES } from "../src/agent/permission-limits.js";
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

  test("startTurn 抛错：send 拒绝，不写入孤儿 user_message，preview 不变", async () => {
    const { manager, agent, session } = await setup();
    session.onStartTurn = () => {
      throw new Error("启动失败");
    };
    await expect(manager.sendPrompt(agent.id, "hi", "c-1")).rejects.toThrow("启动失败");
    const entries = (await manager.timeline(agent.id)).entries;
    expect(
      entries.some((e) => e.event.type === "timeline" && e.event.item.type === "user_message"),
    ).toBe(false);
    expect(manager.getAgent(agent.id).preview).toBeUndefined();
  });

  test("startTurn 内同步发出 turn_started：user_message 的 seq 仍在其前", async () => {
    const { manager, agent } = await setup();
    await manager.sendPrompt(agent.id, "hi");
    const entries = (await manager.timeline(agent.id)).entries;
    const userMessage = entries.find(
      (e) => e.event.type === "timeline" && e.event.item.type === "user_message",
    );
    const turnStarted = entries.find((e) => e.event.type === "turn_started");
    expect(userMessage).toBeDefined();
    expect(turnStarted).toBeDefined();
    expect(userMessage!.seq).toBeLessThan(turnStarted!.seq);
  });

  test("单 turn 约束：running 时 send 抛 TURN_IN_PROGRESS", async () => {
    const { manager, agent } = await setup();
    await manager.sendPrompt(agent.id, "first");
    await expect(manager.sendPrompt(agent.id, "second")).rejects.toMatchObject({
      code: "TURN_IN_PROGRESS",
    });
    await expect(manager.sendPrompt(agent.id, "second")).rejects.toBeInstanceOf(AgentRpcError);
  });

  test("CLI 自发轮次：无 send 的 turn_started(origin background) → running，结束后恢复 idle", async () => {
    const { manager, agent, session, streams, states } = await setup();
    session.emit({ type: "turn_started", turnId: "bg-1", origin: "background" });
    await vi.waitFor(() =>
      expect(manager.getAgent(agent.id)).toMatchObject({ status: "running", activeTurnId: "bg-1" }),
    );
    expect(states.at(-1)).toMatchObject({ status: "running", activeTurnId: "bg-1" });
    session.emit({ type: "timeline", item: { type: "tool_call", callId: "c1", name: "Read", status: "running", detail: { type: "read", filePath: "a" } } });
    session.emit({ type: "turn_completed", turnId: "bg-1" });
    await vi.waitFor(() =>
      expect(manager.getAgent(agent.id)).toMatchObject({ status: "idle", activeTurnId: null }),
    );
    expect(streams.map((s) => s.event)).toEqual([
      { type: "turn_started", turnId: "bg-1", origin: "background" },
      expect.objectContaining({ type: "timeline", turnId: "bg-1" }),
      { type: "turn_completed", turnId: "bg-1" },
    ]);
  });

  test("CLI 自发轮次进行中允许 send（由 provider 接管）；普通回合进行中仍 TURN_IN_PROGRESS", async () => {
    const { manager, agent, session, streams } = await setup();
    session.emit({ type: "turn_started", turnId: "bg-1", origin: "background" });
    await vi.waitFor(() => expect(manager.getAgent(agent.id).status).toBe("running"));
    // provider 接管：先结束自发轮次再开新回合（与 Claude provider 的 startTurn 一致）
    session.onStartTurn = (turnId) => {
      session.emit({ type: "turn_completed", turnId: "bg-1" });
      session.emit({ type: "turn_started", turnId });
    };
    const { turnId } = await manager.sendPrompt(agent.id, "插话", "c-1");
    expect(manager.getAgent(agent.id)).toMatchObject({ status: "running", activeTurnId: turnId });
    expect(streams.map((s) => s.event.type)).toEqual([
      "turn_started",
      "timeline",
      "turn_completed",
      "turn_started",
    ]);
    await expect(manager.sendPrompt(agent.id, "再来")).rejects.toMatchObject({ code: "TURN_IN_PROGRESS" });
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

    const timeline = (await manager.timeline(agent.id)).entries.map((e) => e.event);
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
    const resolved = (await manager.timeline(agent.id)).entries.filter(
      (e) => e.event.type === "permission_resolved",
    );
    expect(resolved).toHaveLength(1);
  });

  test("超大审批内容：快照 / 广播 / 时间线里的 input 与 detail 被截断，provider 收到的 updatedInput 仍是原始值", async () => {
    const { manager, agent, session, streams } = await setup();
    await manager.sendPrompt(agent.id, "hi");
    const bigCommand = "x".repeat(PERMISSION_FIELD_MAX_BYTES * 3);
    const bigQuestion = "问".repeat(PERMISSION_FIELD_MAX_BYTES); // 3 倍字节
    const request: AgentPermissionRequest = {
      id: "perm-big",
      provider: "fake",
      name: "AskUserQuestion",
      kind: "question",
      input: { command: bigCommand, note: "短字段", questions: [{ question: "Q?", preview: bigQuestion }] },
      detail: { type: "shell", command: bigCommand },
    };
    session.emit({ type: "permission_requested", request });
    await vi.waitFor(() => expect(manager.getAgent(agent.id).pendingPermissions).toHaveLength(1));

    const sent = manager.getAgent(agent.id).pendingPermissions[0]!;
    const sentCommand = sent.input!.command as string;
    expect(Buffer.byteLength(sentCommand)).toBeLessThan(PERMISSION_FIELD_MAX_BYTES + 100);
    expect(sentCommand).toMatch(/…已截断 \d+ 字节$/);
    expect(sent.input!.note).toBe("短字段");
    expect((sent.detail as { command: string }).command).toMatch(/…已截断 \d+ 字节$/);
    // 广播与时间线里的也是截断后的；整条事件远小于网关的 16 MiB 帧上限
    const streamed = streams.find((e) => e.event.type === "permission_requested")!;
    expect(JSON.stringify(streamed).length).toBeLessThan(2 * 1024 * 1024);
    expect(JSON.stringify((await manager.timeline(agent.id)).entries)).not.toContain(bigCommand);

    // UI 回传的 updatedInput（提问卡会 `{...request.input, answers}`）里没改过的被截断字段，换回原始值再交给 provider
    await manager.respondToPermission(agent.id, "perm-big", {
      behavior: "allow",
      updatedInput: { ...sent.input, answers: { "Q?": "A" } },
    });
    const received = session.responses[0]!.response;
    expect(received).toMatchObject({ behavior: "allow" });
    const updated = (received as { updatedInput: Record<string, unknown> }).updatedInput;
    expect(updated.command).toBe(bigCommand);
    expect((updated.questions as Array<{ preview: string }>)[0]!.preview).toBe(bigQuestion);
    expect(updated.answers).toEqual({ "Q?": "A" });
    // 广播 / 落盘的 permission_resolved 里也不带超大原文
    expect(JSON.stringify((await manager.timeline(agent.id)).entries)).not.toContain(bigCommand);
  });

  test("超大审批：用户改过的字段保持用户的值；不带 updatedInput 时原样透传", async () => {
    const { manager, agent, session } = await setup();
    await manager.sendPrompt(agent.id, "hi");
    const bigCommand = "y".repeat(PERMISSION_FIELD_MAX_BYTES * 2);
    session.emit({
      type: "permission_requested",
      request: { id: "p-a", provider: "fake", name: "shell", kind: "tool", input: { command: bigCommand } },
    });
    session.emit({
      type: "permission_requested",
      request: { id: "p-b", provider: "fake", name: "shell", kind: "tool", input: { command: bigCommand } },
    });
    await vi.waitFor(() => expect(manager.getAgent(agent.id).pendingPermissions).toHaveLength(2));
    await manager.respondToPermission(agent.id, "p-a", { behavior: "allow", updatedInput: { command: "echo 改过" } });
    expect(session.responses[0]!.response).toEqual({ behavior: "allow", updatedInput: { command: "echo 改过" } });
    await manager.respondToPermission(agent.id, "p-b", { behavior: "allow" });
    expect(session.responses[1]!.response).toEqual({ behavior: "allow" });
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
    const events = (await manager.timeline(agent.id)).entries.map((e) => e.event);
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
    const changes = (await manager.timeline(agent.id)).entries.filter(
      (e) => e.event.type === "model_changed",
    );
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
    const all = await manager.timeline(agent.id);
    expect(all.epoch).toBe(manager.epoch);
    expect(all.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect((await manager.timeline(agent.id, 2)).entries.map((e) => e.seq)).toEqual([3, 4]);
    expect((await manager.timeline(agent.id, 4)).entries).toEqual([]);
    await expect(manager.timeline("missing")).rejects.toThrow(AgentRpcError);
  });
});

describe("AgentManager 建会话后补取模式目录", () => {
  const modes = [{ id: "plan", label: "计划" }];

  function createLazyCatalogManager(
    secondFetch: () => Promise<{ models: []; modes: typeof modes }>,
  ) {
    let sessionCreated = false;
    const fetchCatalog = vi.fn(async () => {
      if (!sessionCreated) {
        return { models: [], modes: [] };
      }
      return secondFetch();
    });
    const client: AgentClient = {
      provider: "lazy",
      kind: "acp",
      label: "Lazy",
      isAvailable: async () => ({ available: true }),
      fetchCatalog,
      createSession: async () => {
        sessionCreated = true;
        return new ScriptedSession();
      },
    };
    const manager = new AgentManager({
      registry: { get: (id) => (id === client.provider ? client : undefined) },
    });
    const states: AgentSnapshot[] = [];
    manager.subscribe({ onState: (snapshot) => states.push(snapshot) });
    return { manager, states, fetchCatalog };
  }

  test("建会话前目录为空：建会话后重取并推送 availableModes", async () => {
    const { manager, states, fetchCatalog } = createLazyCatalogManager(async () => ({
      models: [],
      modes,
    }));
    try {
      const agent = await manager.createAgent({ provider: "lazy", cwd: "/work" });
      expect(fetchCatalog).toHaveBeenCalledTimes(2);
      expect(fetchCatalog).toHaveBeenLastCalledWith({ cwd: "/work" });
      expect(agent.availableModes).toEqual(modes);
      expect(agent.modeId).toBeNull();
      expect(manager.getAgent(agent.id).availableModes).toEqual(modes);
      expect(states.at(-1)).toMatchObject({ id: agent.id, availableModes: modes, modeId: null });
    } finally {
      await manager.shutdown();
    }
  });

  test("第二次取目录失败：agent.create 仍成功", async () => {
    const { manager, states, fetchCatalog } = createLazyCatalogManager(async () => {
      throw new Error("boom");
    });
    try {
      const agent = await manager.createAgent({ provider: "lazy", cwd: "/work" });
      expect(fetchCatalog).toHaveBeenCalledTimes(2);
      expect(agent.status).toBe("idle");
      expect(agent.availableModes).toEqual([]);
      expect(states.at(-1)).toMatchObject({ id: agent.id, status: "idle" });
    } finally {
      await manager.shutdown();
    }
  });

  test("建会话前目录非空：不重复请求", async () => {
    const fetchCatalog = vi.fn(async () => ({ models: [], modes }));
    const client: AgentClient = {
      provider: "eager",
      kind: "mock",
      label: "Eager",
      isAvailable: async () => ({ available: true }),
      fetchCatalog,
      createSession: async () => new ScriptedSession(),
    };
    const manager = new AgentManager({ registry: { get: () => client } });
    try {
      const agent = await manager.createAgent({ provider: "eager", cwd: "/work" });
      expect(fetchCatalog).toHaveBeenCalledTimes(1);
      expect(agent.availableModes).toEqual(modes);
    } finally {
      await manager.shutdown();
    }
  });
});

describe("AgentManager：工具调用大小限制（design.md 5.3）", () => {
  test("tool_call 的超大文本被截断、图片块被占位，其它项原样", async () => {
    const { manager, agent, session, streams } = await setup();
    const { turnId } = await manager.sendPrompt(agent.id, "hi");
    await vi.waitFor(() => expect(manager.getAgent(agent.id).status).toBe("running"));

    session.emit({
      type: "timeline",
      turnId,
      item: {
        type: "tool_call",
        callId: "c1",
        name: "mcp__browser__screenshot",
        status: "completed",
        detail: {
          type: "unknown",
          input: { url: "http://x" },
          output: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "A".repeat(300_000) },
            },
            { type: "text", text: "B".repeat(200_000) },
          ],
        },
      },
    });
    const bigAssistant = "C".repeat(100_000);
    session.emit({
      type: "timeline",
      turnId,
      item: { type: "assistant_message", text: bigAssistant },
    });
    await vi.waitFor(() =>
      expect(
        streams.some((s) => s.event.type === "timeline" && s.event.item.type === "assistant_message"),
      ).toBe(true),
    );

    const toolEnvelope = streams.find(
      (s) => s.event.type === "timeline" && s.event.item.type === "tool_call",
    )!;
    const json = JSON.stringify(toolEnvelope.event);
    expect(json.length).toBeLessThan(80_000);
    expect(json).toContain("[图片 约 220 KB，已省略]");
    expect(json).toContain("已截断");
    expect(json).not.toContain("AAAAAAAAAA");

    // assistant_message 不属于工具产物，不处理
    const assistant = streams.find(
      (s) => s.event.type === "timeline" && s.event.item.type === "assistant_message",
    )!;
    expect(JSON.stringify(assistant.event)).toContain(bigAssistant);
  });
});

describe("AgentManager：同 callId 的 tool_call 增量去重（design.md 4.5）", () => {
  test("推 5 次更新后 timeline 只剩首尾两条，sinceSeq 增量能拿到最新一条", async () => {
    const { manager, agent, session } = await setup();
    const { turnId } = await manager.sendPrompt(agent.id, "hi");
    await vi.waitFor(() => expect(manager.getAgent(agent.id).status).toBe("running"));
    await manager.timeline(agent.id); // 先加载内存时间线

    for (let n = 1; n <= 5; n += 1) {
      session.emit({
        type: "timeline",
        turnId,
        item: { type: "tool_call", callId: "c1", name: "Agent", status: "running", detail: { type: "unknown", input: n, output: null } },
      });
    }
    await vi.waitFor(async () => {
      const calls = (await manager.timeline(agent.id)).entries.filter(
        (e) => e.event.type === "timeline" && e.event.item.type === "tool_call",
      );
      expect(calls.length).toBe(2);
    });
    const all = (await manager.timeline(agent.id)).entries;
    const calls = all.filter((e) => e.event.type === "timeline" && e.event.item.type === "tool_call");
    expect(calls[1]!.seq).toBeGreaterThan(calls[0]!.seq);
    const latest = all.reduce((max, e) => Math.max(max, e.seq), 0);
    expect(calls[1]!.seq).toBe(latest);

    const since = (await manager.timeline(agent.id, calls[0]!.seq)).entries;
    expect(since.map((e) => e.seq)).toContain(calls[1]!.seq);
  });
});

describe("AgentManager：sidecar 发起的审批（Computer Use，design.md 4.37）", () => {
  test("requestHostPermission 发出 permission_requested；应答直接完成，不经 provider", async () => {
    const { manager, agent, session } = await setup();
    const { turnId } = await manager.sendPrompt(agent.id, "hi");
    const pending = manager.requestHostPermission(agent.id, {
      name: "agentdeck_cua.click",
      kind: "tool",
      title: "允许 Computer Use：click？",
    });
    await vi.waitFor(() => expect(manager.getAgent(agent.id).pendingPermissions).toHaveLength(1));
    const request = manager.getAgent(agent.id).pendingPermissions[0]!;
    expect(request).toMatchObject({ name: "agentdeck_cua.click", provider: "fake", kind: "tool" });
    expect(request.id).toMatch(/^cu-/);

    await manager.respondToPermission(agent.id, request.id, { behavior: "allow", selectedActionId: "allow" });
    await expect(pending).resolves.toEqual({ behavior: "allow", selectedActionId: "allow" });
    expect(session.responses).toEqual([]);
    expect(manager.getAgent(agent.id).pendingPermissions).toEqual([]);
    const timeline = (await manager.timeline(agent.id)).entries.map((e) => e.event);
    expect(timeline).toContainEqual({ type: "permission_requested", turnId, request });
    expect(timeline.filter((e) => e.type === "permission_resolved")).toHaveLength(1);
  });

  test("回合结束视为拒绝；signal 中断时撤回请求", async () => {
    const { manager, agent, session } = await setup();
    const { turnId } = await manager.sendPrompt(agent.id, "hi");
    const pending = manager.requestHostPermission(agent.id, { name: "agentdeck_cua.click", kind: "tool" });
    await vi.waitFor(() => expect(manager.getAgent(agent.id).pendingPermissions).toHaveLength(1));
    session.emit({ type: "turn_completed", turnId });
    await expect(pending).resolves.toMatchObject({ behavior: "deny" });
    await vi.waitFor(() => expect(manager.getAgent(agent.id).activeTurnId).toBeNull());

    await manager.sendPrompt(agent.id, "again");
    const controller = new AbortController();
    const aborted = manager.requestHostPermission(
      agent.id,
      { name: "agentdeck_cua.click", kind: "tool" },
      controller.signal,
    );
    await vi.waitFor(() => expect(manager.getAgent(agent.id).pendingPermissions).toHaveLength(1));
    controller.abort();
    await expect(aborted).resolves.toEqual({ behavior: "deny", message: "权限请求已取消" });
    await vi.waitFor(() => expect(manager.getAgent(agent.id).pendingPermissions).toEqual([]));
  });

  test("cliApprovesMcpTools 取会话的判断；会话不支持判断或不存在时为 false", async () => {
    const { manager, agent, session } = await setup();
    expect(manager.cliApprovesMcpTools(agent.id)).toBe(false);
    (session as AgentSession).cliApprovesMcpTools = () => true;
    expect(manager.cliApprovesMcpTools(agent.id)).toBe(true);
    expect(manager.cliApprovesMcpTools("missing")).toBe(false);
  });
});
