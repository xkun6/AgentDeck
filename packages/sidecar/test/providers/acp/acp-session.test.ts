import type { AgentStreamEvent, ToolCallTimelineItem } from "@agentdeck/protocol";
import { afterEach, describe, expect, test } from "vitest";

import { AgentRpcError } from "../../../src/agent/errors.js";
import type { AgentSession } from "../../../src/agent/types.js";
import { createSilentLogger } from "../../../src/logger.js";
import { AcpAgentClient } from "../../../src/providers/acp/acp-client.js";
import {
  assistantText,
  collect,
  fakeClient,
  fakeEntry,
  terminalEvents,
  timelineItems,
  waitForTerminal,
  waitUntil,
} from "./helpers.js";

const CWD = process.cwd();
const sessions: AgentSession[] = [];

async function open(env: Record<string, string> = {}, cfg: { model?: string; modeId?: string } = {}) {
  const session = await fakeClient(env).createSession({ cwd: CWD, ...cfg });
  sessions.push(session);
  return { session, events: collect(session) };
}

afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map((s) => s.close()));
});

function toolItems(events: AgentStreamEvent[], callId: string): ToolCallTimelineItem[] {
  return timelineItems(events).filter(
    (item): item is ToolCallTimelineItem => item.type === "tool_call" && item.callId === callId,
  );
}

describe("AcpAgentClient", () => {
  test("isAvailable：找不到命令给中文原因，找到则可用并返回 command", async () => {
    const missing = new AcpAgentClient(
      { id: "acp:none", label: "None", command: ["agentdeck-no-such-cli", "acp"], builtin: false },
      { logger: createSilentLogger(), env: process.env, findExecutable: async () => null },
    );
    const result = await missing.isAvailable();
    expect(result.available).toBe(false);
    expect(result.reason).toContain("agentdeck-no-such-cli");
    expect(result.command).toEqual(["agentdeck-no-such-cli", "acp"]);
    await expect(missing.createSession({ cwd: CWD })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });

    // 真实 findExecutable 解析 node 绝对路径
    const real = new AcpAgentClient(fakeEntry(), { logger: createSilentLogger(), env: process.env });
    const ok = await real.isAvailable();
    expect(ok).toEqual({ available: true, command: fakeEntry().command });
  });

  test("initialize/newSession：fetchCatalog 建会话前为空、之后为 agent 报告的模型与模式；容忍 stdout 非 JSON 行", async () => {
    const client = fakeClient({ FAKE_ACP_NOISE: "1" });
    expect(await client.fetchCatalog()).toEqual({ models: [], modes: [] });
    const session = await client.createSession({ cwd: CWD });
    sessions.push(session);
    expect(session.id).toBe("fake-session-1");
    expect(session.describePersistence()).toEqual({ provider: "acp:fake", sessionId: "fake-session-1" });
    expect(await client.fetchCatalog()).toEqual({
      models: [
        { provider: "acp:fake", id: "fake-small", label: "Fake Small", isDefault: true },
        { provider: "acp:fake", id: "fake-large", label: "Fake Large", description: "更大" },
      ],
      modes: [
        { id: "default", label: "默认", description: "需要审批" },
        { id: "plan", label: "计划" },
      ],
    });
  });

  test("createSession 的 model / modeId 在建会话时下发", async () => {
    const { session, events } = await open({}, { model: "fake-large", modeId: "plan" });
    await session.startTurn("hi");
    await waitForTerminal(events);
    expect(assistantText(events)).toContain("模式:plan，模型:fake-large");
  });

  test("非法初始 modeId 让 createSession 失败", async () => {
    await expect(fakeClient().createSession({ cwd: CWD, modeId: "nope" })).rejects.toThrow();
  });
});

describe("AcpAgentSession 回合", () => {
  test("文本增量：首轮 thread_started，忽略 user_message_chunk，usage 合并进 turn_completed", async () => {
    const { session, events } = await open();
    const { turnId } = await session.startTurn("你好");
    await waitForTerminal(events);

    expect(events[0]).toEqual({ type: "thread_started", sessionId: "fake-session-1" });
    expect(events[1]).toEqual({ type: "turn_started", turnId });
    const items = timelineItems(events);
    expect(items.some((item) => item.type === "user_message")).toBe(false);
    const chunks = items.filter((item) => item.type === "assistant_message");
    expect(chunks).toHaveLength(2);
    expect(new Set(chunks.map((c) => (c.type === "assistant_message" ? c.messageId : null))).size).toBe(1);
    expect(assistantText(events)).toBe("你好，世界（图片数:0，模式:default，模型:fake-small）");
    expect(events.find((e) => e.type === "usage_updated")).toEqual({
      type: "usage_updated",
      usage: { contextWindowMaxTokens: 200000, contextWindowUsedTokens: 1234, totalCostUsd: 0.01 },
    });
    expect(events.at(-1)).toEqual({
      type: "turn_completed",
      turnId,
      usage: {
        contextWindowMaxTokens: 200000,
        contextWindowUsedTokens: 1234,
        totalCostUsd: 0.01,
        inputTokens: 10,
        outputTokens: 20,
        cachedInputTokens: 5,
      },
    });
    for (const event of events) {
      if (event.type === "timeline") expect(event.turnId).toBe(turnId);
    }

    await session.startTurn("再来");
    await waitForTerminal(events, 2);
    expect(events.filter((e) => e.type === "thread_started")).toHaveLength(1);
  });

  test("agent_thought_chunk → reasoning，带 messageId 的消息沿用原 id", async () => {
    const { session, events } = await open();
    await session.startTurn("scenario:thought");
    await waitForTerminal(events);
    const items = timelineItems(events);
    expect(items.filter((i) => i.type === "reasoning")).toEqual([
      { type: "reasoning", text: "先想一想" },
      { type: "reasoning", text: "……想好了" },
    ]);
    expect(items.find((i) => i.type === "assistant_message")).toEqual({
      type: "assistant_message",
      text: "答案",
      messageId: "msg-1",
    });
    expect(events.at(-1)?.type).toBe("turn_completed");
  });

  test("tool_call / tool_call_update 按 toolCallId 合并快照，状态 running→completed/failed", async () => {
    const { session, events } = await open();
    await session.startTurn("scenario:tools");
    await waitForTerminal(events);

    const exec = toolItems(events, "call-exec");
    expect(exec.map((i) => i.status)).toEqual(["running", "running", "completed"]);
    expect(exec[0]).toMatchObject({ name: "execute", detail: { type: "shell", command: "ls -la" } });
    expect(exec[2]).toEqual({
      type: "tool_call",
      callId: "call-exec",
      name: "execute",
      status: "completed",
      detail: { type: "shell", command: "ls -la", output: "file.txt", exitCode: 0 },
      error: null,
      metadata: { kind: "execute", title: "Run ls" },
    });

    const edit = toolItems(events, "call-edit");
    expect(edit.map((i) => i.status)).toEqual(["running", "completed"]);
    for (const item of edit) {
      expect(item.detail).toEqual({
        type: "edit",
        filePath: "/repo/a.txt",
        oldString: "old line",
        newString: "new line",
      });
    }

    const read = toolItems(events, "call-read");
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({
      status: "failed",
      error: "文件不存在",
      detail: { type: "read", filePath: "/repo/missing.txt" },
    });

    // 工具调用前后的文本是两条不同的 assistant 消息
    const messages = timelineItems(events).filter((i) => i.type === "assistant_message");
    expect(messages).toHaveLength(2);
    const [first, second] = messages;
    expect(first?.type === "assistant_message" && first.messageId).not.toBe(
      second?.type === "assistant_message" && second.messageId,
    );
    expect(events.at(-1)?.type).toBe("turn_completed");
  });

  test("plan → todo", async () => {
    const { session, events } = await open();
    await session.startTurn("scenario:plan");
    await waitForTerminal(events);
    expect(timelineItems(events).find((i) => i.type === "todo")).toEqual({
      type: "todo",
      items: [
        { text: "第一步", completed: true },
        { text: "第二步", completed: false },
        { text: "第三步", completed: false },
      ],
    });
  });

  test("stopReason=refusal → turn_failed（REFUSAL）", async () => {
    const { session, events } = await open();
    const { turnId } = await session.startTurn("scenario:refusal");
    await waitForTerminal(events);
    expect(terminalEvents(events)).toEqual([
      expect.objectContaining({ type: "turn_failed", turnId, code: "REFUSAL" }),
    ]);
  });

  test("prompt 请求被拒（JSON-RPC error）→ turn_failed", async () => {
    const { session, events } = await open();
    await session.startTurn("scenario:error");
    await waitForTerminal(events);
    const [terminal] = terminalEvents(events);
    expect(terminal).toMatchObject({ type: "turn_failed", code: "ACP_-32603" });
    expect(terminal?.type === "turn_failed" && terminal.error).toContain("Internal error");
  });

  test("agent 进程崩溃 → turn_failed（PROCESS_EXITED，带 stderr），会话不可再用", async () => {
    const { session, events } = await open();
    await session.startTurn("scenario:crash");
    await waitForTerminal(events);
    expect(terminalEvents(events)).toHaveLength(1);
    const [terminal] = terminalEvents(events);
    expect(terminal).toMatchObject({ type: "turn_failed", code: "PROCESS_EXITED" });
    expect(terminal?.type === "turn_failed" && terminal.error).toContain("fake agent boom");
    await expect(session.startTurn("again")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  test("图片：agent 声明 image 能力才带上，否则丢弃", async () => {
    const prompt = [
      { type: "text" as const, text: "看图" },
      { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" },
    ];
    const withImage = await open({ FAKE_ACP_IMAGE: "1" });
    await withImage.session.startTurn(prompt);
    await waitForTerminal(withImage.events);
    expect(assistantText(withImage.events)).toContain("图片数:1");

    const without = await open();
    await without.session.startTurn(prompt);
    await waitForTerminal(without.events);
    expect(assistantText(without.events)).toContain("图片数:0");
  });
});

describe("AcpAgentSession 权限", () => {
  async function waitForPermission(session: AgentSession, events: AgentStreamEvent[]) {
    await waitUntil(() => events.some((e) => e.type === "permission_requested"));
    const requested = events.find((e) => e.type === "permission_requested");
    if (requested?.type !== "permission_requested") throw new Error("unreachable");
    expect(session.getPendingPermissions()).toEqual([requested.request]);
    return requested;
  }

  test("options 映射为 actions，allow 默认选 allow_once", async () => {
    const { session, events } = await open();
    const { turnId } = await session.startTurn("scenario:permission");
    const requested = await waitForPermission(session, events);
    expect(requested.turnId).toBe(turnId);
    expect(requested.request).toMatchObject({
      provider: "acp:fake",
      name: "execute",
      kind: "tool",
      title: "rm -rf build",
      input: { command: "rm -rf build" },
      detail: { type: "shell", command: "rm -rf build" },
      actions: [
        { id: "opt-allow-once", label: "允许一次", behavior: "allow" },
        { id: "opt-allow-always", label: "总是允许", behavior: "allow" },
        { id: "opt-reject", label: "拒绝", behavior: "deny" },
      ],
    });

    await session.respondToPermission(requested.request.id, { behavior: "allow" });
    expect(events.at(-1)).toEqual({
      type: "permission_resolved",
      requestId: requested.request.id,
      response: { behavior: "allow" },
    });
    expect(session.getPendingPermissions()).toEqual([]);
    await waitForTerminal(events);
    expect(assistantText(events)).toBe("已允许:opt-allow-once");
    expect(toolItems(events, "call-perm").at(-1)?.status).toBe("completed");
    expect(events.at(-1)?.type).toBe("turn_completed");
  });

  test("selectedActionId 优先；未知 id 报错", async () => {
    const { session, events } = await open();
    await session.startTurn("scenario:permission");
    const requested = await waitForPermission(session, events);
    await expect(
      session.respondToPermission(requested.request.id, { behavior: "allow", selectedActionId: "nope" }),
    ).rejects.toThrow("nope");
    await session.respondToPermission(requested.request.id, {
      behavior: "allow",
      selectedActionId: "opt-allow-always",
    });
    await waitForTerminal(events);
    expect(assistantText(events)).toBe("已允许:opt-allow-always");
  });

  test("deny 选 reject_once，回合正常结束", async () => {
    const { session, events } = await open();
    await session.startTurn("scenario:permission");
    const requested = await waitForPermission(session, events);
    await session.respondToPermission(requested.request.id, { behavior: "deny", message: "不行" });
    await waitForTerminal(events);
    expect(assistantText(events)).toBe("已拒绝:opt-reject");
    expect(toolItems(events, "call-perm").at(-1)).toMatchObject({ status: "failed", error: "用户拒绝" });
    expect(terminalEvents(events).map((e) => e.type)).toEqual(["turn_completed"]);
  });

  test("deny + interrupt → 发 cancel，只发一次 turn_canceled", async () => {
    const { session, events } = await open();
    const { turnId } = await session.startTurn("scenario:permission");
    const requested = await waitForPermission(session, events);
    await session.respondToPermission(requested.request.id, { behavior: "deny", interrupt: true });
    await waitForTerminal(events);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(terminalEvents(events)).toEqual([{ type: "turn_canceled", turnId, reason: "interrupted" }]);
    expect(assistantText(events)).toBe("");
  });

  test("interrupt 时挂起的权限回 cancelled 并发 permission_resolved", async () => {
    const { session, events } = await open();
    const { turnId } = await session.startTurn("scenario:permission");
    const requested = await waitForPermission(session, events);
    await session.interrupt();
    expect(events.filter((e) => e.type === "permission_resolved")).toEqual([
      {
        type: "permission_resolved",
        requestId: requested.request.id,
        response: { behavior: "deny", message: "回合已取消", interrupt: true },
      },
    ]);
    expect(session.getPendingPermissions()).toEqual([]);
    expect(terminalEvents(events)).toEqual([{ type: "turn_canceled", turnId, reason: "interrupted" }]);
  });
});

describe("AcpAgentSession 中断与关闭", () => {
  test("interrupt → cancel → turn_canceled 只发一次，运行中的工具标记 canceled", async () => {
    const { session, events } = await open();
    const { turnId } = await session.startTurn("scenario:slow");
    await waitUntil(() => toolItems(events, "call-slow").length > 0);
    await session.interrupt();
    expect(terminalEvents(events)).toEqual([{ type: "turn_canceled", turnId, reason: "interrupted" }]);
    expect(toolItems(events, "call-slow").map((i) => i.status)).toEqual(["running", "canceled"]);
    await session.interrupt(); // 已结束，再次调用无副作用
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(terminalEvents(events)).toHaveLength(1);

    // 会话仍可继续下一轮
    await session.startTurn("hi");
    await waitForTerminal(events, 2);
    expect(terminalEvents(events)[1]?.type).toBe("turn_completed");
  });

  test("agent 不响应 cancel 时 5 秒后强制 turn_canceled", async () => {
    const { session, events } = await open();
    const { turnId } = await session.startTurn("scenario:hang");
    await waitUntil(() => assistantText(events).length > 0);
    const started = Date.now();
    await session.interrupt();
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
    expect(terminalEvents(events)).toEqual([{ type: "turn_canceled", turnId, reason: "interrupted" }]);
  });

  test("close：进行中的回合发 turn_canceled(closed)，之后 startTurn 报 AGENT_CLOSED", async () => {
    const { session, events } = await open();
    const { turnId } = await session.startTurn("scenario:slow");
    await waitUntil(() => assistantText(events).length > 0);
    await session.close();
    expect(terminalEvents(events)).toEqual([{ type: "turn_canceled", turnId, reason: "closed" }]);
    await expect(session.startTurn("x")).rejects.toBeInstanceOf(AgentRpcError);
    await expect(session.startTurn("x")).rejects.toMatchObject({ code: "AGENT_CLOSED" });
    await session.close();
  });
});

describe("AcpAgentSession 模型与模式", () => {
  test("setMode → setSessionMode + mode_changed；未知模式报错", async () => {
    const { session, events } = await open();
    await session.setMode!("plan");
    expect(events.at(-1)).toEqual({ type: "mode_changed", modeId: "plan" });
    await expect(session.setMode!("nope")).rejects.toThrow();
    await session.startTurn("hi");
    await waitForTerminal(events);
    expect(assistantText(events)).toContain("模式:plan");
  });

  test("current_mode_update → mode_changed", async () => {
    const { session, events } = await open();
    await session.startTurn("scenario:mode");
    await waitForTerminal(events);
    expect(events.filter((e) => e.type === "mode_changed")).toEqual([
      { type: "mode_changed", modeId: "plan" },
    ]);
  });

  test("setModel → unstable_setSessionModel + model_changed；null 恢复默认模型", async () => {
    const { session, events } = await open();
    await session.setModel!("fake-large");
    expect(events.at(-1)).toEqual({ type: "model_changed", modelId: "fake-large" });
    await session.startTurn("hi");
    await waitForTerminal(events);
    expect(assistantText(events)).toContain("模型:fake-large");

    await session.setModel!(null);
    expect(events.at(-1)).toEqual({ type: "model_changed", modelId: null });
    await session.startTurn("hi");
    await waitForTerminal(events, 2);
    expect(assistantText(events)).toContain("模型:fake-small");
  });

  test("agent 不支持切模型 → NOT_SUPPORTED", async () => {
    const { session } = await open({ FAKE_ACP_FAIL_SET_MODEL: "1" });
    await expect(session.setModel!("fake-large")).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });

  test("agent 不报告模型时 setModel(null) → NOT_SUPPORTED，目录为空", async () => {
    const client = fakeClient({ FAKE_ACP_NO_MODES: "1" });
    const session = await client.createSession({ cwd: CWD });
    sessions.push(session);
    expect(await client.fetchCatalog()).toEqual({ models: [], modes: [] });
    await expect(session.setModel!(null)).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });
});

describe("resumeSession", () => {
  test("agent 声明 loadSession：加载指定会话，重放的历史不外发", async () => {
    const client = fakeClient({ FAKE_ACP_LOAD_SESSION: "1" });
    const session = await client.resumeSession({ provider: "acp:fake", sessionId: "old-1" }, { cwd: CWD });
    sessions.push(session);
    const events = collect(session);
    expect(session.id).toBe("old-1");
    expect(session.describePersistence()).toEqual({ provider: "acp:fake", sessionId: "old-1" });
    await session.startTurn("hi");
    await waitForTerminal(events);
    expect(events[0]).toEqual({ type: "thread_started", sessionId: "old-1" });
    expect(assistantText(events)).not.toContain("历史回答");
    expect(assistantText(events)).toContain("模式:plan");
  });

  test("agent 未声明 loadSession → NOT_SUPPORTED", async () => {
    await expect(
      fakeClient().resumeSession({ provider: "acp:fake", sessionId: "old-1" }, { cwd: CWD }),
    ).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });
});
