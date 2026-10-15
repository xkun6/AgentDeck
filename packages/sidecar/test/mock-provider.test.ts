import type { AgentQuestion, AgentStreamEvent } from "@agentdeck/protocol";
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

  test("respond 找不到待处理请求抛 PERMISSION_NOT_FOUND", async () => {
    const session = await new MockAgentClient().createSession({ cwd: "." });
    const events = collect(session);
    await expect(session.respondToPermission("nope", { behavior: "deny" })).rejects.toMatchObject({
      code: "PERMISSION_NOT_FOUND",
    });
    await session.startTurn("/approve");
    await waitUntil(() => events.some((e) => e.type === "permission_requested"));
    const [request] = session.getPendingPermissions();
    await session.respondToPermission(request!.id, { behavior: "allow" });
    await expect(session.respondToPermission(request!.id, { behavior: "allow" })).rejects.toMatchObject({
      code: "PERMISSION_NOT_FOUND",
    });
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

  /** 取回合中 assistant_message 拼出的完整回复 */
  const replyOf = (events: AgentStreamEvent[]) =>
    events
      .filter((e) => e.type === "timeline" && e.item.type === "assistant_message")
      .map((e) => (e.type === "timeline" && e.item.type === "assistant_message" ? e.item.text : ""))
      .join("");

  test("/question：kind question，两题（单选带 preview + 多选），应答后回显收到的回答", async () => {
    const session = await new MockAgentClient().createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("/question");
    await waitUntil(() => events.some((e) => e.type === "permission_requested"));
    const [request] = session.getPendingPermissions();
    expect(request).toMatchObject({ kind: "question", name: "AskUserQuestion", detail: { type: "question" } });
    const questions = (request!.detail as { questions: AgentQuestion[] }).questions;
    expect(questions).toHaveLength(2);
    expect(questions[0]).toMatchObject({ multiSelect: false });
    expect(questions[0]!.options.every((o) => typeof o.preview === "string")).toBe(true);
    expect(questions[1]).toMatchObject({ multiSelect: true });
    expect(request!.input).toEqual({ questions });
    expect(request!.actions?.map((a) => a.id)).toEqual(["submit", "skip"]);
    await session.respondToPermission(request!.id, {
      behavior: "allow",
      selectedActionId: "submit",
      updatedInput: { ...request!.input, answers: { "用哪个日期库？": "luxon", "启用哪些功能？": "缓存, 自定义" } },
    });
    await waitUntil(() => events.some((e) => e.type === "turn_completed"));
    expect(replyOf(events)).toBe("Mock 收到的回答：\n- 用哪个日期库？ → luxon\n- 启用哪些功能？ → 缓存, 自定义");
  });

  test("/question 跳过：回显跳过", async () => {
    const session = await new MockAgentClient().createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("/question");
    await waitUntil(() => events.some((e) => e.type === "permission_requested"));
    await session.respondToPermission(session.getPendingPermissions()[0]!.id, {
      behavior: "deny",
      selectedActionId: "skip",
      message: "用户跳过了这些问题",
    });
    await waitUntil(() => events.some((e) => e.type === "turn_completed"));
    expect(replyOf(events)).toBe("Mock 收到：跳过了问题（用户跳过了这些问题）");
  });

  test("/plan：kind plan 带 Markdown 计划；批准 / 继续规划（含意见）后回显", async () => {
    const session = await new MockAgentClient().createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("/plan");
    await waitUntil(() => events.some((e) => e.type === "permission_requested"));
    const [request] = session.getPendingPermissions();
    expect(request).toMatchObject({ kind: "plan", name: "ExitPlanMode", detail: { type: "plan" } });
    const text = (request!.detail as { text: string }).text;
    expect(text).toMatch(/^## /);
    expect(text).toContain("```ts");
    expect(request!.actions?.map((a) => a.id)).toEqual(["approve", "keep_planning"]);
    await session.respondToPermission(request!.id, { behavior: "deny", selectedActionId: "keep_planning", message: "先补测试" });
    await waitUntil(() => events.some((e) => e.type === "turn_completed"));
    expect(replyOf(events)).toBe("Mock 收到：继续规划，意见：先补测试");

    await session.startTurn("/plan");
    await waitUntil(() => events.filter((e) => e.type === "permission_requested").length === 2);
    await session.respondToPermission(session.getPendingPermissions()[0]!.id, { behavior: "allow", selectedActionId: "approve" });
    await waitUntil(() => events.filter((e) => e.type === "turn_completed").length === 2);
    expect(replyOf(events.slice(events.findLastIndex((e) => e.type === "turn_started")))).toBe("Mock 收到：计划已批准");
  });

  test("/multi：同时挂起 2 条工具审批，逐条应答后回显各自结果（含拒绝理由）", async () => {
    const session = await new MockAgentClient().createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("/multi");
    await waitUntil(() => events.filter((e) => e.type === "permission_requested").length === 2);
    const pending = session.getPendingPermissions();
    expect(pending).toHaveLength(2);
    expect(pending.map((r) => r.kind)).toEqual(["tool", "tool"]);
    expect(new Set(pending.map((r) => r.id)).size).toBe(2);
    await session.respondToPermission(pending[0]!.id, { behavior: "allow", selectedActionId: "allow" });
    expect(session.getPendingPermissions().map((r) => r.id)).toEqual([pending[1]!.id]);
    await session.respondToPermission(pending[1]!.id, { behavior: "deny", selectedActionId: "deny", message: "太危险" });
    await waitUntil(() => events.some((e) => e.type === "turn_completed"));
    expect(replyOf(events)).toBe("Mock 收到的处理结果：\n- 第 1 条：允许\n- 第 2 条：拒绝，理由：太危险");
  });

  test("/multi 等待时 interrupt：每条挂起的审批都发 permission_resolved", async () => {
    const session = await new MockAgentClient().createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("/multi");
    await waitUntil(() => events.filter((e) => e.type === "permission_requested").length === 2);
    await session.interrupt();
    expect(session.getPendingPermissions()).toEqual([]);
    expect(events.filter((e) => e.type === "permission_resolved")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "turn_canceled" });
  });

  test("/elicit：kind elicitation 的 form 模式，覆盖 string / select / boolean / number / multiselect；提交后回显内容", async () => {
    const session = await new MockAgentClient().createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("/elicit");
    await waitUntil(() => events.some((e) => e.type === "permission_requested"));
    const [request] = session.getPendingPermissions();
    expect(request).toMatchObject({ kind: "elicitation", detail: { type: "elicitation", mode: "form" } });
    const fields = (request!.detail as { fields: Array<{ type: string; required: boolean }> }).fields;
    expect(fields.map((f) => f.type)).toEqual(["string", "select", "boolean", "number", "multiselect"]);
    expect(fields[0]!.required).toBe(true);
    expect(request!.actions?.map((a) => a.id)).toEqual(["submit", "decline", "cancel"]);
    await session.respondToPermission(request!.id, {
      behavior: "allow",
      selectedActionId: "submit",
      updatedInput: { content: { name: "abc", level: "high", enabled: false, ratio: 3, tags: ["alpha", "beta"] } },
    });
    await waitUntil(() => events.some((e) => e.type === "turn_completed"));
    expect(replyOf(events)).toBe(
      'Mock 收到的表单内容：\n- name → "abc"\n- level → "high"\n- enabled → false\n- ratio → 3\n- tags → ["alpha","beta"]',
    );
    // 表单内容不进 permission_resolved
    expect(events.find((e) => e.type === "permission_resolved")).toMatchObject({
      response: { behavior: "allow", selectedActionId: "submit" },
    });
    expect(JSON.stringify(events.find((e) => e.type === "permission_resolved"))).not.toContain("abc");
  });

  test("/elicit 拒绝只回显拒绝；取消会中断本回合", async () => {
    const session = await new MockAgentClient().createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("/elicit");
    await waitUntil(() => events.some((e) => e.type === "permission_requested"));
    await session.respondToPermission(session.getPendingPermissions()[0]!.id, { behavior: "deny", selectedActionId: "decline" });
    await waitUntil(() => events.some((e) => e.type === "turn_completed"));
    expect(replyOf(events)).toBe("Mock 收到：拒绝");

    const events2 = collect(session);
    await session.startTurn("/elicit");
    await waitUntil(() => events2.some((e) => e.type === "permission_requested"));
    await session.respondToPermission(session.getPendingPermissions()[0]!.id, {
      behavior: "deny",
      selectedActionId: "cancel",
      interrupt: true,
    });
    await waitUntil(() => events2.some((e) => e.type === "turn_canceled"));
    expect(session.getPendingPermissions()).toEqual([]);
  });

  test("/elicit-url：url 模式带链接，「已完成」后回显", async () => {
    const session = await new MockAgentClient().createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("/elicit-url");
    await waitUntil(() => events.some((e) => e.type === "permission_requested"));
    const [request] = session.getPendingPermissions();
    expect(request).toMatchObject({
      kind: "elicitation",
      detail: { type: "elicitation", mode: "url", url: "https://example.com/mock-auth", elicitationId: "mock-elicit-1" },
    });
    expect(request!.actions?.map((a) => a.id)).toEqual(["done", "decline", "cancel"]);
    await session.respondToPermission(request!.id, { behavior: "allow", selectedActionId: "done" });
    await waitUntil(() => events.some((e) => e.type === "turn_completed"));
    expect(replyOf(events)).toBe("Mock 收到：浏览器流程已完成");
  });

  test("/always：工具审批带 allow_session / allow_project，回显收到的动作 id", async () => {
    const session = await new MockAgentClient().createSession({ cwd: "." });
    const events = collect(session);
    for (const [index, id] of ["allow_session", "allow_project", "deny"].entries()) {
      await session.startTurn("/always");
      await waitUntil(() => events.filter((e) => e.type === "permission_requested").length === index + 1);
      const [request] = session.getPendingPermissions();
      expect(request).toMatchObject({ kind: "tool", name: "shell" });
      expect(request!.defaultDeny).toBeUndefined();
      expect(request!.actions?.map((a) => [a.id, a.persist])).toEqual([
        ["allow", undefined],
        ["deny", undefined],
        ["allow_session", "session"],
        ["allow_project", "permanent"],
      ]);
      await session.respondToPermission(request!.id, {
        behavior: id === "deny" ? "deny" : "allow",
        selectedActionId: id,
      });
      await waitUntil(() => events.filter((e) => e.type === "turn_completed").length === index + 1);
    }
    const replies = events
      .filter((e) => e.type === "timeline" && e.item.type === "assistant_message")
      .map((e) => (e.type === "timeline" && e.item.type === "assistant_message" ? e.item.text : ""))
      .join("");
    expect(replies).toContain("Mock 收到的动作：allow_session（本会话始终允许，允许）");
    expect(replies).toContain("Mock 收到的动作：allow_project（永久允许，允许）");
    expect(replies).toContain("Mock 收到的动作：deny（拒绝，拒绝）");
  });

  test("/always-deny：defaultDeny 为 true（不能与 /always 混淆）", async () => {
    const session = await new MockAgentClient().createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("/always-deny");
    await waitUntil(() => events.some((e) => e.type === "permission_requested"));
    expect(session.getPendingPermissions()[0]).toMatchObject({ defaultDeny: true });
    await session.interrupt();
  });

  test("/textq：纯文本题 + secret 题 + 不允许其他的单选；回显时遮罩题只显示长度", async () => {
    const session = await new MockAgentClient().createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("/textq");
    await waitUntil(() => events.some((e) => e.type === "permission_requested"));
    const [request] = session.getPendingPermissions();
    expect(request).toMatchObject({ kind: "question", detail: { type: "question" } });
    const questions = (request!.detail as { questions: AgentQuestion[] }).questions;
    expect(questions.map((q) => [q.freeText === true, q.isSecret === true, q.isOther])).toEqual([
      [true, false, false],
      [true, true, false],
      [false, false, false],
    ]);
    expect(questions[2]!.options.length).toBeGreaterThan(0);
    await session.respondToPermission(request!.id, {
      behavior: "allow",
      selectedActionId: "submit",
      updatedInput: { answers: { "项目叫什么？": "demo", "API Key 是什么？": "sk-secret", "选哪个环境？": "开发" } },
    });
    await waitUntil(() => events.some((e) => e.type === "turn_completed"));
    const reply = replyOf(events);
    expect(reply).toBe(
      "Mock 收到的回答：\n- 项目叫什么？ → demo\n- API Key 是什么？ → （已收到，9 个字符）\n- 选哪个环境？ → 开发",
    );
    expect(reply).not.toContain("sk-secret");
  });

  test("/textq 跳过：回显跳过", async () => {
    const session = await new MockAgentClient().createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("/textq");
    await waitUntil(() => events.some((e) => e.type === "permission_requested"));
    await session.respondToPermission(session.getPendingPermissions()[0]!.id, { behavior: "deny", selectedActionId: "skip" });
    await waitUntil(() => events.some((e) => e.type === "turn_completed"));
    expect(replyOf(events)).toBe("Mock 收到：跳过了问题");
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
