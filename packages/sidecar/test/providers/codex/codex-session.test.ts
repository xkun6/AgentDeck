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

    expect(events[0]).toEqual({ type: "turn_started", turnId });
    expect(events[1]).toEqual({ type: "thread_started", sessionId: "thr_fake" });
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
      actions: [
        { id: "accept", label: "允许", behavior: "allow" },
        { id: "decline", label: "拒绝", behavior: "deny" },
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
