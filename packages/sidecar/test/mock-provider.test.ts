import type { AgentStreamEvent } from "@agentdeck/protocol";
import { describe, expect, test } from "vitest";

import type { AgentSessionEvent } from "../src/agent/types.js";
import { MockAgentClient } from "../src/providers/mock/index.js";
import { MockAgentSession, splitIntoChunks } from "../src/providers/mock/mock-agent.js";

function collect(session: { subscribe(cb: (e: AgentSessionEvent) => void): () => void }) {
  const events: AgentStreamEvent[] = [];
  session.subscribe((e) => {
    if (e.type !== "provider_subagent" && e.type !== "provider_background_tasks") events.push(e);
  });
  return events;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil 超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("MockAgentClient", () => {
  test("始终可用，目录含 mock-fast（默认）/mock-slow 与 default/plan", async () => {
    const client = new MockAgentClient();
    await expect(client.isAvailable()).resolves.toEqual({ available: true });
    const catalog = await client.fetchCatalog();
    expect(catalog.models).toEqual([
      {
        provider: "mock",
        id: "mock-fast",
        label: "Mock Fast",
        isDefault: true,
        thinkingOptions: [
          { id: "low", label: "低" },
          { id: "high", label: "高" },
        ],
        defaultThinkingOptionId: "high",
      },
      { provider: "mock", id: "mock-slow", label: "Mock Slow" },
    ]);
    expect(catalog.modes.map((m) => m.id)).toEqual(["default", "plan"]);
    await expect(client.createSession({ cwd: ".", modeId: "nope" })).rejects.toThrow();
  });

  test("一轮完整事件序列，首轮才发 thread_started", async () => {
    const session = await new MockAgentClient().createSession({ cwd: "." });
    const events = collect(session);
    const { turnId } = await session.startTurn("hello");
    expect(session.id).toMatch(/^mock-/);
    expect(session.describePersistence()).toEqual({ provider: "mock", sessionId: session.id });
    await waitUntil(() => events.some((e) => e.type === "turn_completed"));
    const types = events.map((e) => (e.type === "timeline" ? `timeline:${e.item.type}` : e.type));
    expect(types[0]).toBe("thread_started");
    expect(types[1]).toBe("turn_started");
    expect(types.filter((t) => t === "timeline:reasoning").length).toBeGreaterThan(0);
    expect(types.indexOf("timeline:tool_call")).toBeLessThan(
      types.indexOf("timeline:assistant_message"),
    );
    expect(types.slice(-2)).toEqual(["usage_updated", "turn_completed"]);
    const chunks = events.filter(
      (e) => e.type === "timeline" && e.item.type === "assistant_message",
    );
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.length).toBeLessThanOrEqual(5);
    expect(events.at(-1)).toMatchObject({ type: "turn_completed", turnId });

    await session.startTurn("again");
    await waitUntil(() => events.filter((e) => e.type === "turn_completed").length === 2);
    expect(events.filter((e) => e.type === "thread_started")).toHaveLength(1);
  });

  test("等待审批时 interrupt：permission_resolved(deny) + turn_canceled", async () => {
    const session = await new MockAgentClient().createSession({ cwd: "." });
    const events = collect(session);
    const { turnId } = await session.startTurn("/approve x");
    await waitUntil(() => events.some((e) => e.type === "permission_requested"));
    expect(session.getPendingPermissions()).toHaveLength(1);
    await session.interrupt();
    expect(session.getPendingPermissions()).toEqual([]);
    expect(events.slice(-2)).toEqual([
      expect.objectContaining({ type: "permission_resolved", response: expect.objectContaining({ behavior: "deny" }) }),
      { type: "turn_canceled", turnId, reason: "interrupted" },
    ]);
    // 中断后不再有后续事件
    const count = events.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events.length).toBe(count);
  });

  test("splitIntoChunks 均分为 3~5 段且可无损拼回", () => {
    for (const text of ["Mock 回复：a", "Mock 回复：" + "长".repeat(100), "Mock 回复：🙂🙂🙂"]) {
      const chunks = splitIntoChunks(text);
      expect(chunks.length).toBeGreaterThanOrEqual(3);
      expect(chunks.length).toBeLessThanOrEqual(5);
      expect(chunks.join("")).toBe(text);
    }
  });
});

describe("MockAgentSession 输出速度（design.md 4.30）", () => {
  test("审批等待不计入 tok/s：等待 60 秒与不等待得到同样的速度", async () => {
    let now = 0;
    const session = new MockAgentSession({ cwd: "." }, null, () => now);
    const events = collect(session);
    session.subscribe((e) => {
      // 每个 reasoning 块推进 1 秒（模拟模型输出耗时），共 3 秒
      if (e.type === "timeline" && e.item.type === "reasoning") now += 1000;
    });
    await session.startTurn("/approve go");
    await waitUntil(() => events.some((e) => e.type === "permission_requested"));
    const request = events.find((e) => e.type === "permission_requested");
    if (request?.type !== "permission_requested") throw new Error("缺少审批请求");
    now += 60_000; // 用户 60 秒后才点允许
    await session.respondToPermission(request.request.id, { behavior: "allow" });
    await waitUntil(() => events.some((e) => e.type === "turn_completed"));

    const done = events.find((e) => e.type === "turn_completed");
    if (done?.type !== "turn_completed") throw new Error("缺少 turn_completed");
    const outputTokens = done.usage?.outputTokens ?? 0;
    expect(outputTokens).toBeGreaterThan(0);
    // 总耗时 63 秒，扣除 60 秒审批等待后只剩 3 秒
    expect(done.usage?.outputTokensPerSecond).toBe(Math.round((outputTokens / 3) * 10) / 10);
  });

  test("耗时不足 1 秒不带速度", async () => {
    let now = 0;
    const session = new MockAgentSession({ cwd: "." }, null, () => now);
    const events = collect(session);
    await session.startTurn("hello");
    await waitUntil(() => events.some((e) => e.type === "turn_completed"));
    const done = events.find((e) => e.type === "turn_completed");
    if (done?.type !== "turn_completed") throw new Error("缺少 turn_completed");
    expect(done.usage?.outputTokensPerSecond).toBeUndefined();
  });
});
