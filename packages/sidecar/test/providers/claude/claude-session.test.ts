import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentModelDefinition, AgentStreamEvent, ToolCallTimelineItem } from "@agentdeck/protocol";
import { describe, expect, test } from "vitest";

import type { AgentSession } from "../../../src/agent/types.js";
import { createSilentLogger } from "../../../src/logger.js";
import {
  ClaudeAgentClient,
  type ClaudeCliFactory,
  type ClaudeCliHandle,
  type ClaudeCliOptions,
} from "../../../src/providers/claude/index.js";
import type {
  ClaudeInitializeResponse,
  ClaudeOutputMessage,
  ClaudePermissionMode,
  ClaudePermissionResult,
  ClaudeUserInput,
} from "../../../src/providers/claude/stream-json-types.js";
import type { ProcessTerminator } from "../../../src/utils/tree-kill.js";

// ---------------------------------------------------------------------------
// 假 claude 进程句柄：记录收到的用户消息，测试脚本通过 onUser 回调推送 CLI 消息
// ---------------------------------------------------------------------------

class FakeCli implements ClaudeCliHandle {
  readonly received: ClaudeUserInput[] = [];
  readonly calls = {
    interrupt: 0,
    setModel: [] as (string | null)[],
    setPermissionMode: [] as ClaudePermissionMode[],
    close: 0,
  };
  initialized: Promise<ClaudeInitializeResponse> = Promise.resolve({});
  interruptImpl: () => Promise<void> = async () => undefined;
  onUser: (message: ClaudeUserInput, cli: FakeCli) => void = () => undefined;

  private readonly outbox: ClaudeOutputMessage[] = [];
  private waiter: {
    resolve: (result: IteratorResult<ClaudeOutputMessage, void>) => void;
    reject: (error: Error) => void;
  } | null = null;
  private ended = false;
  private failure: Error | null = null;

  constructor(readonly options: ClaudeCliOptions) {}

  sendUserMessage(message: ClaudeUserInput): void {
    if (this.ended) throw new Error("Claude Code 进程已退出");
    this.received.push(message);
    queueMicrotask(() => this.onUser(message, this));
  }

  emit(...messages: unknown[]): void {
    for (const message of messages) {
      const waiter = this.waiter;
      if (waiter) {
        this.waiter = null;
        waiter.resolve({ value: message as ClaudeOutputMessage, done: false });
      } else {
        this.outbox.push(message as ClaudeOutputMessage);
      }
    }
  }

  end(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) {
      if (error) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
      return;
    }
    this.failure = error ?? null;
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeOutputMessage, void> {
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
        return new Promise((resolve, reject) => {
          this.waiter = { resolve, reject };
        });
      },
    };
  }

  async interrupt(): Promise<void> {
    this.calls.interrupt += 1;
    return this.interruptImpl();
  }

  async setModel(model: string | null): Promise<void> {
    this.calls.setModel.push(model);
  }

  async setPermissionMode(mode: ClaudePermissionMode): Promise<void> {
    this.calls.setPermissionMode.push(mode);
  }

  async close(): Promise<void> {
    this.calls.close += 1;
    this.end();
  }
}

interface Harness {
  client: ClaudeAgentClient;
  clis: FakeCli[];
  terminateProcess: ProcessTerminator;
  /** 新建 claude 进程时用来配置脚本 */
  setup: (configure: (cli: FakeCli) => void) => void;
}

function createHarness(
  env: NodeJS.ProcessEnv = {},
  loadSettings: () => Promise<Record<string, unknown> | null> = async () => null,
): Harness {
  const clis: FakeCli[] = [];
  let configure: (cli: FakeCli) => void = () => undefined;
  const cliFactory: ClaudeCliFactory = (options) => {
    const cli = new FakeCli(options);
    configure(cli);
    clis.push(cli);
    return cli;
  };
  const terminateProcess: ProcessTerminator = async () => "terminated";
  const client = new ClaudeAgentClient({
    logger: createSilentLogger(),
    env,
    // 默认不读本机用户的 Claude 设置，保证模型列表与机器无关
    loadSettings,
    cliFactory,
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
    clis,
    terminateProcess,
    setup: (fn) => {
      configure = fn;
    },
  };
}

/** 直接调用传给 claude 进程的 canUseTool 回调（模拟 CLI 发来 can_use_tool） */
function canUseTool(
  cli: FakeCli,
  toolName: string,
  input: Record<string, unknown>,
  ctx: { signal?: AbortSignal; toolUseId?: string; title?: string } = {},
): Promise<ClaudePermissionResult> {
  return cli.options.canUseTool(toolName, input, {
    signal: ctx.signal ?? new AbortController().signal,
    ...(ctx.toolUseId ? { toolUseId: ctx.toolUseId } : {}),
    ...(ctx.title ? { title: ctx.title } : {}),
  });
}

function collect(session: AgentSession): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => {
    if (event.type !== "provider_subagent") events.push(event);
  });
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

/** 去掉思考档位字段，便于比较模型的其它字段 */
function withoutThinking(model: AgentModelDefinition): AgentModelDefinition {
  const { thinkingOptions: _options, defaultThinkingOptionId: _default, ...rest } = model;
  return rest;
}

function thinkingIds(model: AgentModelDefinition | undefined): string[] | undefined {
  return model?.thinkingOptions?.map((option) => option.id);
}

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
  return (user: ClaudeUserInput, cli: FakeCli) => {
    const id = `msg-${cli.received.length}`;
    if (first) {
      cli.emit(msg.init());
      first = false;
    }
    cli.emit(
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
    expect(catalog.modes.map((m) => [m.id, m.label])).toEqual([
      ["default", "逐项审批"],
      ["acceptEdits", "自动接受编辑"],
      ["auto", "自动模式"],
      ["plan", "计划模式"],
      ["bypassPermissions", "跳过所有审批"],
    ]);
    expect(catalog.modes.filter((m) => m.dangerous).map((m) => m.id)).toEqual(["bypassPermissions"]);
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

  test("可用结果缓存，但「编程 Agent」页配置的路径变化后立即重新解析（无需重启 sidecar）", async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "agentdeck-claude-cfg-"));
    try {
      let calls = 0;
      const client = new ClaudeAgentClient({
        logger: createSilentLogger(),
        env: { AGENTDECK_DATA_DIR: dataDir },
        resolveExecutable: async () => {
          calls += 1;
          return { available: true, path: `claude-${calls}`, source: "path", version: "1" };
        },
      });
      await expect(client.isAvailable()).resolves.toEqual({ available: true, command: ["claude-1"] });
      await expect(client.isAvailable()).resolves.toEqual({ available: true, command: ["claude-1"] });
      expect(calls).toBe(1);

      writeFileSync(
        path.join(dataDir, "coding-agent-paths.json"),
        JSON.stringify({ claude: "C:\\tools\\claude.exe" }),
      );
      await expect(client.isAvailable()).resolves.toEqual({ available: true, command: ["claude-2"] });
      await expect(client.isAvailable()).resolves.toEqual({ available: true, command: ["claude-2"] });
      expect(calls).toBe(2);

      writeFileSync(path.join(dataDir, "coding-agent-paths.json"), JSON.stringify({}));
      await expect(client.isAvailable()).resolves.toEqual({ available: true, command: ["claude-3"] });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("fetchCatalog：优先用 initialize 返回的模型，探测进程随即关闭并缓存结果", async () => {
    const h = createHarness();
    h.setup((cli) => {
      cli.initialized = Promise.resolve({
        models: [
          {
            value: "default",
            displayName: "Default (recommended)",
            description: "Opus · 推荐",
            resolvedModel: "claude-opus-5",
            supportsEffort: true,
            supportedEffortLevels: ["max", "low", "high", "bogus"],
          },
          { value: "sonnet", displayName: "Sonnet", description: "Sonnet · 均衡" },
          { value: "claude-fable-5-1[1m]", displayName: "Fable" },
          { value: "haiku", displayName: "Haiku", supportsEffort: false },
          { value: "" },
        ],
      });
    });
    const catalog = await h.client.fetchCatalog({ cwd: "J:\\work" });
    expect(catalog.models.map(withoutThinking)).toEqual([
      {
        provider: "claude",
        id: "default",
        label: "默认（跟随 Claude Code 配置）",
        description: "跟随 Claude Code 设置",
        isDefault: true,
      },
      { provider: "claude", id: "sonnet", label: "Sonnet", description: "Sonnet · 均衡" },
      { provider: "claude", id: "claude-fable-5-1[1m]", label: "Fable" },
      { provider: "claude", id: "haiku", label: "Haiku" },
    ]);
    // CLI 报告的档位（按 low→max 排序、未知值丢弃）；resolvedModel 命中清单的可关闭思考
    expect(thinkingIds(catalog.models[0])).toEqual(["off", "low", "high", "max"]);
    expect(catalog.models[0]!.thinkingOptions![0]).toEqual({ id: "off", label: "关闭思考" });
    expect(catalog.models[0]!.defaultThinkingOptionId).toBe("high");
    // 无 CLI 档位信息的别名：标准组
    expect(thinkingIds(catalog.models[1])).toEqual(["low", "medium", "high", "max"]);
    // 按清单：Fable 5.1 有 xhigh、不可关闭思考
    expect(thinkingIds(catalog.models[2])).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // supportsEffort=false：无档位
    expect(catalog.models[3]!.thinkingOptions).toBeUndefined();
    expect(h.clis).toHaveLength(1);
    expect(h.clis[0]!.options).toMatchObject({ cwd: "J:\\work", model: null, permissionMode: null, resumeSessionId: null });
    expect(h.clis[0]!.received).toHaveLength(0);
    expect(h.clis[0]!.calls.close).toBe(1);

    await h.client.fetchCatalog();
    expect(h.clis).toHaveLength(1);
  });

  test("fetchCatalog：initialize 失败时退回内置别名，且不缓存失败", async () => {
    const h = createHarness();
    h.setup((cli) => {
      cli.initialized = Promise.reject(new Error("boom"));
    });
    const catalog = await h.client.fetchCatalog();
    expect(catalog.models.map((m) => m.id)).toEqual(["default", "sonnet", "opus", "haiku"]);
    expect(h.clis[0]!.calls.close).toBe(1);
    await h.client.fetchCatalog();
    expect(h.clis).toHaveLength(2);
  });

  test("fetchCatalog：追加 Claude 设置里的模型（去重、原样 id、1M 显示名），默认模型写明当前生效值", async () => {
    let settings: Record<string, unknown> | null = {
      model: "opus[1m]",
      env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet", ANTHROPIC_SMALL_FAST_MODEL: "glm-4.5-air" },
    };
    const h = createHarness({}, async () => settings);
    h.setup((cli) => {
      cli.initialized = Promise.resolve({
        current_permission_mode: "auto",
        models: [
          { value: "default", displayName: "Default (recommended)", description: "Opus 5.5" },
          { value: "opus", displayName: "Opus" },
          { value: "sonnet", displayName: "Sonnet" },
        ],
      });
    });
    const catalog = await h.client.fetchCatalog();
    expect(thinkingIds(catalog.models.find((m) => m.id === "glm-4.5-air"))).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(catalog.models.map(withoutThinking)).toEqual([
      {
        provider: "claude",
        id: "default",
        label: "默认（跟随 Claude Code 配置）",
        description: "跟随 Claude Code 设置（当前：opus[1m]）",
        isDefault: true,
      },
      { provider: "claude", id: "opus", label: "Opus" },
      { provider: "claude", id: "sonnet", label: "Sonnet" },
      {
        provider: "claude",
        id: "opus[1m]",
        label: "Opus · 1M 上下文",
        description: "来自 Claude Code 设置（model）",
      },
      {
        provider: "claude",
        id: "glm-4.5-air",
        label: "glm-4.5-air",
        description: "来自 Claude Code 设置（env.ANTHROPIC_SMALL_FAST_MODEL）",
      },
    ]);

    // 设置每次重新读取（模型探测结果仍走缓存）；读不到时只写「跟随 Claude Code 设置」
    settings = null;
    const again = await h.client.fetchCatalog();
    expect(h.clis).toHaveLength(1);
    expect(again.models.map((m) => m.id)).toEqual(["default", "opus", "sonnet"]);
    expect(again.models[0]!.description).toBe("跟随 Claude Code 设置");
  });

  test("默认读取 $CLAUDE_CONFIG_DIR/settings.json；带 launch 覆盖（中转）时不读用户设置", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "agentdeck-claude-settings-"));
    try {
      writeFileSync(path.join(dir, "settings.json"), `\uFEFF${JSON.stringify({ model: "opus[1m]" })}`);
      const unavailable = async () => ({ available: false as const, reason: "无" });
      const builtin = new ClaudeAgentClient({
        logger: createSilentLogger(),
        env: { CLAUDE_CONFIG_DIR: dir },
        resolveExecutable: unavailable,
      });
      const catalog = await builtin.fetchCatalog();
      expect(catalog.models.map((m) => m.id)).toEqual(["default", "sonnet", "opus", "haiku", "opus[1m]"]);
      expect(catalog.models[0]!.description).toBe("跟随 Claude Code 设置（当前：opus[1m]）");

      const relay = new ClaudeAgentClient({
        logger: createSilentLogger(),
        env: { CLAUDE_CONFIG_DIR: dir },
        providerId: "custom:x",
        launch: { extraArgs: [] },
        resolveExecutable: unavailable,
      });
      const relayCatalog = await relay.fetchCatalog();
      expect(relayCatalog.models.map((m) => m.id)).toEqual(["default", "sonnet", "opus", "haiku"]);
      expect(relayCatalog.models[0]!.description).toBe("跟随 Claude Code 设置");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
  test("首轮才启动 claude 进程，选项符合约定，env 已清洗", async () => {
    const h = createHarness({
      PATH: "C:\\bin",
      AGENTDECK_TOKEN: "secret",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
    });
    h.setup((q) => (q.onUser = replyText("OK")));
    const session = await h.client.createSession({ cwd: "J:\\work", modeId: "acceptEdits" });
    expect(h.clis).toHaveLength(0);
    expect(session.id).toBeNull();
    expect(session.describePersistence()).toBeNull();

    const events = collect(session);
    await session.startTurn("hi");
    await waitUntil(() => terminalEvents(events).length === 1);

    expect(h.clis).toHaveLength(1);
    const options = h.clis[0]!.options;
    expect(options).toMatchObject({
      executablePath: "C:\\fake\\claude.exe",
      cwd: "J:\\work",
      permissionMode: "acceptEdits",
      model: null,
      resumeSessionId: null,
    });
    expect(typeof options.canUseTool).toBe("function");
    expect(typeof options.onStderr).toBe("function");
    expect(options.terminateProcess).toBe(h.terminateProcess);
    expect(options.env).toEqual({ PATH: "C:\\bin" });
    // 用户消息带 uuid，result 以 user_message_uuid 回显
    expect(h.clis[0]!.received[0]).toMatchObject({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
      parent_tool_use_id: null,
      session_id: "",
    });
    expect(typeof h.clis[0]!.received[0]!.uuid).toBe("string");
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

  test("没有流式增量时使用完整 assistant 消息；子代理消息不进主时间线的文本", async () => {
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
    // 没有 task 公告的旧版 CLI：sidechain 帧只产生一张子代理父卡片，文本写入子代理时间线
    expect(items).toEqual([
      {
        type: "tool_call",
        callId: "toolu_parent",
        name: "Task",
        status: "running",
        error: null,
        detail: { type: "sub_agent", log: "", actions: [] },
      },
      { type: "reasoning", text: "完整思考" },
      { type: "assistant_message", text: "完整回复", messageId: "m2" },
    ]);
  });

  test("多轮复用同一 claude 进程，thread_started 只发一次", async () => {
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

    expect(h.clis).toHaveLength(1);
    const cli = h.clis[0]!;
    expect(cli.received).toHaveLength(2);
    expect(cli.received[1]!.session_id).toBe(SESSION_ID);
    expect(cli.received[1]!.message.content).toEqual([
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
    const cli = h.clis[0]!;

    const allowPromise = canUseTool(cli, "Bash", { command: "rm -rf tmp" }, {
      toolUseId: "toolu_9",
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
    } satisfies ClaudePermissionResult);
    expect(events.at(-1)).toEqual({
      type: "permission_resolved",
      requestId: requested.request.id,
      response: { behavior: "allow" },
    });

    const updatedPromise = canUseTool(cli, "Bash", { command: "a" }, { toolUseId: "t2" });
    const second = session.getPendingPermissions()[0]!;
    await session.respondToPermission(second.id, {
      behavior: "allow",
      updatedInput: { command: "b" },
    });
    await expect(updatedPromise).resolves.toEqual({ behavior: "allow", updatedInput: { command: "b" } });

    const denyPromise = canUseTool(cli, "Write", { file_path: "a.txt", content: "x" }, { toolUseId: "t3" });
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
    // 跟随设置进入的 plan：不带 --permission-mode 启动，随即切到 plan
    expect(h.clis[0]!.options.permissionMode).toBeNull();
    expect(h.clis[0]!.calls.setPermissionMode).toEqual(["plan"]);
    const promise = canUseTool(h.clis[0]!, "ExitPlanMode", { plan: "1. 改代码" }, { toolUseId: "tp" });
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
    // initialize 没报告基础模式时退回 default；快照回到「跟随设置」
    expect(h.clis[0]!.calls.setPermissionMode).toEqual(["plan", "default"]);
    expect(events.filter((e) => e.type === "mode_changed")).toEqual([{ type: "mode_changed", modeId: null }]);
  });

  /** 模拟 CLI 在当前回合发来 ExitPlanMode，并批准 */
  async function approvePlan(h: Harness, session: AgentSession): Promise<void> {
    const cli = h.clis.at(-1)!;
    const promise = canUseTool(cli, "ExitPlanMode", { plan: "p" }, { toolUseId: "tp" });
    const request = session.getPendingPermissions()[0]!;
    await session.respondToPermission(request.id, { behavior: "allow" });
    await promise;
  }

  /** 让 initialize 应答的 then 回调先执行 */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("跟随设置进入的 plan：批准后切回 initialize 报告的基础模式（含恢复会话）", async () => {
    const h = createHarness();
    h.setup((q) => {
      q.initialized = Promise.resolve({ current_permission_mode: "auto" });
    });
    const created = await h.client.createSession({ cwd: ".", modeId: "plan" });
    const createdEvents = collect(created);
    await created.startTurn("x");
    await flush();
    await approvePlan(h, created);
    expect(h.clis[0]!.calls.setPermissionMode).toEqual(["plan", "auto"]);
    expect(createdEvents.filter((e) => e.type === "mode_changed")).toEqual([{ type: "mode_changed", modeId: null }]);

    // 恢复会话：manager 按快照再 setMode("plan")，规则相同
    const resumed = await h.client.resumeSession({ provider: "claude", sessionId: SESSION_ID }, { cwd: "." });
    await resumed.setMode!("plan");
    await resumed.startTurn("y");
    await flush();
    expect(h.clis[1]!.options).toMatchObject({ permissionMode: null, resumeSessionId: SESSION_ID });
    await approvePlan(h, resumed);
    expect(h.clis[1]!.calls.setPermissionMode).toEqual(["plan", "auto"]);
  });

  test("会话中途从跟随设置切到 plan：批准后切回基础模式；基础模式为 plan 时退回 default", async () => {
    const h = createHarness();
    h.setup((q) => {
      q.initialized = Promise.resolve({ current_permission_mode: "acceptEdits" });
    });
    const session = await h.client.createSession({ cwd: "." });
    await session.startTurn("x");
    await flush();
    expect(h.clis[0]!.options.permissionMode).toBeNull();
    await session.setMode!("plan");
    await approvePlan(h, session);
    expect(h.clis[0]!.calls.setPermissionMode).toEqual(["plan", "acceptEdits"]);

    const h2 = createHarness();
    h2.setup((q) => {
      q.initialized = Promise.resolve({ current_permission_mode: "plan" });
    });
    const planByDefault = await h2.client.createSession({ cwd: "." });
    await planByDefault.startTurn("x");
    await flush();
    await planByDefault.setMode!("plan");
    await approvePlan(h2, planByDefault);
    expect(h2.clis[0]!.calls.setPermissionMode).toEqual(["plan", "default"]);
  });

  test("从显式模式进入 plan：批准后切回该模式，不使用 initialize 报告的模式", async () => {
    const h = createHarness();
    h.setup((q) => {
      q.initialized = Promise.resolve({ current_permission_mode: "acceptEdits" });
    });
    const session = await h.client.createSession({ cwd: ".", modeId: "auto" });
    const events = collect(session);
    await session.startTurn("x");
    await flush();
    expect(h.clis[0]!.options.permissionMode).toBe("auto");
    await session.setMode!("plan");
    await approvePlan(h, session);
    expect(h.clis[0]!.calls.setPermissionMode).toEqual(["plan", "auto"]);
    expect(events.flatMap((e) => (e.type === "mode_changed" ? [e.modeId] : []))).toEqual(["plan", "auto"]);
  });

  test("modeId 为 null（含恢复会话）时不传 --permission-mode；显式模式照常传", async () => {
    const h = createHarness();
    const session = await h.client.createSession({ cwd: "." });
    await session.startTurn("x");
    expect(h.clis[0]!.options.permissionMode).toBeNull();
    const resumed = await h.client.resumeSession({ provider: "claude", sessionId: SESSION_ID }, { cwd: "." });
    await resumed.startTurn("y");
    expect(h.clis[1]!.options.permissionMode).toBeNull();
    const manual = await h.client.createSession({ cwd: ".", modeId: "default" });
    await manual.startTurn("z");
    expect(h.clis[2]!.options.permissionMode).toBe("default");
  });

  test("abort signal 触发时自动 deny 并发 permission_resolved", async () => {
    const h = createHarness();
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("x");
    const controller = new AbortController();
    const promise = canUseTool(h.clis[0]!, "Bash", { command: "ls" }, {
      signal: controller.signal,
      toolUseId: "t",
    });
    controller.abort();
    await expect(promise).resolves.toMatchObject({ behavior: "deny" });
    expect(session.getPendingPermissions()).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "permission_resolved", response: { behavior: "deny" } });
  });

  test("interrupt：拒绝挂起权限、取消运行中工具、发 interrupt 控制请求、发 turn_canceled，忽略过期 result", async () => {
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
    const permission = canUseTool(h.clis[0]!, "Bash", { command: "sleep 100" }, { toolUseId: "toolu_s" });

    await session.interrupt();
    expect(h.clis[0]!.calls.interrupt).toBe(1);
    await expect(permission).resolves.toMatchObject({ behavior: "deny" });
    expect(toolCalls(events).at(-1)).toMatchObject({ callId: "toolu_s", status: "canceled" });
    expect(terminalEvents(events)).toEqual([{ type: "turn_canceled", turnId, reason: "interrupted" }]);
    await session.interrupt(); // 无进行中回合时为 no-op

    const second = await session.startTurn("next");
    await waitUntil(() => terminalEvents(events).length === 2);
    expect(terminalEvents(events)[1]).toMatchObject({ type: "turn_completed", turnId: second.turnId });
    expect(h.clis).toHaveLength(1);
  });

  test("interrupt 超时（3 秒）后结束 claude 进程，下一轮以 --resume 重建", async () => {
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
    expect(h.clis[0]!.calls.close).toBe(1);

    await session.startTurn("y");
    await waitUntil(() => terminalEvents(events).length === 2);
    expect(h.clis).toHaveLength(2);
    expect(h.clis[1]!.options.resumeSessionId).toBe(SESSION_ID);
  });

  test("claude 进程意外退出 → turn_failed，下一轮重建进程并 --resume", async () => {
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
    expect(h.clis[0]!.calls.close).toBeGreaterThanOrEqual(1);
    expect(h.clis[1]!.options.resumeSessionId).toBe(SESSION_ID);
  });

  test("setModel / setMode：无进程时记下并在启动时生效，有进程时发控制请求", async () => {
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
    // 跟随设置时进入的 plan：不带 --permission-mode 启动，再以控制请求切到 plan
    expect(h.clis[0]!.options).toMatchObject({ model: "opus", permissionMode: null });

    await session.setModel!("default");
    await session.setModel!("haiku");
    await session.setMode!("bypassPermissions");
    expect(h.clis[0]!.calls.setModel).toEqual([null, "haiku"]);
    expect(h.clis[0]!.calls.setPermissionMode).toEqual(["plan", "bypassPermissions"]);
  });

  test("思考强度：建会话时随启动参数下发；不合法档位抛错", async () => {
    const h = createHarness();
    h.setup((q) => (q.onUser = (user) => q.emit(msg.init(), msg.result(user.uuid))));
    await expect(h.client.createSession({ cwd: ".", thinkingOptionId: "turbo" })).rejects.toThrow(
      "Claude Code 不支持思考强度：turbo",
    );
    const session = await h.client.createSession({ cwd: ".", thinkingOptionId: "low" });
    const events = collect(session);
    await session.startTurn("x");
    await waitUntil(() => terminalEvents(events).length === 1);
    expect(h.clis[0]!.options.thinkingOptionId).toBe("low");
    await expect(session.setThinking!("turbo")).rejects.toThrow();
  });

  test("思考强度：中途切换标记重启，下一轮以 --resume 带新参数重新拉起；运行中切换返回提示", async () => {
    const h = createHarness();
    let created = 0;
    let release: (() => void) | null = null;
    h.setup((q) => {
      created += 1;
      q.onUser = (user) => {
        q.emit(msg.init());
        // 第一个进程的第二轮先挂起，便于测试「运行中切换」
        if (created === 1 && q.received.length === 2) {
          release = () => q.emit(msg.result(user.uuid));
          return;
        }
        q.emit(msg.result(user.uuid));
      };
    });
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);

    // 无进程时切换：只记下，首轮启动即生效，不重启
    expect(await session.setThinking!("high")).toEqual({});
    await session.startTurn("a");
    await waitUntil(() => terminalEvents(events).length === 1);
    expect(h.clis).toHaveLength(1);
    expect(h.clis[0]!.options).toMatchObject({ thinkingOptionId: "high", resumeSessionId: null });

    // 进程运行中、回合进行时切换：返回提示，本轮不受影响
    await session.startTurn("b");
    await waitUntil(() => release !== null);
    expect(await session.setThinking!("off")).toEqual({ notice: "思考强度将在下一轮生效" });
    expect(h.clis[0]!.calls.close).toBe(0);
    release!();
    await waitUntil(() => terminalEvents(events).length === 2);

    // 下一轮：结束旧进程，以 --resume 带新档位重启
    await session.startTurn("c");
    await waitUntil(() => terminalEvents(events).length === 3);
    expect(h.clis).toHaveLength(2);
    expect(h.clis[0]!.calls.close).toBeGreaterThanOrEqual(1);
    expect(h.clis[1]!.options).toMatchObject({ thinkingOptionId: "off", resumeSessionId: SESSION_ID });
    expect(terminalEvents(events).map((e) => e.type)).toEqual([
      "turn_completed",
      "turn_completed",
      "turn_completed",
    ]);

    // 切回跟随设置（null）同样重启，且不再带参数；档位不变时不重启
    await session.setThinking!(null);
    await session.startTurn("d");
    await waitUntil(() => terminalEvents(events).length === 4);
    expect(h.clis).toHaveLength(3);
    expect(h.clis[2]!.options.thinkingOptionId).toBeNull();
    await session.setThinking!(null);
    await session.startTurn("e");
    await waitUntil(() => terminalEvents(events).length === 5);
    expect(h.clis).toHaveLength(3);
    expect(events.filter((e) => e.type === "thinking_option_changed")).toEqual([
      { type: "thinking_option_changed", thinkingOptionId: "high" },
      { type: "thinking_option_changed", thinkingOptionId: "off" },
      { type: "thinking_option_changed", thinkingOptionId: null },
      { type: "thinking_option_changed", thinkingOptionId: null },
    ]);
  });

  test("resumeSession：立即可描述持久化句柄，并以 --resume 启动", async () => {
    const h = createHarness();
    h.setup((q) => (q.onUser = replyText("继续")));
    const session = await h.client.resumeSession({ provider: "claude", sessionId: SESSION_ID }, { cwd: "." });
    expect(session.id).toBe(SESSION_ID);
    expect(session.describePersistence()).toEqual({ provider: "claude", sessionId: SESSION_ID });
    const events = collect(session);
    await session.startTurn("x");
    await waitUntil(() => terminalEvents(events).length === 1);
    expect(h.clis[0]!.options.resumeSessionId).toBe(SESSION_ID);
    expect(h.clis[0]!.received[0]!.session_id).toBe(SESSION_ID);
    expect(events.filter((e) => e.type === "thread_started")).toHaveLength(1);
  });

  test("close：关闭 claude 进程、取消回合，之后不可再用", async () => {
    const h = createHarness();
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    const { turnId } = await session.startTurn("x");
    expect(h.clis).toHaveLength(1);

    await session.close();
    expect(terminalEvents(events)).toEqual([{ type: "turn_canceled", turnId, reason: "closed" }]);
    expect(h.clis[0]!.calls.close).toBe(1);
    await expect(session.startTurn("again")).rejects.toThrow("已关闭");
    await session.close(); // 幂等
    expect(h.clis[0]!.calls.close).toBe(1);
  });
});
