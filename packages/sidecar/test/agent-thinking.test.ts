// design.md 4.10：AgentManager 的思考强度（建会话传参、会话内切换、模型切换回退、持久化与恢复重放）
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentSnapshot, AgentStreamEnvelope } from "@agentdeck/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";

import { AgentManager } from "../src/agent/agent-manager.js";
import { AgentStore } from "../src/agent/agent-store.js";
import type { AgentClient } from "../src/agent/types.js";
import { MockAgentClient, MockAgentSession } from "../src/providers/mock/mock-agent.js";

const managers: AgentManager[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(managers.splice(0).map((manager) => manager.shutdown()));
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function createManager(client: AgentClient = new MockAgentClient(), dataDir?: string) {
  const manager = new AgentManager({
    registry: { get: (id) => (id === client.provider ? client : undefined) },
    coalesceWindowMs: 0,
    ...(dataDir ? { store: new AgentStore({ dataDir }) } : {}),
  });
  managers.push(manager);
  const streams: AgentStreamEnvelope[] = [];
  const states: AgentSnapshot[] = [];
  manager.subscribe({
    onStream: (envelope) => streams.push(envelope),
    onState: (snapshot) => states.push(snapshot),
  });
  const thinkingEvents = () =>
    streams.flatMap((envelope) =>
      envelope.event.type === "thinking_option_changed" ? [envelope.event.thinkingOptionId] : [],
    );
  return { manager, streams, states, thinkingEvents };
}

describe("AgentManager：思考强度", () => {
  test("agent.create 传入的档位随快照返回并交给 provider；省略时为 null", async () => {
    const createSpy = vi.spyOn(MockAgentClient.prototype, "createSession");
    const { manager } = createManager();
    const plain = await manager.createAgent({ provider: "mock", cwd: "/w" });
    expect(plain.thinkingOptionId).toBeNull();
    expect(createSpy.mock.calls[0]![0]).not.toHaveProperty("thinkingOptionId");

    const low = await manager.createAgent({ provider: "mock", cwd: "/w", thinkingOptionId: "low" });
    expect(low.thinkingOptionId).toBe("low");
    expect(createSpy.mock.calls[1]![0]).toMatchObject({ thinkingOptionId: "low" });

    await expect(
      manager.createAgent({ provider: "mock", cwd: "/w", thinkingOptionId: "turbo" }),
    ).rejects.toThrow("Mock 不支持思考强度：turbo");
  });

  test("setThinking 更新快照、推 agent.state 与 thinking_option_changed（重复值去重）；空闲时无提示", async () => {
    const { manager, states, thinkingEvents } = createManager();
    const agent = await manager.createAgent({ provider: "mock", cwd: "/w" });
    const result = await manager.setThinking(agent.id, "high");
    expect(result.agent.thinkingOptionId).toBe("high");
    expect(result.notice).toBeUndefined();
    expect(states.at(-1)?.thinkingOptionId).toBe("high");
    await manager.setThinking(agent.id, "high");
    await manager.setThinking(agent.id, null);
    expect(thinkingEvents()).toEqual(["high", null]);
    await expect(manager.setThinking(agent.id, "turbo")).rejects.toThrow();
    expect(manager.getAgent(agent.id).thinkingOptionId).toBeNull();
  });

  test("运行中切换：返回「下一轮生效」提示", async () => {
    const { manager } = createManager();
    const agent = await manager.createAgent({ provider: "mock", cwd: "/w", model: "mock-slow" });
    await manager.sendPrompt(agent.id, "慢一点");
    expect(manager.getAgent(agent.id).status).toBe("running");
    const result = await manager.setThinking(agent.id, "low");
    expect(result).toMatchObject({ notice: "思考强度将在下一轮生效" });
    expect(result.agent.thinkingOptionId).toBe("low");
    await manager.cancel(agent.id);
  });

  test("切换模型：新模型不支持当前档位时回退为 null 并发事件；支持时保持", async () => {
    const { manager, thinkingEvents } = createManager();
    const agent = await manager.createAgent({ provider: "mock", cwd: "/w", thinkingOptionId: "low" });
    // mock-fast（默认模型，null 时按 isDefault 查）支持 low：保持
    await manager.setModel(agent.id, null);
    await manager.setModel(agent.id, "mock-fast");
    expect(manager.getAgent(agent.id).thinkingOptionId).toBe("low");
    // mock-slow 没有档位：回退
    const switched = await manager.setModel(agent.id, "mock-slow");
    expect(switched).toMatchObject({ model: "mock-slow", thinkingOptionId: null });
    expect(thinkingEvents()).toEqual([null]);
    // 已是 null：再切模型不再发事件
    await manager.setModel(agent.id, "mock-fast");
    expect(thinkingEvents()).toEqual([null]);
  });

  test("目录里找不到新模型时不动档位", async () => {
    const { manager } = createManager();
    const agent = await manager.createAgent({ provider: "mock", cwd: "/w", thinkingOptionId: "high" });
    // mock 的 setModel 拒绝未知模型；用 setModel 可接受但目录里没有的场景：直接伪造目录
    vi.spyOn(MockAgentSession.prototype, "setModel").mockImplementation(async () => undefined);
    await manager.setModel(agent.id, "custom-x");
    expect(manager.getAgent(agent.id)).toMatchObject({ model: "custom-x", thinkingOptionId: "high" });
  });

  test("provider 不支持 setThinking → NOT_SUPPORTED", async () => {
    const mock = new MockAgentClient();
    const client: AgentClient = {
      provider: "plain",
      kind: "mock",
      label: "Plain",
      isAvailable: async () => ({ available: true }),
      fetchCatalog: async () => ({ models: [], modes: [] }),
      createSession: async (cfg) => {
        const session = await mock.createSession(cfg);
        return Object.assign(Object.create(Object.getPrototypeOf(session) as object), session, {
          setThinking: undefined,
        });
      },
    };
    const { manager } = createManager(client);
    const agent = await manager.createAgent({ provider: "plain", cwd: "/w" });
    await expect(manager.setThinking(agent.id, "low")).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });

  test("持久化：thinkingOptionId 写入 meta.json；dormant 时 setThinking 返回 AGENT_CLOSED；恢复后重新设置", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "agentdeck-thinking-"));
    tempDirs.push(dataDir);
    const one = createManager(new MockAgentClient(), dataDir);
    const agent = await one.manager.createAgent({ provider: "mock", cwd: "/w" });
    await one.manager.sendPrompt(agent.id, "你好");
    await vi.waitFor(() => expect(one.manager.getAgent(agent.id).status).toBe("idle"), { timeout: 5_000 });
    await one.manager.setThinking(agent.id, "low");
    await one.manager.shutdown();
    const meta = JSON.parse(readFileSync(path.join(dataDir, "agents", agent.id, "meta.json"), "utf8")) as {
      thinkingOptionId?: unknown;
    };
    expect(meta.thinkingOptionId).toBe("low");

    const setThinkingSpy = vi.spyOn(MockAgentSession.prototype, "setThinking");
    const two = createManager(new MockAgentClient(), dataDir);
    await two.manager.restore();
    expect(two.manager.getAgent(agent.id)).toMatchObject({ status: "dormant", thinkingOptionId: "low" });
    await expect(two.manager.setThinking(agent.id, "high")).rejects.toMatchObject({ code: "AGENT_CLOSED" });

    await two.manager.sendPrompt(agent.id, "再来");
    expect(setThinkingSpy).toHaveBeenCalledWith("low");
    // 重放产生的事件与快照相同，被去重
    expect(two.thinkingEvents()).toEqual([]);
    await vi.waitFor(() => expect(two.manager.getAgent(agent.id).status).toBe("idle"), { timeout: 5_000 });
  });
});
