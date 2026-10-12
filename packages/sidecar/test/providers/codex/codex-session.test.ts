import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentStreamEvent } from "@agentdeck/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { AgentSession } from "../../../src/agent/types.js";
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
  session.subscribe((e) => events.push(e));
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
      { provider: "codex", id: "gpt-a", label: "GPT-A", description: "默认模型", isDefault: true },
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
    expect(events.at(-1)).toEqual({ type: "turn_completed", turnId, usage });
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
