import type { ChildProcess } from "node:child_process";

import type {
  Options,
  PermissionMode,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentStreamEvent, ToolCallTimelineItem } from "@agentdeck/protocol";
import { describe, expect, test } from "vitest";

import type { AgentSession } from "../../../src/agent/types.js";
import { createSilentLogger } from "../../../src/logger.js";
import {
  ClaudeAgentClient,
  type ClaudeQueryFn,
  type ClaudeQueryHandle,
} from "../../../src/providers/claude/index.js";
import type { ProcessTerminator } from "../../../src/utils/tree-kill.js";

// ---------------------------------------------------------------------------
// 假 query：记录收到的用户消息，测试脚本通过 onUser 回调推送 SDK 消息
// ---------------------------------------------------------------------------

class FakeQuery implements ClaudeQueryHandle {
  readonly received: SDKUserMessage[] = [];
  readonly calls = {
    interrupt: 0,
    setModel: [] as (string | undefined)[],
    setPermissionMode: [] as PermissionMode[],
    close: 0,
  };
  inputEnded = false;
  interruptImpl: () => Promise<undefined> = async () => undefined;
  onUser: (message: SDKUserMessage, query: FakeQuery) => void = () => undefined;

  private readonly outbox: SDKMessage[] = [];
  private waiter: ((result: IteratorResult<SDKMessage, void>) => void) | null = null;
  private ended = false;
  private failure: Error | null = null;

  constructor(
    readonly prompt: AsyncIterable<SDKUserMessage>,
    readonly options: Options,
  ) {
    void this.consume();
  }

  private async consume(): Promise<void> {
    for await (const message of this.prompt) {
      this.received.push(message);
      this.onUser(message, this);
    }
    this.inputEnded = true;
  }

  emit(...messages: unknown[]): void {
    for (const message of messages) {
      const waiter = this.waiter;
      if (waiter) {
        this.waiter = null;
        waiter({ value: message as SDKMessage, done: false });
      } else {
        this.outbox.push(message as SDKMessage);
      }
    }
  }

  end(error?: Error): void {
    this.ended = true;
    this.failure = error ?? null;
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) {
      if (error) {
        // 让 next() 走异常分支
        this.failure = null;
        (waiter as unknown as (r: Promise<never>) => void)(Promise.reject(error));
      } else {
        waiter({ value: undefined, done: true });
      }
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage, void> {
    return {
      next: () => {
        const next = this.outbox.shift();
        if (next) return Promise.resolve({ value: next, done: false });
        if (this.ended) {
          if (this.failure) {
            const error = this.failure;
            this.failure = null;
            return Promise.reject(error);
          }
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }

  async interrupt(): Promise<undefined> {
    this.calls.interrupt += 1;
    return this.interruptImpl();
  }

  async setModel(model?: string): Promise<void> {
    this.calls.setModel.push(model);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.calls.setPermissionMode.push(mode);
  }

  close(): void {
    this.calls.close += 1;
    this.end();
  }
}

interface Harness {
  client: ClaudeAgentClient;
  queries: FakeQuery[];
  terminated: unknown[];
  /** 新建 query 时用来配置脚本 */
  setup: (configure: (query: FakeQuery) => void) => void;
}

function createHarness(env: NodeJS.ProcessEnv = {}): Harness {
  const queries: FakeQuery[] = [];
  const terminated: unknown[] = [];
  let configure: (query: FakeQuery) => void = () => undefined;
  const queryFn: ClaudeQueryFn = ({ prompt, options }) => {
    const query = new FakeQuery(prompt, options);
    configure(query);
    queries.push(query);
    return query;
  };
  const terminateProcess: ProcessTerminator = async (child) => {
    terminated.push(child);
    return "terminated";
  };
  const client = new ClaudeAgentClient({
    logger: createSilentLogger(),
    env,
    queryFn,
    terminateProcess,
    resolveExecutable: async () => ({
      available: true,
      path: "C:\\fake\\claude.exe",
      source: "path",
      version: "2.1.296 (Claude Code)",
    }),
  });
  return {
    client,
    queries,
    terminated,
    setup: (fn) => {
      configure = fn;
    },
  };
}

function collect(session: AgentSession): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  return events;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil 超时");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

const msg = {
  init: (sessionId = SESSION_ID) => ({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    uuid: "u-init",
  }),
  streamStart: (id: string) => ({
    type: "stream_event",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: `se-${id}`,
    event: {
      type: "message_start",
      message: { id, usage: { input_tokens: 10, cache_read_input_tokens: 90 } },
    },
  }),
  textDelta: (text: string) => ({
    type: "stream_event",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: "se",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  }),
  thinkingDelta: (thinking: string) => ({
    type: "stream_event",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: "se",
    event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } },
  }),
  assistant: (id: string, content: unknown[], parent: string | null = null) => ({
    type: "assistant",
    parent_tool_use_id: parent,
    session_id: SESSION_ID,
    uuid: `a-${id}`,
    message: { id, role: "assistant", content },
  }),
  toolResult: (toolUseId: string, content: unknown, opts: { isError?: boolean; structured?: unknown } = {}) => ({
    type: "user",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: `tr-${toolUseId}`,
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: toolUseId, content, ...(opts.isError ? { is_error: true } : {}) },
      ],
    },
    ...(opts.structured !== undefined ? { tool_use_result: opts.structured } : {}),
  }),
  result: (
    userMessageUuid: string | undefined,
    opts: { isError?: boolean; subtype?: string; result?: string; errors?: string[] } = {},
  ) => ({
    type: "result",
    subtype: opts.subtype ?? "success",
    is_error: opts.isError ?? false,
    result: opts.result ?? "done",
    errors: opts.errors,
    session_id: SESSION_ID,
    uuid: "r",
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    stop_reason: "end_turn",
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 10,
      cache_read_input_tokens: 90,
      cache_creation_input_tokens: 0,
      output_tokens: 5,
    },
    modelUsage: { "claude-sonnet": { contextWindow: 200000 } },
    permission_denials: [],
    ...(userMessageUuid ? { user_message_uuid: userMessageUuid } : {}),
  }),
};

/** 默认脚本：每轮回复 init（仅首轮）+ 流式文本 + 完整 assistant + result */
function replyText(text: string) {
  let first = true;
  return (user: SDKUserMessage, query: FakeQuery) => {
    const id = `msg-${query.received.length}`;
    if (first) {
      query.emit(msg.init());
      first = false;
    }
    query.emit(
      msg.streamStart(id),
      msg.thinkingDelta("想一想"),
      msg.textDelta(text.slice(0, 2)),
      msg.textDelta(text.slice(2)),
      msg.assistant(id, [{ type: "thinking", thinking: "想一想" }]),
      msg.assistant(id, [{ type: "text", text }]),
      msg.result(user.uuid),
    );
  };
}

function terminalEvents(events: AgentStreamEvent[]) {
  return events.filter(
    (e) => e.type === "turn_completed" || e.type === "turn_failed" || e.type === "turn_canceled",
  );
}

function toolCalls(events: AgentStreamEvent[]): ToolCallTimelineItem[] {
  return events.flatMap((e) =>
    e.type === "timeline" && e.item.type === "tool_call" ? [e.item] : [],
  );
}

// ---------------------------------------------------------------------------

describe("ClaudeAgentClient", () => {
  test("可用性、目录与模式校验", async () => {
    const { client } = createHarness();
    expect(client.provider).toBe("claude");
    expect(client.kind).toBe("claude");
    expect(client.label).toBe("Claude Code");
    await expect(client.isAvailable()).resolves.toEqual({
      available: true,
      command: ["C:\\fake\\claude.exe"],
    });
    const catalog = await client.fetchCatalog();
    expect(catalog.models.map((m) => m.id)).toEqual(["default", "sonnet", "opus", "haiku"]);
    expect(catalog.models.find((m) => m.isDefault)?.id).toBe("default");
    expect(catalog.modes.map((m) => m.id)).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
    ]);
    await expect(client.createSession({ cwd: ".", modeId: "yolo" })).rejects.toThrow("不支持模式");
  });

  test("不可用时 isAvailable 给出原因，createSession 抛错，且失败结果不缓存", async () => {
    let calls = 0;
    const client = new ClaudeAgentClient({
      logger: createSilentLogger(),
      env: {},
      resolveExecutable: async () => {
        calls += 1;
        return { available: false, reason: "未找到 Claude Code" };
      },
    });
    await expect(client.isAvailable()).resolves.toEqual({
      available: false,
      reason: "未找到 Claude Code",
    });
    await expect(client.createSession({ cwd: "." })).rejects.toThrow("未找到 Claude Code");
    expect(calls).toBe(2);
  });

  test("成功结果被缓存", async () => {
    let calls = 0;
    const client = new ClaudeAgentClient({
      logger: createSilentLogger(),
      env: {},
      resolveExecutable: async () => {
        calls += 1;
        return { available: true, path: "x.exe", source: "path", version: "1" };
      },
    });
    await client.isAvailable();
    await client.isAvailable();
    expect(calls).toBe(1);
  });
});

describe("ClaudeAgentSession", () => {
  test("首轮才创建 query，options 符合约定，env 已清洗", async () => {
    const h = createHarness({
      PATH: "C:\\bin",
      AGENTDECK_TOKEN: "secret",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
    });
    h.setup((q) => (q.onUser = replyText("OK")));
    const session = await h.client.createSession({ cwd: "J:\\work", modeId: "acceptEdits" });
    expect(h.queries).toHaveLength(0);
    expect(session.id).toBeNull();
    expect(session.describePersistence()).toBeNull();

    const events = collect(session);
    await session.startTurn("hi");
    await waitUntil(() => terminalEvents(events).length === 1);

    expect(h.queries).toHaveLength(1);
    const options = h.queries[0]!.options;
    expect(options).toMatchObject({
      cwd: "J:\\work",
      includePartialMessages: true,
      permissionMode: "acceptEdits",
      pathToClaudeCodeExecutable: "C:\\fake\\claude.exe",
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project", "local"],
    });
    expect(options.model).toBeUndefined();
    expect(options.resume).toBeUndefined();
    expect(typeof options.canUseTool).toBe("function");
    expect(typeof options.spawnClaudeCodeProcess).toBe("function");
    expect(typeof options.stderr).toBe("function");
    expect(options.env).toEqual({ PATH: "C:\\bin" });
  });

  test("一轮完整事件：thread_started、思考/文本增量（无重复）、usage、turn_completed", async () => {
    const h = createHarness();
    h.setup((q) => (q.onUser = replyText("你好世界")));
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    const { turnId } = await session.startTurn("hi");
    await waitUntil(() => terminalEvents(events).length === 1);

    expect(events.map((e) => (e.type === "timeline" ? `timeline:${e.item.type}` : e.type))).toEqual([
      "turn_started",
      "thread_started",
      "timeline:reasoning",
      "timeline:assistant_message",
      "timeline:assistant_message",
      "usage_updated",
      "turn_completed",
    ]);
    expect(events[0]).toEqual({ type: "turn_started", turnId });
    expect(events[1]).toEqual({ type: "thread_started", sessionId: SESSION_ID });
    const text = events
      .flatMap((e) => (e.type === "timeline" && e.item.type === "assistant_message" ? [e.item.text] : []))
      .join("");
    expect(text).toBe("你好世界");
    for (const event of events) {
      if (event.type === "timeline") expect(event.turnId).toBe(turnId);
    }
    const completed = events.at(-1);
    expect(completed).toMatchObject({
      type: "turn_completed",
      turnId,
      usage: {
        inputTokens: 100,
        cachedInputTokens: 90,
        outputTokens: 5,
        totalCostUsd: 0.01,
        contextWindowMaxTokens: 200000,
        contextWindowUsedTokens: 100,
      },
    });
    expect(events.some((e) => e.type === "timeline" && e.item.type === "user_message")).toBe(false);
    expect(session.id).toBe(SESSION_ID);
    expect(session.describePersistence()).toEqual({ provider: "claude", sessionId: SESSION_ID });
  });

  test("没有流式增量时使用完整 assistant 消息；子代理消息被忽略", async () => {
    const h = createHarness();
    h.setup(
      (q) =>
        (q.onUser = (user) => {
          q.emit(
            msg.init(),
            msg.assistant("m1", [{ type: "text", text: "子代理输出" }], "toolu_parent"),
            msg.assistant("m2", [
              { type: "thinking", thinking: "完整思考" },
              { type: "text", text: "完整回复" },
            ]),
            msg.result(user.uuid),
          );
        }),
    );
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("hi");
    await waitUntil(() => terminalEvents(events).length === 1);
    const items = events.flatMap((e) => (e.type === "timeline" ? [e.item] : []));
    expect(items).toEqual([
      { type: "reasoning", text: "完整思考" },
      { type: "assistant_message", text: "完整回复", messageId: "m2" },
    ]);
  });

  test("多轮复用同一 query，thread_started 只发一次", async () => {
    const h = createHarness();
    h.setup((q) => (q.onUser = replyText("OK")));
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("one");
    await waitUntil(() => terminalEvents(events).length === 1);
    await session.startTurn([
      { type: "text", text: "two" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "image", data: "eA==", mimeType: "image/bmp" },
    ]);
    await waitUntil(() => terminalEvents(events).length === 2);

    expect(h.queries).toHaveLength(1);
    const query = h.queries[0]!;
    expect(query.received).toHaveLength(2);
    expect(query.received[1]!.message.content).toEqual([
      { type: "text", text: "two" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
      { type: "text", text: "[不支持的图片类型：image/bmp]" },
    ]);
    expect(events.filter((e) => e.type === "thread_started")).toHaveLength(1);
    expect(terminalEvents(events).map((e) => e.type)).toEqual(["turn_completed", "turn_completed"]);
  });

  test("回合进行中再次 startTurn 抛错", async () => {
    const h = createHarness();
    const session = await h.client.createSession({ cwd: "." });
    await session.startTurn("one");
    await expect(session.startTurn("two")).rejects.toThrow("正在执行中");
  });

  test("tool_use → running，tool_result → completed / failed，TodoWrite → todo", async () => {
    const h = createHarness();
    h.setup(
      (q) =>
        (q.onUser = (user) => {
          q.emit(
            msg.init(),
            msg.assistant("m1", [
              { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo hi" } },
            ]),
            msg.toolResult("toolu_1", "hi", {
              structured: { stdout: "hi", stderr: "", interrupted: false },
            }),
            msg.assistant("m2", [
              { type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "a.txt" } },
            ]),
            msg.toolResult("toolu_2", [{ type: "text", text: "File does not exist." }], {
              isError: true,
            }),
            msg.assistant("m3", [
              {
                type: "tool_use",
                id: "toolu_3",
                name: "TodoWrite",
                input: {
                  todos: [
                    { content: "第一步", status: "completed", activeForm: "x" },
                    { content: "第二步", status: "in_progress", activeForm: "y" },
                  ],
                },
              },
            ]),
            msg.toolResult("toolu_3", "ok"),
            msg.assistant("m4", [
              { type: "tool_use", id: "toolu_4", name: "Glob", input: { pattern: "*.ts" } },
            ]),
            msg.toolResult("toolu_4", "a.ts", {
              structured: { durationMs: 1, numFiles: 1, filenames: ["a.ts"], truncated: false },
            }),
            msg.result(user.uuid),
          );
        }),
    );
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("run");
    await waitUntil(() => terminalEvents(events).length === 1);

    expect(toolCalls(events)).toEqual([
      {
        type: "tool_call",
        callId: "toolu_1",
        name: "Bash",
        status: "running",
        error: null,
        detail: { type: "shell", command: "echo hi" },
      },
      {
        type: "tool_call",
        callId: "toolu_1",
        name: "Bash",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "echo hi", output: "hi" },
      },
      {
        type: "tool_call",
        callId: "toolu_2",
        name: "Read",
        status: "running",
        error: null,
        detail: { type: "read", filePath: "a.txt" },
      },
      {
        type: "tool_call",
        callId: "toolu_2",
        name: "Read",
        status: "failed",
        error: "File does not exist.",
        detail: { type: "read", filePath: "a.txt" },
      },
      {
        type: "tool_call",
        callId: "toolu_4",
        name: "Glob",
        status: "running",
        error: null,
        detail: { type: "search", query: "*.ts", toolName: "glob" },
      },
      {
        type: "tool_call",
        callId: "toolu_4",
        name: "Glob",
        status: "completed",
        error: null,
        detail: { type: "search", query: "*.ts", toolName: "glob", filePaths: ["a.ts"] },
      },
    ]);
    const todos = events.flatMap((e) => (e.type === "timeline" && e.item.type === "todo" ? [e.item] : []));
    expect(todos).toEqual([
      {
        type: "todo",
        items: [
          { text: "第一步", completed: true },
          { text: "第二步", completed: false },
        ],
      },
    ]);
  });

  test("result is_error / 错误 subtype → turn_failed", async () => {
    const h = createHarness();
    let round = 0;
    h.setup(
      (q) =>
        (q.onUser = (user) => {
          round += 1;
          q.emit(
            round === 1
              ? msg.result(user.uuid, { isError: true, result: "Invalid API key · Please run /login" })
              : msg.result(user.uuid, { subtype: "error_max_turns", isError: true, errors: [] }),
          );
        }),
    );
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    const { turnId } = await session.startTurn("a");
    await waitUntil(() => terminalEvents(events).length === 1);
    expect(terminalEvents(events)[0]).toEqual({
      type: "turn_failed",
      turnId,
      error: "Invalid API key · Please run /login",
      code: "success",
    });
    await session.startTurn("b");
    await waitUntil(() => terminalEvents(events).length === 2);
    expect(terminalEvents(events)[1]).toMatchObject({
      type: "turn_failed",
      error: "已达到最大轮次限制",
      code: "error_max_turns",
    });
  });

  test("canUseTool：allow 回传 updatedInput（默认原 input），deny 回传 message", async () => {
    const h = createHarness();
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("x");
    const canUseTool = h.queries[0]!.options.canUseTool!;
    const signal = new AbortController().signal;

    const allowPromise = canUseTool("Bash", { command: "rm -rf tmp" }, {
      signal,
      toolUseID: "toolu_9",
      requestId: "req-1",
      title: "Claude wants to run rm",
    });
    const requested = events.find((e) => e.type === "permission_requested");
    expect(requested?.type).toBe("permission_requested");
    if (requested?.type !== "permission_requested") throw new Error("unreachable");
    expect(requested.request).toMatchObject({
      provider: "claude",
      name: "Bash",
      kind: "tool",
      title: "Claude wants to run rm",
      input: { command: "rm -rf tmp" },
      detail: { type: "shell", command: "rm -rf tmp" },
      actions: [
        { id: "allow", label: "允许一次", behavior: "allow" },
        { id: "deny", label: "拒绝", behavior: "deny" },
      ],
    });
    expect(session.getPendingPermissions()).toHaveLength(1);

    await session.respondToPermission(requested.request.id, { behavior: "allow" });
    await expect(allowPromise).resolves.toEqual({
      behavior: "allow",
      updatedInput: { command: "rm -rf tmp" },
    } satisfies PermissionResult);
    expect(events.at(-1)).toEqual({
      type: "permission_resolved",
      requestId: requested.request.id,
      response: { behavior: "allow" },
    });

    const updatedPromise = canUseTool("Bash", { command: "a" }, { signal, toolUseID: "t2", requestId: "r2" });
    const second = session.getPendingPermissions()[0]!;
    await session.respondToPermission(second.id, {
      behavior: "allow",
      updatedInput: { command: "b" },
    });
    await expect(updatedPromise).resolves.toEqual({ behavior: "allow", updatedInput: { command: "b" } });

    const denyPromise = canUseTool("Write", { file_path: "a.txt", content: "x" }, {
      signal,
      toolUseID: "t3",
      requestId: "r3",
    });
    const third = session.getPendingPermissions()[0]!;
    await session.respondToPermission(third.id, { behavior: "deny" });
    await expect(denyPromise).resolves.toEqual({ behavior: "deny", message: "用户拒绝了该操作" });
    expect(session.getPendingPermissions()).toHaveLength(0);
    await expect(session.respondToPermission("nope", { behavior: "deny" })).rejects.toThrow();
  });

  test("ExitPlanMode 为 plan 权限；批准后切出 plan 模式", async () => {
    const h = createHarness();
    const session = await h.client.createSession({ cwd: ".", modeId: "plan" });
    const events = collect(session);
    await session.startTurn("x");
    const canUseTool = h.queries[0]!.options.canUseTool!;
    const promise = canUseTool("ExitPlanMode", { plan: "1. 改代码" }, {
      signal: new AbortController().signal,
      toolUseID: "tp",
      requestId: "rp",
    });
    const request = session.getPendingPermissions()[0]!;
    expect(request).toMatchObject({
      kind: "plan",
      detail: { type: "plan", text: "1. 改代码" },
      actions: [
        { id: "approve", label: "批准计划", behavior: "allow" },
        { id: "keep_planning", label: "继续规划", behavior: "deny" },
      ],
    });
    await session.respondToPermission(request.id, { behavior: "allow", selectedActionId: "approve" });
    await expect(promise).resolves.toEqual({ behavior: "allow", updatedInput: { plan: "1. 改代码" } });
    expect(h.queries[0]!.calls.setPermissionMode).toEqual(["default"]);
    expect(events.some((e) => e.type === "mode_changed" && e.modeId === "default")).toBe(true);
  });

  test("abort signal 触发时自动 deny 并发 permission_resolved", async () => {
    const h = createHarness();
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("x");
    const controller = new AbortController();
    const promise = h.queries[0]!.options.canUseTool!("Bash", { command: "ls" }, {
      signal: controller.signal,
      toolUseID: "t",
      requestId: "r",
    });
    controller.abort();
    await expect(promise).resolves.toMatchObject({ behavior: "deny" });
    expect(session.getPendingPermissions()).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "permission_resolved", response: { behavior: "deny" } });
  });

  test("interrupt：拒绝挂起权限、取消运行中工具、调用 query.interrupt、发 turn_canceled，忽略过期 result", async () => {
    const h = createHarness();
    let round = 0;
    h.setup(
      (q) =>
        (q.onUser = (user) => {
          round += 1;
          if (round === 1) {
            q.emit(
              msg.init(),
              msg.assistant("m1", [
                { type: "tool_use", id: "toolu_s", name: "Bash", input: { command: "sleep 100" } },
              ]),
            );
            return;
          }
          // 第二轮：先收到上一轮被中断的过期 result，再收到本轮的
          q.emit(
            msg.result(q.received[0]!.uuid, { subtype: "error_during_execution", isError: true }),
            msg.textDelta("第二轮"),
            msg.result(user.uuid),
          );
        }),
    );
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    const { turnId } = await session.startTurn("long");
    await waitUntil(() => toolCalls(events).length === 1);
    const permission = h.queries[0]!.options.canUseTool!("Bash", { command: "sleep 100" }, {
      signal: new AbortController().signal,
      toolUseID: "toolu_s",
      requestId: "r",
    });

    await session.interrupt();
    expect(h.queries[0]!.calls.interrupt).toBe(1);
    await expect(permission).resolves.toMatchObject({ behavior: "deny" });
    expect(toolCalls(events).at(-1)).toMatchObject({ callId: "toolu_s", status: "canceled" });
    expect(terminalEvents(events)).toEqual([{ type: "turn_canceled", turnId, reason: "interrupted" }]);
    await session.interrupt(); // 无进行中回合时为 no-op

    const second = await session.startTurn("next");
    await waitUntil(() => terminalEvents(events).length === 2);
    expect(terminalEvents(events)[1]).toMatchObject({ type: "turn_completed", turnId: second.turnId });
    expect(h.queries).toHaveLength(1);
  });

  test("interrupt 超时（3 秒）后拆掉 query，下一轮以 resume 重建", async () => {
    const h = createHarness();
    let created = 0;
    h.setup((q) => {
      created += 1;
      if (created === 1) {
        q.interruptImpl = () => new Promise(() => undefined);
        q.onUser = () => q.emit(msg.init());
      } else {
        q.onUser = (user) => q.emit(msg.result(user.uuid));
      }
    });
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("x");
    await waitUntil(() => events.some((e) => e.type === "thread_started"));
    const started = Date.now();
    await session.interrupt();
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
    expect(terminalEvents(events).map((e) => e.type)).toEqual(["turn_canceled"]);
    expect(h.queries[0]!.calls.close).toBe(1);

    await session.startTurn("y");
    await waitUntil(() => terminalEvents(events).length === 2);
    expect(h.queries).toHaveLength(2);
    expect(h.queries[1]!.options.resume).toBe(SESSION_ID);
  });

  test("消息流意外结束 → turn_failed，下一轮重建 query 并 resume", async () => {
    const h = createHarness();
    let created = 0;
    h.setup((q) => {
      created += 1;
      if (created === 1) {
        q.onUser = () => {
          q.emit(msg.init());
          setTimeout(() => q.end(new Error("process exited with code 1")), 5);
        };
      } else {
        q.onUser = (user) => q.emit(msg.result(user.uuid));
      }
    });
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("x");
    await waitUntil(() => terminalEvents(events).length === 1);
    expect(terminalEvents(events)[0]).toMatchObject({
      type: "turn_failed",
      error: "Claude Code 异常退出：process exited with code 1",
    });
    await session.startTurn("y");
    await waitUntil(() => terminalEvents(events).length === 2);
    expect(terminalEvents(events)[1]!.type).toBe("turn_completed");
    expect(h.queries[1]!.options.resume).toBe(SESSION_ID);
  });

  test("setModel / setMode：无 query 时记下并在创建时生效，有 query 时调用 SDK", async () => {
    const h = createHarness();
    h.setup((q) => (q.onUser = (user) => q.emit(msg.result(user.uuid))));
    const session = await h.client.createSession({ cwd: ".", model: "default" });
    const events = collect(session);
    await session.setModel!("opus");
    await session.setMode!("plan");
    await expect(session.setMode!("nope")).rejects.toThrow();
    expect(events).toEqual([
      { type: "model_changed", modelId: "opus" },
      { type: "mode_changed", modeId: "plan" },
    ]);
    await session.startTurn("x");
    await waitUntil(() => terminalEvents(events).length === 1);
    expect(h.queries[0]!.options).toMatchObject({ model: "opus", permissionMode: "plan" });

    await session.setModel!("default");
    await session.setModel!("haiku");
    await session.setMode!("bypassPermissions");
    expect(h.queries[0]!.calls.setModel).toEqual([undefined, "haiku"]);
    expect(h.queries[0]!.calls.setPermissionMode).toEqual(["bypassPermissions"]);
  });

  test("resumeSession：立即可描述持久化句柄，并以 resume 启动", async () => {
    const h = createHarness();
    h.setup((q) => (q.onUser = replyText("继续")));
    const session = await h.client.resumeSession({ provider: "claude", sessionId: SESSION_ID }, { cwd: "." });
    expect(session.id).toBe(SESSION_ID);
    expect(session.describePersistence()).toEqual({ provider: "claude", sessionId: SESSION_ID });
    const events = collect(session);
    await session.startTurn("x");
    await waitUntil(() => terminalEvents(events).length === 1);
    expect(h.queries[0]!.options.resume).toBe(SESSION_ID);
    expect(events.filter((e) => e.type === "thread_started")).toHaveLength(1);
  });

  test("spawnClaudeCodeProcess 以 shell:false 拉起子进程；close 结束输入、tree-kill 子进程并取消回合", async () => {
    const h = createHarness();
    let child: ChildProcess | null = null;
    h.setup((q) => {
      const spawned = q.options.spawnClaudeCodeProcess!({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: process.cwd(),
        env: q.options.env ?? {},
        signal: new AbortController().signal,
      });
      child = spawned as unknown as ChildProcess;
    });
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    const { turnId } = await session.startTurn("x");
    expect(child).not.toBeNull();
    const pid = (child as unknown as ChildProcess).pid;
    expect(typeof pid).toBe("number");

    await session.close();
    expect(terminalEvents(events)).toEqual([{ type: "turn_canceled", turnId, reason: "closed" }]);
    expect(h.terminated).toEqual([child]);
    expect(h.queries[0]!.calls.close).toBe(1);
    await waitUntil(() => h.queries[0]!.inputEnded);
    await expect(session.startTurn("again")).rejects.toThrow("已关闭");
    (child as unknown as ChildProcess).kill();
  });
});
