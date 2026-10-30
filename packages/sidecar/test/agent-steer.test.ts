import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentStreamEnvelope,
  AgentStreamEvent,
} from "@agentdeck/protocol";
import { afterEach, describe, expect, test } from "vitest";

import { AgentManager } from "../src/agent/agent-manager.js";
import { AgentRpcError } from "../src/agent/errors.js";
import type { AgentClient, AgentSession } from "../src/agent/types.js";

/** 由测试手动驱动事件的假会话；steer 可开关 */
class SteerSession implements AgentSession {
  readonly provider = "fake";
  id: string | null = null;
  steers: Array<{ prompt: AgentPromptInput; clientMessageId?: string }> = [];
  steerError: Error | null = null;
  steer?: AgentSession["steer"];
  private listeners = new Set<(event: AgentStreamEvent) => void>();
  private counter = 0;

  constructor(supportsSteer: boolean) {
    if (supportsSteer) {
      this.steer = async (prompt, opts) => {
        if (this.steerError) throw this.steerError;
        this.steers.push({
          prompt,
          ...(opts?.clientMessageId !== undefined ? { clientMessageId: opts.clientMessageId } : {}),
        });
      };
    }
  }

  async startTurn(): Promise<{ turnId: string }> {
    this.counter += 1;
    const turnId = `turn-${this.counter}`;
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

  async respondToPermission(_id: string, _r: AgentPermissionResponse): Promise<void> {}
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}

  describePersistence(): AgentPersistenceHandle | null {
    return null;
  }
}

function createHarness(supportsSteer: boolean) {
  const sessions: SteerSession[] = [];
  const client: AgentClient = {
    provider: "fake",
    kind: "mock",
    label: "Fake",
    isAvailable: async () => ({ available: true }),
    fetchCatalog: async () => ({ models: [], modes: [] }),
    createSession: async () => {
      const session = new SteerSession(supportsSteer);
      sessions.push(session);
      return session;
    },
  };
  const manager = new AgentManager({ registry: { get: (id) => (id === "fake" ? client : undefined) } });
  const streams: AgentStreamEnvelope[] = [];
  manager.subscribe({ onStream: (envelope) => streams.push(envelope), onState: () => undefined });
  return { manager, sessions, streams };
}

let current: ReturnType<typeof createHarness> | null = null;

afterEach(async () => {
  await current?.manager.shutdown();
  current = null;
});

async function setup(supportsSteer = true) {
  current = createHarness(supportsSteer);
  const agent = await current.manager.createAgent({ provider: "fake", cwd: "/work" });
  return { ...current, agent, session: current.sessions[0]! };
}

const userMessages = (streams: AgentStreamEnvelope[]) =>
  streams.flatMap((e) =>
    e.event.type === "timeline" && e.event.item.type === "user_message"
      ? [{ seq: e.seq, turnId: e.event.turnId, item: e.event.item }]
      : [],
  );

describe("AgentManager 运行中插话（design.md 4.22）", () => {
  test("成功：provider.steer 收到 prompt 与 clientMessageId，写入 steer 标记的 user_message 并归属当前 turnId，不开新回合", async () => {
    const { manager, agent, session, streams } = await setup();
    const { turnId } = await manager.sendPrompt(agent.id, "先做 A", "cm-1");
    session.emit({ type: "timeline", item: { type: "assistant_message", text: "好的", messageId: "m1" } });
    await manager.steer(agent.id, "顺便做 B", "cm-2");

    expect(session.steers).toEqual([{ prompt: "顺便做 B", clientMessageId: "cm-2" }]);
    const users = userMessages(streams);
    expect(users).toHaveLength(2);
    expect(users[0]!.item).toMatchObject({ text: "先做 A", clientMessageId: "cm-1" });
    expect(users[0]!.item).not.toHaveProperty("steer");
    expect(users[1]).toMatchObject({
      turnId,
      item: { type: "user_message", text: "顺便做 B", clientMessageId: "cm-2", steer: true },
    });
    // 排在已到达的助手文本之后
    const assistantSeq = streams.find(
      (e) => e.event.type === "timeline" && e.event.item.type === "assistant_message",
    )!.seq;
    expect(users[1]!.seq).toBeGreaterThan(assistantSeq);
    expect(streams.filter((e) => e.event.type === "turn_started")).toHaveLength(1);
    expect(manager.getAgent(agent.id).activeTurnId).toBe(turnId);
  });

  test("插话带图片：图片原样给 provider，user_message 只记图片数；无图时省略", async () => {
    const { manager, agent, session, streams } = await setup();
    await manager.sendPrompt(agent.id, "先做 A", "cm-1");
    const prompt = [
      { type: "text" as const, text: "看这张" },
      { type: "image" as const, data: "AAAA", mimeType: "image/png" },
    ];
    await manager.steer(agent.id, prompt, "cm-2");
    await manager.steer(agent.id, "再补一句", "cm-3");

    expect(session.steers[0]).toEqual({ prompt, clientMessageId: "cm-2" });
    const users = userMessages(streams);
    expect(users[1]!.item).toMatchObject({ text: "看这张", steer: true, imageCount: 1 });
    expect(users[2]!.item).not.toHaveProperty("imageCount");
  });

  test("没有进行中的回合 → NOT_SUPPORTED（当前没有进行中的回合），且不写 user_message", async () => {
    const { manager, agent, session, streams } = await setup();
    await expect(manager.steer(agent.id, "x", "cm")).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: "当前没有进行中的回合",
    });
    expect(session.steers).toHaveLength(0);
    expect(userMessages(streams)).toHaveLength(0);
  });

  test("回合结束后再插话同样报没有进行中的回合", async () => {
    const { manager, agent, session } = await setup();
    const { turnId } = await manager.sendPrompt(agent.id, "hi");
    session.emit({ type: "turn_completed", turnId });
    await expect(manager.steer(agent.id, "x")).rejects.toBeInstanceOf(AgentRpcError);
  });

  test("provider 不支持 → NOT_SUPPORTED（该 Agent 不支持运行中插话）", async () => {
    const { manager, agent, streams } = await setup(false);
    await manager.sendPrompt(agent.id, "hi");
    await expect(manager.steer(agent.id, "x", "cm")).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: "该 Agent 不支持运行中插话",
    });
    expect(userMessages(streams)).toHaveLength(1);
  });

  test("provider.steer 失败：错误原样抛出，user_message 不落盘", async () => {
    const { manager, agent, session, streams } = await setup();
    await manager.sendPrompt(agent.id, "hi");
    session.steerError = new Error("Codex 插话失败：当前回合不可插话");
    await expect(manager.steer(agent.id, "x", "cm")).rejects.toThrow("当前回合不可插话");
    expect(userMessages(streams)).toHaveLength(1);
  });

  test("CLI 自发轮次进行中不支持插话", async () => {
    const { manager, agent, session } = await setup();
    session.emit({ type: "turn_started", turnId: "bg-1", origin: "background" });
    await expect(manager.steer(agent.id, "x")).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });
});
