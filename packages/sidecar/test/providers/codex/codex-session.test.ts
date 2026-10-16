import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentStreamEvent } from "@agentdeck/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { AgentSession, ProviderSubagentInputEvent } from "../../../src/agent/types.js";
import { createSilentLogger } from "../../../src/logger.js";
import { CodexAgentClient } from "../../../src/providers/codex/index.js";
import type { CodexLaunch } from "../../../src/providers/codex/launch.js";

const FAKE_SERVER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-app-server.mjs",
);

let tmpDir: string;
let logFile: string;
const sessions: AgentSession[] = [];

function makeClient(extraEnv: Record<string, string> = {}): CodexAgentClient {
  const launch: CodexLaunch = {
    command: process.execPath,
    args: [FAKE_SERVER],
    envOverlay: { FAKE_CODEX_LOG: logFile, ...extraEnv },
    source: "env",
  };
  return new CodexAgentClient({
    logger: createSilentLogger(),
    env: process.env,
    resolveLaunch: () => launch,
  });
}

async function newSession(client = makeClient(), modeId?: string): Promise<AgentSession> {
  const session = await client.createSession({ cwd: tmpDir, ...(modeId ? { modeId } : {}) });
  sessions.push(session);
  return session;
}

function collect(session: AgentSession): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  session.subscribe((e) => {
    if (e.type !== "provider_subagent" && e.type !== "provider_background_tasks") events.push(e);
  });
  return events;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil 超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const isTerminal = (e: AgentStreamEvent) =>
  e.type === "turn_completed" || e.type === "turn_failed" || e.type === "turn_canceled";

/** 假 server 收到的消息（direction=in） */
function received(): Array<{ id?: number | string; method?: string; params?: any; result?: any; error?: any }> {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.direction === "in")
    .map((entry) => entry.msg);
}

function label(e: AgentStreamEvent): string {
  return e.type === "timeline" ? `timeline:${e.item.type}` : e.type;
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "agentdeck-codex-test-"));
  logFile = path.join(tmpDir, "fake.log");
});

afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map((s) => s.close()));
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("CodexAgentClient（假 app-server）", () => {
  test("fetchCatalog 走 model/list，跳过隐藏模型，模式固定三种", async () => {
    const catalog = await makeClient().fetchCatalog({ cwd: tmpDir });
    expect(catalog.models).toEqual([
      {
        provider: "codex",
        id: "gpt-a",
        label: "GPT-A",
        description: "默认模型",
        isDefault: true,
        // supportedReasoningEfforts → 档位；默认档位不在列表里时补一项
        thinkingOptions: [
          { id: "low", label: "低", description: "快" },
          { id: "high", label: "高", description: "深" },
          { id: "medium", label: "中", description: "模型默认档位" },
        ],
        defaultThinkingOptionId: "medium",
      },
      { provider: "codex", id: "gpt-b", label: "GPT-B" },
    ]);
    expect(catalog.modes.map((m) => m.id)).toEqual(["read-only", "auto", "full-access"]);
  });

  test("fetchCatalog 失败时返回空模型列表", async () => {
    const catalog = await makeClient({ FAKE_CODEX_INIT_FAIL: "1" }).fetchCatalog({ cwd: tmpDir });
    expect(catalog.models).toEqual([]);
    expect(catalog.modes).toHaveLength(3);
  });

  test("isAvailable 跑 --version 并返回启动命令", async () => {
    const result = await makeClient().isAvailable();
    // 假 server 对 --version 不做处理但会因 stdin 关闭正常退出
    expect(result.command).toEqual([process.execPath, FAKE_SERVER]);
    expect(result.available).toBe(true);
  });

  test("找不到 codex 时不可用并给出中文原因", async () => {
    const client = new CodexAgentClient({
      logger: createSilentLogger(),
      env: {},
      resolveLaunch: () => null,
    });
    const result = await client.isAvailable();
    expect(result.available).toBe(false);
    expect(result.reason).toContain("未找到 Codex CLI");
    await expect(client.createSession({ cwd: tmpDir })).rejects.toThrow("未找到 Codex CLI");
  });

  test("initialize 失败时 createSession 报错；未知模式报错", async () => {
    await expect(makeClient({ FAKE_CODEX_INIT_FAIL: "1" }).createSession({ cwd: tmpDir })).rejects.toThrow(
      "初始化失败",
    );
    await expect(makeClient().createSession({ cwd: tmpDir, modeId: "yolo" })).rejects.toThrow(
      "不支持模式",
    );
  });
});

describe("CodexAgentSession（假 app-server）", () => {
  test("额度滚动更新与输出速度（design.md 4.30）", async () => {
    const session = await newSession(makeClient(), "read-only");
    const events = collect(session);
    await session.startTurn("speed now");
    await waitUntil(() => events.some(isTerminal));

    // 读取到的额度（primary 23.4% / secondary 60%）再被稀疏更新：primary 85%（secondary 为 null 沿用），≥ 80% → warning
    const limits = events.flatMap((e) => (e.type === "rate_limits_updated" ? [e.rateLimits] : []));
    const last = limits.at(-1)!;
    expect(last.status).toBe("warning");
    expect(last.windows).toEqual([
      { id: "primary", label: "5 小时", usedPercent: 85, resetsAt: 1791920000_000 },
      { id: "secondary", label: "每周", usedPercent: 60 },
    ]);

    // 两次响应：首个输出之后 1.2 秒到达 200 个输出 token（合格，≥100 token 且 ≥100ms），速度 ≈ 200 ÷ 1.2 = 166.7，
    // 出现在回合中的 usage_updated
    const updated = events.flatMap((e) => (e.type === "usage_updated" ? [e.usage] : []));
    const speed = updated.find((u) => u.outputTokensPerSecond !== undefined)?.outputTokensPerSecond;
    expect(speed).toBeGreaterThan(100);
    expect(speed).toBeLessThanOrEqual(200);
    // 第二次响应 0.6 秒内到达 300 个 token（累计 500，增量 300，同样合格）：
    // 最终 usage 为 Σ token ÷ Σ 时长 = (200 + 300) ÷ (1.2 + 0.6) = 277.8（考虑调度抖动给出区间）
    const done = events.find((e) => e.type === "turn_completed");
    expect(done?.type === "turn_completed" ? done.usage : undefined).toMatchObject({ outputTokens: 500 });
    const finalSpeed = done?.type === "turn_completed" ? done.usage?.outputTokensPerSecond : undefined;
    expect(finalSpeed).toBeGreaterThan(150);
    expect(finalSpeed).toBeLessThanOrEqual(290);
  });

  test("握手 + thread/start + 增量文本 + reasoning + usage + turn_completed", async () => {
    const session = await newSession(makeClient(), "read-only");
    const events = collect(session);
    const { turnId } = await session.startTurn("hello world", { clientMessageId: "c1" });
    await waitUntil(() => events.some(isTerminal));

    const init = received().find((m) => m.method === "initialize");
    expect(init?.params.clientInfo.name).toBe("agentdeck");
    expect(init?.params.capabilities.experimentalApi).toBe(true);
    expect(received().some((m) => m.method === "initialized" && m.id === undefined)).toBe(true);
    const threadStart = received().find((m) => m.method === "thread/start");
    expect(threadStart?.params).toMatchObject({
      cwd: tmpDir,
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });
    const turnStart = received().find((m) => m.method === "turn/start");
    expect(turnStart?.params).toMatchObject({
      threadId: "thr_fake",
      clientUserMessageId: "c1",
      input: [{ type: "text", text: "hello world", text_elements: [] }],
    });
    expect(turnStart?.params.sandboxPolicy).toBeUndefined();

    // 会话进程就绪后读到的账户额度（design.md 4.30）与回合事件的先后不定，先单独校验再剔除
    const limits = events.find((e) => e.type === "rate_limits_updated");
    expect(limits).toMatchObject({
      rateLimits: {
        status: "allowed",
        windows: [
          { id: "primary", label: "5 小时", usedPercent: 23.4 },
          { id: "secondary", label: "每周", usedPercent: 60 },
        ],
      },
    });
    const turnEvents = events.filter((e) => e.type !== "rate_limits_updated");
    expect(turnEvents[0]).toEqual({ type: "turn_started", turnId });
    expect(turnEvents[1]).toEqual({ type: "thread_started", sessionId: "thr_fake" });
    expect(events.some((e) => e.type === "timeline" && e.item.type === "user_message")).toBe(false);

    const reasoning = events
      .filter((e) => e.type === "timeline" && e.item.type === "reasoning")
      .map((e) => (e.type === "timeline" && e.item.type === "reasoning" ? e.item.text : ""));
    expect(reasoning).toEqual(["思考", "中", "补充推理"]);

    const assistant = events.flatMap((e) =>
      e.type === "timeline" && e.item.type === "assistant_message" ? [e.item] : [],
    );
    expect(assistant).toEqual([
      { type: "assistant_message", text: "Hel", messageId: "msg_1" },
      { type: "assistant_message", text: "lo", messageId: "msg_1" },
      { type: "assistant_message", text: "A", messageId: "msg_2" },
      { type: "assistant_message", text: "B", messageId: "msg_2" },
    ]);
    expect(events.every((e) => e.type !== "timeline" || e.turnId === turnId)).toBe(true);

    const usage = {
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 20,
      contextWindowMaxTokens: 200000,
      contextWindowUsedTokens: 120,
    };
    expect(events).toContainEqual({ type: "usage_updated", usage });
    expect(events.at(-1)).toEqual({ type: "turn_completed", turnId, usage, nativeRef: "turn_1" });
    expect(events.filter(isTerminal)).toHaveLength(1);
    expect(session.id).toBe("thr_fake");
    expect(session.describePersistence()).toEqual({ provider: "codex", sessionId: "thr_fake" });

    // 第二轮不再 thread/start、不再发 thread_started
    await session.startTurn("hello again");
    await waitUntil(() => events.filter(isTerminal).length === 2);
    expect(received().filter((m) => m.method === "thread/start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "thread_started")).toHaveLength(1);
  });

  test("commandExecution 审批 accept：permission_requested → resolved → tool_call 完成", async () => {
    const session = await newSession();
    const events = collect(session);
    const { turnId } = await session.startTurn("shell");
    await waitUntil(() => events.some((e) => e.type === "permission_requested"));

    const requested = events.find((e) => e.type === "permission_requested");
    if (requested?.type !== "permission_requested") throw new Error("unreachable");
    expect(requested.turnId).toBe(turnId);
    expect(requested.request).toMatchObject({
      provider: "codex",
      kind: "tool",
      name: "shell",
      description: "需要运行命令",
      detail: { type: "shell", command: "echo hi", cwd: "C:\\work" },
      // 没有 availableDecisions 的旧行为：accept / acceptForSession / decline / cancel
      actions: [
        { id: "accept", label: "允许一次", behavior: "allow" },
        { id: "decline", label: "拒绝", behavior: "deny" },
        { id: "allow_session", label: "本会话始终允许", behavior: "allow", persist: "session" },
        { id: "cancel", label: "拒绝并中断本轮", behavior: "deny" },
      ],
    });
    expect(session.getPendingPermissions()).toHaveLength(1);

    const running = events.find((e) => e.type === "timeline" && e.item.type === "tool_call");
    expect(running).toMatchObject({
      item: { callId: "exec_1", name: "shell", status: "running", detail: { type: "shell", command: "echo hi" } },
    });

    await session.respondToPermission(requested.request.id, { behavior: "allow" });
    expect(events.at(-1)).toEqual({
      type: "permission_resolved",
      requestId: requested.request.id,
      response: { behavior: "allow" },
    });
    expect(session.getPendingPermissions()).toEqual([]);
    await waitUntil(() => events.some(isTerminal));

    const reply = received().find((m) => m.id === 1000 && m.method === undefined);
    expect(reply?.result).toEqual({ decision: "accept" });
    const completed = events.findLast((e) => e.type === "timeline" && e.item.type === "tool_call");
    expect(completed).toMatchObject({
      item: {
        callId: "exec_1",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "echo hi", output: "hi\r\n", exitCode: 0 },
      },
    });
    expect(events.at(-1)).toMatchObject({ type: "turn_completed", turnId });
  });

  test("respond 找不到待处理请求（含已处理过的）抛 PERMISSION_NOT_FOUND", async () => {
    const session = await newSession();
    const events = collect(session);
    await session.startTurn("shell");
    await waitUntil(() => events.some((e) => e.type === "permission_requested"));
    const [request] = session.getPendingPermissions();
    await session.respondToPermission(request!.id, { behavior: "allow" });
    await expect(session.respondToPermission(request!.id, { behavior: "allow" })).rejects.toMatchObject({
      code: "PERMISSION_NOT_FOUND",
    });
    await expect(session.respondToPermission("nope", { behavior: "deny" })).rejects.toMatchObject({
      code: "PERMISSION_NOT_FOUND",
    });
  });

  test("commandExecution 审批 decline：tool_call 失败，回合正常完成", async () => {
    const session = await newSession();
    const events = collect(session);
    await session.startTurn("shell");
    await waitUntil(() => events.some((e) => e.type === "permission_requested"));
    const [request] = session.getPendingPermissions();
    await session.respondToPermission(request!.id, { behavior: "deny", message: "不行" });
    await waitUntil(() => events.some(isTerminal));
    expect(received().find((m) => m.id === 1000)?.result).toEqual({ decision: "decline" });
    const tool = events.findLast((e) => e.type === "timeline" && e.item.type === "tool_call");
    expect(tool).toMatchObject({ item: { status: "failed", error: "用户拒绝了该操作" } });
    expect(events.at(-1)?.type).toBe("turn_completed");
  });

  test("拒绝且 interrupt=true 时应答 cancel，回合以 turn_canceled 结束", async () => {
    const session = await newSession();
    const events = collect(session);
    await session.startTurn("shell");
    await waitUntil(() => events.some((e) => e.type === "permission_requested"));
    const [request] = session.getPendingPermissions();
    await session.respondToPermission(request!.id, { behavior: "deny", interrupt: true });
    await waitUntil(() => events.some(isTerminal));
    expect(received().find((m) => m.id === 1000)?.result).toEqual({ decision: "cancel" });
    expect(events.at(-1)).toMatchObject({ type: "turn_canceled", reason: "interrupted" });
  });

  /** 触发一个审批剧本并返回挂起的请求 */
  async function openApproval(scenario: string) {
    const session = await newSession();
    const events = collect(session);
    await session.startTurn(scenario);
    await waitUntil(() => events.some((e) => e.type === "permission_requested"));
    const [request] = session.getPendingPermissions();
    return { session, events, request: request! };
  }

  test("availableDecisions：只呈现列出的决定；allow_project 回 acceptWithExecpolicyAmendment", async () => {
    const { session, events, request } = await openApproval("shellavail");
    expect(request.actions).toEqual([
      { id: "accept", label: "允许一次", behavior: "allow" },
      {
        id: "allow_session",
        label: "本会话始终允许",
        behavior: "allow",
        persist: "session",
        description: "本会话内同类命令不再询问",
      },
      {
        id: "allow_project",
        label: "永久允许",
        behavior: "allow",
        persist: "permanent",
        description: "以后允许以 `git status` 开头的命令（写入 Codex 执行策略）",
      },
      {
        id: "network_allow:example.com",
        label: "始终允许访问 example.com",
        behavior: "allow",
        persist: "permanent",
        description: "写入 Codex 网络策略：以后允许访问 example.com",
      },
      {
        id: "network_deny:evil.test",
        label: "始终禁止访问 evil.test",
        behavior: "deny",
        description: "写入 Codex 网络策略：以后禁止访问 evil.test",
      },
      { id: "cancel", label: "拒绝并中断本轮", behavior: "deny" },
    ]);
    await session.respondToPermission(request.id, { behavior: "allow", selectedActionId: "allow_project" });
    await waitUntil(() => events.some(isTerminal));
    expect(received().find((m) => m.id === 1000)?.result).toEqual({
      decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] } },
    });
  });

  test("availableDecisions：allow_session 回 acceptForSession，网络策略回 applyNetworkPolicyAmendment，cancel 回 cancel", async () => {
    for (const [actionId, behavior, expected] of [
      ["allow_session", "allow", "acceptForSession"],
      [
        "network_allow:example.com",
        "allow",
        { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.com", action: "allow" } } },
      ],
      [
        "network_deny:evil.test",
        "deny",
        { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "evil.test", action: "deny" } } },
      ],
      ["cancel", "deny", "cancel"],
    ] as const) {
      const { session, events, request } = await openApproval("shellavail");
      await session.respondToPermission(request.id, { behavior, selectedActionId: actionId });
      await waitUntil(() => events.some(isTerminal));
      const replies = received().filter((m) => m.method === undefined && m.result?.decision !== undefined);
      expect(replies.at(-1)?.result).toEqual({ decision: expected });
      await session.close();
    }
  }, 30_000);

  test("只有 proposedExecpolicyAmendment 时补一项 allow_project", async () => {
    const { session, events, request } = await openApproval("shellpolicy");
    expect(request.actions?.map((a) => a.id)).toEqual(["accept", "decline", "allow_session", "allow_project", "cancel"]);
    expect(request.actions?.find((a) => a.id === "allow_project")).toMatchObject({
      label: "永久允许",
      description: "以后允许以 `npm test` 开头的命令（写入 Codex 执行策略）",
    });
    await session.respondToPermission(request.id, { behavior: "allow", selectedActionId: "allow_project" });
    await waitUntil(() => events.some(isTerminal));
    expect(received().find((m) => m.id === 1000)?.result).toEqual({
      decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] } },
    });
  });

  test("没有 selectedActionId 时按 behavior 回 accept / decline，不受 availableDecisions 影响", async () => {
    const { session, events, request } = await openApproval("shellavail");
    await session.respondToPermission(request.id, { behavior: "allow" });
    await waitUntil(() => events.some(isTerminal));
    expect(received().find((m) => m.id === 1000)?.result).toEqual({ decision: "accept" });
  });

  test("fileChange 审批：accept / acceptForSession / decline / cancel，allow_session 回 acceptForSession", async () => {
    const { session, events, request } = await openApproval("patch");
    expect(request.actions).toEqual([
      { id: "accept", label: "允许一次", behavior: "allow" },
      { id: "decline", label: "拒绝", behavior: "deny" },
      {
        id: "allow_session",
        label: "本会话始终允许",
        behavior: "allow",
        persist: "session",
        description: "本会话内对这些文件的修改不再询问",
      },
      { id: "cancel", label: "拒绝并中断本轮", behavior: "deny" },
    ]);
    await session.respondToPermission(request.id, { behavior: "allow", selectedActionId: "allow_session" });
    await waitUntil(() => events.some(isTerminal));
    expect(received().find((m) => m.id === 1000)?.result).toEqual({ decision: "acceptForSession" });
  });

  test("旧版 execCommandApproval：allow_session 回 approved_for_session，拒绝带理由回 denied", async () => {
    const first = await openApproval("legacyexec");
    expect(first.request.actions?.map((a) => a.id)).toEqual(["accept", "decline", "allow_session", "cancel"]);
    await first.session.respondToPermission(first.request.id, {
      behavior: "allow",
      selectedActionId: "allow_session",
    });
    await waitUntil(() => first.events.some(isTerminal));
    expect(received().find((m) => m.id === 1000)?.result).toEqual({ decision: "approved_for_session" });
    await first.session.close();

    const second = await openApproval("legacyexec");
    await second.session.respondToPermission(second.request.id, {
      behavior: "deny",
      selectedActionId: "decline",
      message: "不行",
    });
    await waitUntil(() => second.events.some(isTerminal));
    const replies = received().filter((m) => m.method === undefined && m.result?.decision !== undefined);
    expect(replies.at(-1)?.result).toEqual({ decision: { denied: { rejection: "不行" } } });
  }, 20_000);

  describe("mcpServer/elicitation/request", () => {
    test("form：requestedSchema 归一化为 fields，actions 为 提交 / 拒绝 / 取消；提交回 accept + 真实 content + _meta", async () => {
      const { session, events, request } = await openApproval("elicitform");
      expect(request).toMatchObject({
        provider: "codex",
        kind: "elicitation",
        name: "mcp:forms",
        title: "forms 需要你填写表单",
        detail: {
          type: "elicitation",
          serverName: "forms",
          mode: "form",
          message: "请填写表单",
          fields: [
            { key: "name", title: "姓名", required: true, type: "string", minLength: 1 },
            {
              key: "level",
              required: false,
              type: "select",
              options: [
                { value: "lo", label: "低" },
                { value: "hi", label: "高" },
              ],
            },
            { key: "agree", required: false, type: "boolean", default: true },
            { key: "score", required: false, type: "number", min: 0, max: 10 },
            { key: "tags", required: false, type: "multiselect", max: 2 },
          ],
        },
        actions: [
          { id: "submit", label: "提交", behavior: "allow" },
          { id: "decline", label: "拒绝", behavior: "deny" },
          { id: "cancel", label: "取消", behavior: "deny" },
        ],
      });
      const content = { name: "小明", level: "hi", agree: false, score: 7.5, tags: ["a"] };
      await session.respondToPermission(request.id, {
        behavior: "allow",
        selectedActionId: "submit",
        updatedInput: { content },
      });
      await waitUntil(() => events.some(isTerminal));
      expect(received().find((m) => m.id === 1000)?.result).toEqual({ action: "accept", content, _meta: null });
      // 表单内容不进 permission_resolved（该事件会广播并落盘）
      expect(events.find((e) => e.type === "permission_resolved")).toEqual({
        type: "permission_resolved",
        requestId: request.id,
        response: { behavior: "allow", selectedActionId: "submit" },
      });
      expect(events.find((e) => e.type === "timeline" && e.item.type === "assistant_message")).toMatchObject({
        item: { text: `answer:${JSON.stringify({ action: "accept", content, _meta: null })}` },
      });
    });

    test("form：拒绝回 decline（content / _meta 为 null）；取消回 cancel 并中断回合", async () => {
      const declined = await openApproval("elicitform");
      await declined.session.respondToPermission(declined.request.id, {
        behavior: "deny",
        selectedActionId: "decline",
      });
      await waitUntil(() => declined.events.some(isTerminal));
      expect(received().find((m) => m.id === 1000)?.result).toEqual({
        action: "decline",
        content: null,
        _meta: null,
      });
      expect(declined.events.at(-1)?.type).toBe("turn_completed");
      await declined.session.close();

      const canceled = await openApproval("elicitform");
      await canceled.session.respondToPermission(canceled.request.id, {
        behavior: "deny",
        selectedActionId: "cancel",
        interrupt: true,
      });
      await waitUntil(() => canceled.events.some(isTerminal));
      const replies = received().filter((m) => m.method === undefined && m.result?.action !== undefined);
      expect(replies.at(-1)?.result).toEqual({ action: "cancel", content: null, _meta: null });
      expect(received().some((m) => m.method === "turn/interrupt")).toBe(true);
      expect(canceled.events.at(-1)).toMatchObject({ type: "turn_canceled", reason: "interrupted" });
    }, 20_000);

    test("url：detail 带 url / elicitationId，已完成回 accept（content 为 null）", async () => {
      const { session, events, request } = await openApproval("eliciturl");
      expect(request).toMatchObject({
        kind: "elicitation",
        title: "forms 需要你在浏览器中完成操作",
        detail: {
          type: "elicitation",
          mode: "url",
          message: "请在浏览器里授权",
          url: "https://example.com/auth",
          elicitationId: "elic-9",
        },
        actions: [
          { id: "done", label: "已完成", behavior: "allow" },
          { id: "decline", label: "拒绝", behavior: "deny" },
          { id: "cancel", label: "取消", behavior: "deny" },
        ],
      });
      expect((request.detail as { fields?: unknown }).fields).toBeUndefined();
      await session.respondToPermission(request.id, { behavior: "allow", selectedActionId: "done" });
      await waitUntil(() => events.some(isTerminal));
      expect(received().find((m) => m.id === 1000)?.result).toEqual({ action: "accept", content: null, _meta: null });
    });

    test("没有字段的 form（MCP 工具审批式确认）仍是 tool 审批：允许回 accept + content {}", async () => {
      const { session, events, request } = await openApproval("elicitempty");
      expect(request).toMatchObject({
        kind: "tool",
        name: "mcp:forms",
        actions: [
          { id: "accept", label: "允许", behavior: "allow" },
          { id: "decline", label: "拒绝", behavior: "deny" },
        ],
      });
      await session.respondToPermission(request.id, { behavior: "allow", selectedActionId: "accept" });
      await waitUntil(() => events.some(isTerminal));
      expect(received().find((m) => m.id === 1000)?.result).toEqual({ action: "accept", content: {}, _meta: null });
    });

    test("未声明的 openai/* 模式直接 decline，不产生审批", async () => {
      const session = await newSession();
      const events = collect(session);
      await session.startTurn("elicitopenai");
      await waitUntil(() => events.some(isTerminal));
      expect(events.some((e) => e.type === "permission_requested")).toBe(false);
      expect(received().find((m) => m.id === 1000)?.result).toEqual({ action: "decline", content: null, _meta: null });
    });

    test("回合被中断时挂起的表单被清理并发 permission_resolved", async () => {
      const session = await newSession();
      const events = collect(session);
      await session.startTurn("elicitform");
      await waitUntil(() => events.some((e) => e.type === "permission_requested"));
      const [request] = session.getPendingPermissions();
      // 假 server 的 elicitform 剧本不会主动撤销；直接结束回合同样会清理挂起的表单
      await session.interrupt();
      await waitUntil(() => events.some(isTerminal));
      expect(session.getPendingPermissions()).toEqual([]);
      expect(events.some((e) => e.type === "permission_resolved" && e.requestId === request!.id)).toBe(true);
    });
  });

  describe("item/tool/requestUserInput", () => {
    test("映射成 kind question：header / question / options / isOther / isSecret / 纯文本题；重复的题目文本加序号区分", async () => {
      const { request } = await openApproval("userinput");
      expect(request).toMatchObject({
        provider: "codex",
        kind: "question",
        name: "request_user_input",
        title: "Codex 有问题需要你回答",
        actions: [
          { id: "submit", label: "提交回答", behavior: "allow" },
          { id: "skip", label: "跳过", behavior: "deny" },
        ],
      });
      expect(request.detail).toEqual({
        type: "question",
        questions: [
          {
            question: "用哪个数据库？",
            header: "数据库",
            multiSelect: false,
            options: [
              { label: "SQLite", description: "嵌入式" },
              { label: "Postgres", description: "服务端" },
            ],
            isOther: true,
          },
          {
            question: "用哪个数据库？ (2)",
            header: "模式",
            multiSelect: false,
            options: [{ label: "读写", description: "可写" }],
            isOther: false,
          },
          { question: "项目叫什么？", header: "名称", multiSelect: false, options: [], isOther: false, freeText: true },
          { question: "API Key？", header: "密钥", multiSelect: false, options: [], isOther: false, isSecret: true, freeText: true },
        ],
      });
    });

    test("提交：answers 按题目 id 组织，未作答的题不出现", async () => {
      const { session, events, request } = await openApproval("userinput");
      await session.respondToPermission(request.id, {
        behavior: "allow",
        selectedActionId: "submit",
        updatedInput: {
          answers: { "用哪个数据库？": "SQLite", "用哪个数据库？ (2)": "读写", "API Key？": "sk-123" },
        },
      });
      await waitUntil(() => events.some(isTerminal));
      expect(received().find((m) => m.id === 1000)?.result).toEqual({
        answers: {
          q_db: { answers: ["SQLite"] },
          q_mode: { answers: ["读写"] },
          q_key: { answers: ["sk-123"] },
        },
      });
      // 回答内容（可能含密钥）不进 permission_resolved
      expect(events.find((e) => e.type === "permission_resolved")).toEqual({
        type: "permission_resolved",
        requestId: request.id,
        response: { behavior: "allow", selectedActionId: "submit" },
      });
    });

    test("跳过：协议没有拒绝语义，回空的 answers（不回 JSON-RPC 错误）", async () => {
      const { session, events, request } = await openApproval("userinput");
      await session.respondToPermission(request.id, { behavior: "deny", selectedActionId: "skip", message: "用户跳过了这些问题" });
      await waitUntil(() => events.some(isTerminal));
      const reply = received().find((m) => m.id === 1000);
      expect(reply?.result).toEqual({ answers: {} });
      expect(reply?.error).toBeUndefined();
      expect(events.at(-1)?.type).toBe("turn_completed");
    });

    test("没有可解析的题目时不产生审批，直接回空 answers", async () => {
      const session = await newSession();
      const events = collect(session);
      await session.startTurn("userinputempty");
      await waitUntil(() => events.some(isTerminal));
      expect(events.some((e) => e.type === "permission_requested")).toBe(false);
      expect(received().find((m) => m.id === 1000)?.result).toEqual({ answers: {} });
    });

    test("回合被中断时挂起的提问被清理并回空 answers", async () => {
      const { session, events, request } = await openApproval("userinput");
      await session.interrupt();
      await waitUntil(() => events.some(isTerminal));
      expect(session.getPendingPermissions()).toEqual([]);
      expect(events.some((e) => e.type === "permission_resolved" && e.requestId === request.id)).toBe(true);
      await waitUntil(() => received().some((m) => m.id === 1000 && m.result !== undefined));
      expect(received().find((m) => m.id === 1000)?.result).toEqual({ answers: {} });
    });
  });

  test("fileChange 审批：edit 详情带 unifiedDiff 与相对路径；新增文件映射为 write", async () => {
    const session = await newSession();
    const events = collect(session);
    await session.startTurn("patch");
    await waitUntil(() => events.some((e) => e.type === "permission_requested"));
    const [request] = session.getPendingPermissions();
    expect(request).toMatchObject({
      name: "apply_patch",
      title: "修改文件：src/a.txt",
      detail: { type: "edit", filePath: "src/a.txt", unifiedDiff: "@@ -1 +1 @@\n-old\n+new\n" },
    });
    await session.respondToPermission(request!.id, { behavior: "allow" });
    await waitUntil(() => events.some(isTerminal));
    const tools = events.flatMap((e) =>
      e.type === "timeline" && e.item.type === "tool_call" ? [e.item] : [],
    );
    expect(tools.find((t) => t.callId === "patch_1" && t.status === "completed")?.detail).toMatchObject({
      type: "edit",
      filePath: "src/a.txt",
    });
    expect(tools.find((t) => t.callId === "patch_2")?.detail).toEqual({
      type: "write",
      filePath: "new.txt",
      content: "hello\n",
    });
  }, 15_000);

  test("turn/completed failed → turn_failed（带 code）", async () => {
    const session = await newSession();
    const events = collect(session);
    const { turnId } = await session.startTurn("fail");
    await waitUntil(() => events.some(isTerminal));
    expect(events.at(-1)).toEqual({
      type: "turn_failed",
      turnId,
      error: "boom",
      code: "usageLimitExceeded",
    });
  });

  test("error 通知（不重试）→ 只发一次 turn_failed", async () => {
    const session = await newSession();
    const events = collect(session);
    const { turnId } = await session.startTurn("error");
    await waitUntil(() => events.some(isTerminal));
    await new Promise((r) => setTimeout(r, 100));
    expect(events.filter(isTerminal)).toEqual([
      { type: "turn_failed", turnId, error: "stream disconnected", code: "responseStreamDisconnected" },
    ]);
  });

  test("turn/plan/updated → todo", async () => {
    const session = await newSession();
    const events = collect(session);
    await session.startTurn("plan");
    await waitUntil(() => events.some(isTerminal));
    expect(events.find((e) => e.type === "timeline" && e.item.type === "todo")).toMatchObject({
      item: {
        type: "todo",
        items: [
          { text: "第一步", completed: true },
          { text: "第二步", completed: false },
        ],
      },
    });
  });

  test("contextCompaction item → compaction running / completed（不出工具卡片）；旧版 thread/compacted 只在没见过 item 时补发", async () => {
    const session = await newSession();
    const events = collect(session);
    const compactions = () =>
      events.flatMap((e) => (e.type === "timeline" && e.item.type === "compaction" ? [e] : []));

    const { turnId } = await session.startTurn("compact");
    await waitUntil(() => events.some(isTerminal));
    expect(compactions()).toEqual([
      { type: "timeline", turnId, item: { type: "compaction", compactionId: "cc_1", status: "running" } },
      { type: "timeline", turnId, item: { type: "compaction", compactionId: "cc_1", status: "completed" } },
    ]);
    expect(events.some((e) => e.type === "timeline" && e.item.type === "tool_call")).toBe(false);

    const second = await session.startTurn("compactlegacy");
    await waitUntil(() => events.filter(isTerminal).length === 2);
    expect(compactions().slice(2)).toEqual([
      {
        type: "timeline",
        turnId: second.turnId,
        item: { type: "compaction", compactionId: "compact-turn_2", status: "completed" },
      },
    ]);
  });

  test("发送 /compact 改调 thread/compact/start（不调 turn/start），回合正常完成并产生压缩事件", async () => {
    const session = await newSession();
    const events = collect(session);
    const { turnId } = await session.startTurn("  /compact " + String.fromCharCode(10));
    await waitUntil(() => events.some(isTerminal));
    expect(events.filter(isTerminal)).toEqual([{ type: "turn_completed", turnId, nativeRef: "turn_1" }]);
    expect(events.filter((e) => e.type === "thread_started")).toHaveLength(1);
    expect(
      events.flatMap((e) => (e.type === "timeline" && e.item.type === "compaction" ? [e.item.status] : [])),
    ).toEqual(["running", "completed"]);
    const methods = received().map((m) => m.method);
    expect(methods).not.toContain("turn/start");
    expect(received().find((m) => m.method === "thread/compact/start")?.params).toEqual({ threadId: "thr_fake" });

    // 只有一个 text 块的数组同样拦截；带其它文字的照常走 turn/start
    const second = await session.startTurn([{ type: "text", text: "/compact" }]);
    await waitUntil(() => events.filter(isTerminal).length === 2);
    expect(events.filter(isTerminal)[1]).toEqual({ type: "turn_completed", turnId: second.turnId, nativeRef: "turn_2" });
    expect(received().filter((m) => m.method === "thread/compact/start")).toHaveLength(2);

    const third = await session.startTurn("/compact 只保留结论");
    await waitUntil(() => events.filter(isTerminal).length === 3);
    expect(events.filter(isTerminal)[2]).toMatchObject({ type: "turn_completed", turnId: third.turnId });
    const turnStarts = received().filter((m) => m.method === "turn/start");
    expect(turnStarts).toHaveLength(1);
    expect(turnStarts[0]!.params.input[0].text).toBe("/compact 只保留结论");
    expect(received().filter((m) => m.method === "thread/compact/start")).toHaveLength(2);
  });

  test("listCommands / fetchCatalog 只给 compact", async () => {
    const session = await newSession();
    await expect(session.listCommands!()).resolves.toEqual([
      { name: "compact", description: "压缩当前对话上下文" },
    ]);
    const catalog = await makeClient().fetchCatalog({ cwd: tmpDir });
    expect(catalog.commands).toEqual([{ name: "compact", description: "压缩当前对话上下文" }]);
  });

  test("getMcpStatus：mcpServerStatus/list 翻页汇总并映射状态；线程不存在时先建线程；reconnectMcp 调 config/mcpServer/reload", async () => {
    const session = await newSession();
    expect(received().some((m) => m.method === "thread/start")).toBe(false);
    await expect(session.getMcpStatus!()).resolves.toEqual({
      reconnect: "all",
      servers: [
        { name: "fs", status: "connected", toolCount: 2 },
        { name: "gh", status: "needs-auth", toolCount: 0 },
        { name: "bad", status: "failed", error: "spawn ENOENT", toolCount: 0 },
        { name: "slow", status: "pending", toolCount: 0 },
      ],
    });
    const lists = received().filter((m) => m.method === "mcpServerStatus/list");
    expect(lists.map((m) => m.params)).toEqual([
      { threadId: "thr_fake", detail: "toolsAndAuthOnly" },
      { threadId: "thr_fake", detail: "toolsAndAuthOnly", cursor: "page2" },
    ]);
    expect(received().filter((m) => m.method === "thread/start")).toHaveLength(1);

    // serverName 被忽略：只能整体重新加载
    await session.reconnectMcp!("fs");
    const reloads = received().filter((m) => m.method === "config/mcpServer/reload");
    expect(reloads).toHaveLength(1);
    expect(reloads[0]!.params).toBeUndefined();

    // 之后的回合复用已建的线程
    const events = collect(session);
    await session.startTurn("hello");
    await waitUntil(() => events.some(isTerminal));
    expect(received().filter((m) => m.method === "thread/start")).toHaveLength(1);
  });

  test("getStatus：会话 / 账户 / 用量限制 / MCP 四个分组", async () => {
    const session = await newSession(makeClient(), "read-only");
    const sections = await session.getStatus!();
    expect(sections.map((s) => s.title)).toEqual(["会话", "账户", "用量限制", "MCP"]);
    expect(sections[0]!.rows).toEqual([
      { label: "线程 ID", value: "thr_fake" },
      { label: "工作目录", value: tmpDir },
      { label: "模型", value: "默认（跟随设置）" },
      { label: "模式", value: "只读（read-only）" },
    ]);
    expect(sections[1]!.rows).toEqual([
      { label: "登录方式", value: "ChatGPT 账号" },
      { label: "邮箱", value: "dev@example.com" },
      { label: "套餐", value: "plus" },
    ]);
    expect(sections[2]!.rows[0]).toMatchObject({ label: "5 小时窗口" });
    expect(sections[2]!.rows[0]!.value).toMatch(/^已用 23%，约 (1 小时 5\d 分钟|2 小时)后重置$/);
    expect(sections[2]!.rows[1]).toEqual({ label: "每周窗口", value: "已用 60%" });
    expect(sections[3]!.rows[0]).toEqual({
      label: "概览",
      value: "4 个服务器：1 已连接，1 失败，1 需要认证，1 连接中",
    });
  });

  test("getStatus：未登录显示未登录；account / 用量读取失败时跳过对应分组", async () => {
    const none = await newSession(makeClient({ FAKE_CODEX_ACCOUNT: "none" }));
    const noneSections = await none.getStatus!();
    expect(noneSections[1]).toEqual({
      title: "账户",
      rows: [
        { label: "登录方式", value: "未登录" },
        { label: "需要 OpenAI 认证", value: "是" },
      ],
    });
    const failing = await newSession(makeClient({ FAKE_CODEX_ACCOUNT: "error" }));
    expect((await failing.getStatus!()).map((s) => s.title)).toEqual(["会话", "MCP"]);
  });

  test("interrupt → turn/interrupt { threadId, turnId } 并发 turn_canceled", async () => {
    const session = await newSession();
    const events = collect(session);
    const { turnId } = await session.startTurn("hang");
    await waitUntil(() => received().some((m) => m.method === "turn/start"));
    await session.interrupt();
    expect(received().find((m) => m.method === "turn/interrupt")?.params).toEqual({
      threadId: "thr_fake",
      turnId: "turn_1",
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(events.filter(isTerminal)).toEqual([
      { type: "turn_canceled", turnId, reason: "interrupted" },
    ]);
    // 空闲时再中断不报错
    await expect(session.interrupt()).resolves.toBeUndefined();
    // 之后还能继续下一轮
    await session.startTurn("hello");
    await waitUntil(() => events.filter(isTerminal).length === 2);
    expect(events.at(-1)?.type).toBe("turn_completed");
  });

  test("steer → turn/steer { threadId, input, expectedTurnId, clientUserMessageId }；不改变回合", async () => {
    const session = await newSession();
    const events = collect(session);
    await session.startTurn("hang");
    await waitUntil(() => received().some((m) => m.method === "turn/start"));
    await session.steer!("补充一句", { clientMessageId: "cm-1" });
    expect(received().find((m) => m.method === "turn/steer")?.params).toEqual({
      threadId: "thr_fake",
      input: [{ type: "text", text: "补充一句", text_elements: [] }],
      expectedTurnId: "turn_1",
      clientUserMessageId: "cm-1",
    });
    expect(events.filter((e) => e.type === "turn_started")).toHaveLength(1);
    expect(events.filter(isTerminal)).toHaveLength(0);
  });

  test("steer：没有进行中的回合报错；server 拒绝时错误带中文前缀", async () => {
    const session = await newSession();
    await expect(session.steer!("x")).rejects.toThrow("当前没有进行中的回合");
    const client = makeClient();
    expect(client.capabilities).toEqual({ steer: true });
  });

  test("未知 server→client 请求回 JSON-RPC 错误，不挂死", async () => {
    const session = await newSession();
    const events = collect(session);
    await session.startTurn("unknownreq");
    await waitUntil(() => events.some(isTerminal));
    const reply = received().find((m) => m.id === 1000);
    expect(reply?.error?.code).toBe(-32601);
    expect(events.at(-1)?.type).toBe("turn_completed");
  });

  test("serverRequest/resolved 清理挂起审批并发 permission_resolved", async () => {
    const session = await newSession();
    const events = collect(session);
    await session.startTurn("resolved");
    await waitUntil(() => events.some((e) => e.type === "permission_resolved"));
    expect(session.getPendingPermissions()).toEqual([]);
    const requested = events.find((e) => e.type === "permission_requested");
    const resolved = events.find((e) => e.type === "permission_resolved");
    expect(requested?.type === "permission_requested" && resolved?.type === "permission_resolved").toBe(true);
    if (requested?.type === "permission_requested" && resolved?.type === "permission_resolved") {
      expect(resolved.requestId).toBe(requested.request.id);
      expect(resolved.response.behavior).toBe("deny");
    }
    await waitUntil(() => events.some(isTerminal));
  });

  test("子进程退出：当前回合 turn_failed，下一轮自动重启并 thread/resume", async () => {
    const session = await newSession();
    const events = collect(session);
    const { turnId } = await session.startTurn("crash");
    await waitUntil(() => events.some(isTerminal));
    const failed = events.find(isTerminal);
    expect(failed).toMatchObject({ type: "turn_failed", turnId, code: "PROCESS_EXITED" });
    if (failed?.type === "turn_failed") {
      expect(failed.error).toContain("fake crash");
    }

    await session.startTurn("hello");
    await waitUntil(() => events.filter(isTerminal).length === 2);
    expect(events.at(-1)?.type).toBe("turn_completed");
    expect(received().find((m) => m.method === "thread/resume")?.params).toMatchObject({
      threadId: "thr_fake",
    });
  });

  test("setMode / setModel：下一轮 turn/start 带 approvalPolicy + sandboxPolicy 与 model", async () => {
    const session = await newSession();
    const events = collect(session);
    await session.startTurn("hello");
    await waitUntil(() => events.some(isTerminal));
    await session.setMode!("full-access");
    await session.setModel!("gpt-b");
    expect(events).toContainEqual({ type: "mode_changed", modeId: "full-access" });
    expect(events).toContainEqual({ type: "model_changed", modelId: "gpt-b" });
    await session.startTurn("hello");
    await waitUntil(() => events.filter(isTerminal).length === 2);
    const turnStarts = received().filter((m) => m.method === "turn/start");
    expect(turnStarts[1]?.params).toMatchObject({
      model: "gpt-b",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    await expect(session.setMode!("nope")).rejects.toThrow("不支持模式");

    // 覆盖只发一次
    await session.startTurn("hello");
    await waitUntil(() => events.filter(isTerminal).length === 3);
    expect(received().filter((m) => m.method === "turn/start")[2]?.params.sandboxPolicy).toBeUndefined();
  });

  test("思考强度：turn/start 带 effort；中途切换下一轮生效；切回 null 后带一次默认档位", async () => {
    const client = makeClient();
    const session = await client.createSession({ cwd: tmpDir, thinkingOptionId: "high" });
    sessions.push(session);
    const events = collect(session);
    const turnStarts = () => received().filter((m) => m.method === "turn/start");

    await session.startTurn("hello");
    await waitUntil(() => events.filter(isTerminal).length === 1);
    expect(turnStarts()[0]?.params.effort).toBe("high");

    // 运行中切换：返回提示，本轮不变
    await session.startTurn("hang");
    await waitUntil(() => turnStarts().length === 2);
    expect(await session.setThinking!("low")).toEqual({ notice: "思考强度将在下一轮生效" });
    expect(events).toContainEqual({ type: "thinking_option_changed", thinkingOptionId: "low" });
    await session.interrupt();
    await waitUntil(() => events.filter(isTerminal).length === 2);

    await session.startTurn("hello");
    await waitUntil(() => events.filter(isTerminal).length === 3);
    expect(turnStarts()[2]?.params.effort).toBe("low");

    // 切回跟随配置：下一轮显式带默认档位（无 config 时取默认模型 gpt-a 的 medium），之后不再带
    expect(await session.setThinking!(null)).toEqual({});
    await session.startTurn("hello");
    await waitUntil(() => events.filter(isTerminal).length === 4);
    expect(turnStarts()[3]?.params.effort).toBe("medium");
    await session.startTurn("hello");
    await waitUntil(() => events.filter(isTerminal).length === 5);
    expect(turnStarts()[4]?.params).not.toHaveProperty("effort");
  });

  test("思考强度：null 起步不带 effort；切回 null 时优先用 config.toml 的 model_reasoning_effort", async () => {
    const session = await newSession(makeClient({ FAKE_CODEX_CONFIG_EFFORT: "xhigh" }));
    const events = collect(session);
    const turnStarts = () => received().filter((m) => m.method === "turn/start");
    await session.startTurn("hello");
    await waitUntil(() => events.filter(isTerminal).length === 1);
    expect(turnStarts()[0]?.params).not.toHaveProperty("effort");
    await session.setThinking!("low");
    await session.startTurn("hello");
    await waitUntil(() => events.filter(isTerminal).length === 2);
    await session.setThinking!(null);
    await session.startTurn("hello");
    await waitUntil(() => events.filter(isTerminal).length === 3);
    expect(turnStarts().map((m) => m.params.effort)).toEqual([undefined, "low", "xhigh"]);
  });

  test("resumeSession 发 thread/resume，首轮补发 thread_started", async () => {
    const client = makeClient();
    const session = await client.resumeSession!({ provider: "codex", sessionId: "thr_old" }, { cwd: tmpDir });
    sessions.push(session);
    const events = collect(session);
    expect(received().find((m) => m.method === "thread/resume")?.params).toMatchObject({
      threadId: "thr_old",
      cwd: tmpDir,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    await session.startTurn("hello");
    await waitUntil(() => events.some(isTerminal));
    expect(events).toContainEqual({ type: "thread_started", sessionId: "thr_old" });
    expect(received().some((m) => m.method === "thread/start")).toBe(false);
  });

  test("forkSession 发 thread/fork（带 lastTurnId），新线程上 turn/start，turn_completed 带原生 turnId", async () => {
    const client = makeClient();
    const session = await client.forkSession!(
      { provider: "codex", sessionId: "thr_old" },
      { cwd: tmpDir, model: "gpt-b", nativeRef: "turn_prev" },
    );
    sessions.push(session);
    const fork = received().find((m) => m.method === "thread/fork");
    expect(fork?.params).toMatchObject({
      threadId: "thr_old",
      lastTurnId: "turn_prev",
      cwd: tmpDir,
      model: "gpt-b",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    expect(received().some((m) => m.method === "thread/start" || m.method === "thread/resume")).toBe(false);
    // 分叉立即完成：持久化句柄是新线程
    expect(session.describePersistence()).toEqual({ provider: "codex", sessionId: "thr_forked" });

    const events = collect(session);
    await session.startTurn("hello");
    await waitUntil(() => events.some(isTerminal));
    expect(received().find((m) => m.method === "turn/start")?.params).toMatchObject({ threadId: "thr_forked" });
    expect(events).toContainEqual({ type: "thread_started", sessionId: "thr_forked" });
    expect(events.find(isTerminal)).toMatchObject({ type: "turn_completed", nativeRef: "turn_1" });
  });

  test("forkSession 不带 nativeRef 时 thread/fork 不传 lastTurnId", async () => {
    const session = await makeClient().forkSession!({ provider: "codex", sessionId: "thr_old" }, { cwd: tmpDir });
    sessions.push(session);
    const params = received().find((m) => m.method === "thread/fork")?.params;
    expect(params).toMatchObject({ threadId: "thr_old" });
    expect(params).not.toHaveProperty("lastTurnId");
  });

  test("图片输入写入临时文件并以 localImage 传给 codex", async () => {
    const session = await newSession();
    const events = collect(session);
    await session.startTurn([
      { type: "text", text: "hello" },
      { type: "image", data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" },
    ]);
    await waitUntil(() => events.some(isTerminal));
    const input = received().find((m) => m.method === "turn/start")?.params.input;
    expect(input[0]).toEqual({ type: "text", text: "hello", text_elements: [] });
    expect(input[1].type).toBe("localImage");
    expect(readFileSync(input[1].path, "utf8")).toBe("png-bytes");
    await session.close();
    expect(existsSync(input[1].path)).toBe(false);
  });

  test("子代理：子线程通知先缓冲、登记后回放，写入子代理时间线；父卡片累积 log 并随子线程完成", async () => {
    const session = await newSession();
    const events = collect(session);
    const subagentEvents: ProviderSubagentInputEvent[] = [];
    session.subscribe((e) => {
      if (e.type === "provider_subagent") subagentEvents.push(e.event);
    });
    await session.startTurn("subagent");
    await waitUntil(() => events.some(isTerminal));
    expect(events.find(isTerminal)?.type).toBe("turn_completed");

    // 子线程的消息没有进入父时间线
    const assistantTexts = events.flatMap((e) =>
      e.type === "timeline" && e.item.type === "assistant_message" ? [e.item.text] : [],
    );
    expect(assistantTexts.join("")).toBe("子代理说 name 是 demo");

    // 登记：子代理 id = 子线程 id，挂在 collab_1 卡片上
    const upserts = subagentEvents.filter((e) => e.type === "upsert");
    expect(upserts[0]).toMatchObject({
      type: "upsert",
      id: "thr_child",
      title: "Sub-agent",
      description: "读取 name",
      toolCallId: "collab_1",
      parentSubagentId: null,
    });
    expect(upserts.at(-1)).toMatchObject({ id: "thr_child", status: "completed" });

    // 子代理时间线：回放的 user_message、增量文本、命令卡片，以及完成时补发的缺失后缀
    const timeline = subagentEvents.flatMap((e) => (e.type === "timeline" ? [e.item] : []));
    expect(timeline[0]).toEqual({ type: "user_message", text: "读取 name" });
    expect(
      timeline.filter((i) => i.type === "assistant_message").map((i) => (i.type === "assistant_message" ? i.text : "")),
    ).toEqual(["我来", "读取：name 是 demo"]);
    expect(timeline.some((i) => i.type === "tool_call" && i.callId === "cexec_1" && i.status === "completed")).toBe(
      true,
    );

    // 父卡片：同 callId 多次推送，最后一次为 completed 且 log 汇总了子线程活动
    const cards = events.flatMap((e) =>
      e.type === "timeline" && e.item.type === "tool_call" && e.item.callId === "collab_1" ? [e.item] : [],
    );
    const last = cards.at(-1);
    expect(last?.status).toBe("completed");
    expect(last?.detail.type).toBe("sub_agent");
    const log = last?.detail.type === "sub_agent" ? last.detail.log : "";
    expect(log).toContain("[User] 读取 name");
    expect(log).toContain("cat package.json");
    expect(log).toContain("[Assistant] 我来读取：name 是 demo");
  });

  test("close 结束 app-server 进程；关闭后 startTurn 报错", async () => {
    const session = await newSession();
    const events = collect(session);
    await session.startTurn("hang");
    await waitUntil(() => received().some((m) => m.method === "turn/start"));
    await session.close();
    await expect(session.startTurn("hello")).rejects.toThrow("已关闭");
    expect(events.filter(isTerminal)).toHaveLength(1);
  });
});
