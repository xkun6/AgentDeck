import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  AgentBackgroundTask,
  AgentModelDefinition,
  AgentStreamEvent,
  ToolCallTimelineItem,
} from "@agentdeck/protocol";
import { describe, expect, test, vi } from "vitest";

import type { AgentSession } from "../../../src/agent/types.js";
import { createSilentLogger } from "../../../src/logger.js";
import {
  ClaudeAgentClient,
  type ClaudeCliFactory,
  type ClaudeCliHandle,
  type ClaudeCliOptions,
} from "../../../src/providers/claude/index.js";
import type {
  ClaudeContextUsageResponse,
  ClaudeInitializeResponse,
  ClaudeMcpStatusResponse,
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
    mcpStatus: 0,
    mcpReconnect: [] as string[],
    stopTask: [] as string[],
    getContextUsage: 0,
    close: 0,
  };
  mcpStatusResponse: ClaudeMcpStatusResponse = {};
  contextUsageImpl: () => Promise<ClaudeContextUsageResponse> = async () => ({});
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

  async mcpStatus(): Promise<ClaudeMcpStatusResponse> {
    this.calls.mcpStatus += 1;
    return this.mcpStatusResponse;
  }

  async mcpReconnect(serverName: string): Promise<void> {
    this.calls.mcpReconnect.push(serverName);
  }

  async stopTask(taskId: string): Promise<void> {
    this.calls.stopTask.push(taskId);
  }

  async getContextUsage(): Promise<ClaudeContextUsageResponse> {
    this.calls.getContextUsage += 1;
    return this.contextUsageImpl();
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
  ctx: {
    signal?: AbortSignal;
    toolUseId?: string;
    title?: string;
    suggestions?: unknown;
    suppressAlwaysAllowRule?: boolean;
    defaultToNo?: boolean;
    blockedPath?: string;
  } = {},
): Promise<ClaudePermissionResult> {
  return cli.options.canUseTool(toolName, input, {
    signal: ctx.signal ?? new AbortController().signal,
    ...(ctx.toolUseId ? { toolUseId: ctx.toolUseId } : {}),
    ...(ctx.title ? { title: ctx.title } : {}),
    ...(ctx.suggestions !== undefined ? { suggestions: ctx.suggestions } : {}),
    ...(ctx.suppressAlwaysAllowRule ? { suppressAlwaysAllowRule: true } : {}),
    ...(ctx.defaultToNo ? { defaultToNo: true } : {}),
    ...(ctx.blockedPath ? { blockedPath: ctx.blockedPath } : {}),
  });
}

function collect(session: AgentSession): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => {
    if (event.type !== "provider_subagent" && event.type !== "provider_background_tasks") events.push(event);
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

  test("message_start 发出只带上下文字段的 usage_updated；上限未知时 get_context_usage 补发并缓存，result 后缓存 max 不再请求", async () => {
    const h = createHarness();
    h.setup((q) => {
      q.onUser = replyText("你好世界");
      q.contextUsageImpl = async () => ({ totalTokens: 12_000, maxTokens: 1_000_000, rawMaxTokens: 1_000_000 });
    });
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("hi");
    await waitUntil(() => terminalEvents(events).length === 1);

    const usages = events.flatMap((e) => (e.type === "usage_updated" ? [e.usage] : []));
    // 第一次：只有已用；随后补发上限；最后是 result 的完整 usage
    expect(usages[0]).toEqual({ contextWindowUsedTokens: 100 });
    expect(usages[1]).toEqual({ contextWindowUsedTokens: 100, contextWindowMaxTokens: 1_000_000 });
    expect(usages.at(-1)).toMatchObject({ inputTokens: 100, contextWindowMaxTokens: 200000 });
    expect(usages[0]).not.toHaveProperty("inputTokens");
    const requestsBefore = h.clis[0]!.calls.getContextUsage;

    // result 记下 max 后，下一轮 message_start 直接带上限，不再发控制请求
    await session.startTurn("again");
    await waitUntil(() => terminalEvents(events).length === 2);
    const second = events.flatMap((e) => (e.type === "usage_updated" ? [e.usage] : [])).slice(usages.length);
    expect(second[0]).toEqual({ contextWindowUsedTokens: 100, contextWindowMaxTokens: 200000 });
    expect(h.clis[0]!.calls.getContextUsage).toBe(requestsBefore);
  });

  test("get_context_usage 失败被忽略且不重试；切换模型后清掉缓存的 max", async () => {
    const h = createHarness();
    h.setup((q) => {
      q.onUser = replyText("好的");
      q.contextUsageImpl = async () => {
        throw new Error("不支持");
      };
    });
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("hi");
    await waitUntil(() => terminalEvents(events).length === 1);
    expect(events.filter((e) => e.type === "turn_failed")).toHaveLength(0);
    const requests = h.clis[0]!.calls.getContextUsage;
    expect(requests).toBeGreaterThan(0);
    // result 缓存了 max；切换模型后清掉，下一轮 message_start 重新没有上限，并重新请求
    h.clis[0]!.contextUsageImpl = async () => ({ maxTokens: 500_000 });
    await session.setModel!("claude-opus-4-5");
    await session.startTurn("again");
    await waitUntil(() => terminalEvents(events).length === 2);
    expect(h.clis[0]!.calls.getContextUsage).toBeGreaterThan(requests);
    const usages = events.flatMap((e) => (e.type === "usage_updated" ? [e.usage] : []));
    expect(usages).toContainEqual({ contextWindowUsedTokens: 100, contextWindowMaxTokens: 500_000 });
  });

  test("initialize 完成后调一次 get_context_usage，用 totalTokens 作为已用（恢复的会话第一轮之前就有用量）", async () => {
    const h = createHarness();
    h.setup((q) => {
      q.contextUsageImpl = async () => ({ totalTokens: 34_000, maxTokens: 200_000 });
    });
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("hi");
    await waitUntil(() => events.some((e) => e.type === "usage_updated"));
    expect(events.find((e) => e.type === "usage_updated")).toEqual({
      type: "usage_updated",
      usage: { contextWindowUsedTokens: 34_000, contextWindowMaxTokens: 200_000 },
    });
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
      "usage_updated", // message_start 的回合中上下文用量（design.md 4.13）
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

  test("model 为 <synthetic> 的 assistant 文本标记 source:command，普通消息不带", async () => {
    const h = createHarness();
    h.setup(
      (q) =>
        (q.onUser = (user) => {
          q.emit(
            msg.init(),
            {
              ...msg.assistant("m-syn", [{ type: "text", text: "第一行\n第二行" }]),
              message: {
                id: "m-syn",
                role: "assistant",
                model: "<synthetic>",
                content: [{ type: "text", text: "第一行\n第二行" }],
              },
            },
            msg.assistant("m-real", [{ type: "text", text: "普通回复" }]),
            msg.result(user.uuid),
          );
        }),
    );
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("/usage");
    await waitUntil(() => terminalEvents(events).length === 1);
    const items = events.flatMap((e) => (e.type === "timeline" ? [e.item] : []));
    expect(items).toEqual([
      { type: "assistant_message", text: "第一行\n第二行", messageId: "m-syn", source: "command" },
      { type: "assistant_message", text: "普通回复", messageId: "m-real" },
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

  describe("新版 Task 工具 → todo", () => {
    const todosOf = (events: AgentStreamEvent[]) =>
      events.flatMap((e) => (e.type === "timeline" && e.item.type === "todo" ? [e.item.items] : []));
    const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
    const created = (n: number, subject: string) => ({ task: { id: String(n), subject } });
    const updated = (n: number, to: string) => ({
      success: true,
      taskId: String(n),
      updatedFields: ["status"],
      statusChange: { from: "pending", to },
    });

    async function runTurn(script: (q: FakeCli, user: ClaudeUserInput) => void) {
      const h = createHarness();
      h.setup((q) => (q.onUser = (user) => script(q, user)));
      const session = await h.client.createSession({ cwd: "." });
      const events = collect(session);
      await session.startTurn("run");
      await waitUntil(() => terminalEvents(events).length === 1);
      return events;
    }

    test("创建 3 个任务并逐个完成（实测格式），不发 tool_call", async () => {
      const events = await runTurn((q, user) => {
        q.emit(msg.init());
        for (const [n, subject] of [[1, "步骤一"], [2, "步骤二"], [3, "步骤三"]] as const) {
          q.emit(
            msg.assistant(`mc${n}`, [use(`toolu_c${n}`, "TaskCreate", { subject, description: "d", activeForm: "做中" })]),
            msg.toolResult(`toolu_c${n}`, `Task #${n} created successfully: ${subject}`, {
              structured: created(n, subject),
            }),
          );
        }
        for (const n of [1, 2, 3]) {
          q.emit(
            msg.assistant(`mu${n}`, [use(`toolu_u${n}`, "TaskUpdate", { taskId: String(n), status: "completed" })]),
            msg.toolResult(`toolu_u${n}`, `Updated task #${n} status`, { structured: updated(n, "completed") }),
          );
        }
        q.emit(
          msg.assistant("ml", [use("toolu_l", "TaskList", {})]),
          msg.toolResult("toolu_l", "#1 [completed] 步骤一\n#2 [completed] 步骤二\n#3 [completed] 步骤三", {
            structured: {
              tasks: [1, 2, 3].map((n) => ({ id: String(n), subject: `步骤${"一二三"[n - 1]}`, status: "completed", blockedBy: [] })),
            },
          }),
          msg.result(user.uuid),
        );
      });
      expect(toolCalls(events)).toEqual([]);
      expect(todosOf(events)).toEqual([
        [{ text: "步骤一", completed: false }],
        [{ text: "步骤一", completed: false }, { text: "步骤二", completed: false }],
        [
          { text: "步骤一", completed: false },
          { text: "步骤二", completed: false },
          { text: "步骤三", completed: false },
        ],
        [
          { text: "步骤一", completed: true },
          { text: "步骤二", completed: false },
          { text: "步骤三", completed: false },
        ],
        [
          { text: "步骤一", completed: true },
          { text: "步骤二", completed: true },
          { text: "步骤三", completed: false },
        ],
        [
          { text: "步骤一", completed: true },
          { text: "步骤二", completed: true },
          { text: "步骤三", completed: true },
        ],
        // TaskList 与现有任务表一致，不重复发
      ]);
    });

    test("TaskUpdate 改标题、in_progress 仍为未完成、deleted 移除；失败结果与未知 id 忽略", async () => {
      const events = await runTurn((q, user) => {
        q.emit(
          msg.init(),
          msg.assistant("m1", [use("c1", "TaskCreate", { subject: "甲" }), use("c2", "TaskCreate", { subject: "乙" })]),
          msg.toolResult("c1", "Task #1 created successfully: 甲", { structured: created(1, "甲") }),
          msg.toolResult("c2", "Task #2 created successfully: 乙", { structured: created(2, "乙") }),
          msg.assistant("m2", [use("u1", "TaskUpdate", { taskId: "1", subject: "甲（改）", status: "in_progress" })]),
          msg.toolResult("u1", "Updated task #1 subject, status"),
          msg.assistant("m3", [use("u2", "TaskUpdate", { taskId: "2", status: "completed" })]),
          msg.toolResult("u2", "denied", { isError: true }),
          msg.assistant("m4", [use("u3", "TaskUpdate", { taskId: "99", status: "completed" })]),
          msg.toolResult("u3", "Updated task #99 status"),
          msg.assistant("m5", [use("u4", "TaskUpdate", { taskId: "1", status: "deleted" })]),
          msg.toolResult("u4", "Updated task #1 status", { structured: updated(1, "deleted") }),
          msg.result(user.uuid),
        );
      });
      expect(toolCalls(events)).toEqual([]);
      expect(todosOf(events)).toEqual([
        [{ text: "甲", completed: false }],
        [{ text: "甲", completed: false }, { text: "乙", completed: false }],
        [{ text: "甲（改）", completed: false }, { text: "乙", completed: false }],
        [{ text: "乙", completed: false }],
      ]);
    });

    test("TaskList 整表同步（含文本退化解析、deleted 过滤、清空）", async () => {
      const events = await runTurn((q, user) => {
        q.emit(
          msg.init(),
          msg.assistant("m1", [use("c1", "TaskCreate", { subject: "旧任务" })]),
          msg.toolResult("c1", "Task #1 created successfully: 旧任务", { structured: created(1, "旧任务") }),
          // 结构化结果：整表替换，deleted 被过滤
          msg.assistant("m2", [use("l1", "TaskList", {})]),
          msg.toolResult("l1", "...", {
            structured: {
              tasks: [
                { id: "2", subject: "乙", status: "in_progress", blockedBy: [] },
                { id: "3", subject: "丙", status: "completed", blockedBy: ["2"] },
                { id: "4", subject: "丁", status: "deleted", blockedBy: [] },
              ],
            },
          }),
          // 没有结构化结果（同一条消息多个 tool_result 时）：解析文本行
          msg.assistant("m3", [use("l2", "TaskList", {}), use("t1", "Read", { file_path: "a.txt" })]),
          {
            ...msg.toolResult("l2", "#2 [completed] 乙\n#3 [completed] 丙", {}),
            message: {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "l2", content: "#2 [completed] 乙\n#3 [completed] 丙" },
                { type: "tool_result", tool_use_id: "t1", content: "x" },
              ],
            },
            tool_use_result: { ignored: true },
          },
          msg.assistant("m4", [use("l3", "TaskList", {})]),
          msg.toolResult("l3", "No tasks found", { structured: { tasks: [] } }),
          msg.result(user.uuid),
        );
      });
      expect(todosOf(events)).toEqual([
        [{ text: "旧任务", completed: false }],
        [{ text: "乙", completed: false }, { text: "丙", completed: true }],
        [{ text: "乙", completed: true }, { text: "丙", completed: true }],
        [],
      ]);
      expect(toolCalls(events).map((c) => c.callId)).toEqual(["t1", "t1"]);
    });

    test("结果里拿不到 id：先按文本、再按顺序临时编号，TaskUpdate 仍能命中", async () => {
      const events = await runTurn((q, user) => {
        q.emit(
          msg.init(),
          msg.assistant("m1", [use("c1", "TaskCreate", { subject: "甲" })]),
          msg.toolResult("c1", "Task #7 created successfully: 甲"),
          msg.assistant("m2", [use("c2", "TaskCreate", { subject: "乙" })]),
          msg.toolResult("c2", "created"),
          msg.assistant("m3", [use("u1", "TaskUpdate", { taskId: "8", status: "completed" })]),
          msg.toolResult("u1", "Updated task #8 status"),
          msg.result(user.uuid),
        );
      });
      expect(todosOf(events)).toEqual([
        [{ text: "甲", completed: false }],
        [{ text: "甲", completed: false }, { text: "乙", completed: false }],
        [{ text: "甲", completed: false }, { text: "乙", completed: true }],
      ]);
    });

    test("子代理里的 Task 工具调用不进主时间线 todo", async () => {
      const events = await runTurn((q, user) => {
        q.emit(
          msg.init(),
          msg.assistant("m1", [use("c1", "TaskCreate", { subject: "主任务" })]),
          msg.toolResult("c1", "Task #1 created successfully: 主任务", { structured: created(1, "主任务") }),
          msg.assistant("m2", [use("toolu_agent", "Agent", { description: "子活", prompt: "p", subagent_type: "general-purpose" })]),
          msg.assistant("s1", [use("sc1", "TaskCreate", { subject: "子任务" })], "toolu_agent"),
          {
            ...msg.toolResult("sc1", "Task #1 created successfully: 子任务", { structured: created(1, "子任务") }),
            parent_tool_use_id: "toolu_agent",
          },
          msg.assistant("s2", [use("su1", "TaskUpdate", { taskId: "1", status: "completed" })], "toolu_agent"),
          { ...msg.toolResult("su1", "Updated task #1 status", { structured: updated(1, "completed") }), parent_tool_use_id: "toolu_agent" },
          msg.toolResult("toolu_agent", "done"),
          msg.result(user.uuid),
        );
      });
      expect(todosOf(events)).toEqual([[{ text: "主任务", completed: false }]]);
      expect(toolCalls(events).filter((c) => c.name === "TaskCreate" || c.name === "TaskUpdate")).toEqual([]);
    });
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
    // 找不到（例如另一端刚处理完）：业务错误码 PERMISSION_NOT_FOUND，前端据此提示「已在其他设备处理」
    await expect(session.respondToPermission("nope", { behavior: "deny" })).rejects.toMatchObject({
      code: "PERMISSION_NOT_FOUND",
    });
    await expect(session.respondToPermission(third.id, { behavior: "deny" })).rejects.toMatchObject({
      code: "PERMISSION_NOT_FOUND",
    });
  });

  describe("始终允许（permission_suggestions）", () => {
    const BASH_SUGGESTIONS = [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "git status" }],
        behavior: "allow",
        destination: "localSettings",
      },
    ];

    async function openPermission(
      toolName: string,
      input: Record<string, unknown>,
      ctx: Parameters<typeof canUseTool>[3],
    ) {
      const h = createHarness();
      const session = await h.client.createSession({ cwd: "." });
      const events = collect(session);
      await session.startTurn("x");
      const promise = canUseTool(h.clis[0]!, toolName, input, { toolUseId: "toolu_a", ...ctx });
      const request = session.getPendingPermissions()[0]!;
      return { h, session, events, promise, request };
    }

    test("有建议时追加 allow_session / allow_project，原始建议不进协议", async () => {
      const { request, events } = await openPermission("Bash", { command: "git status" }, { suggestions: BASH_SUGGESTIONS });
      expect(request.actions).toEqual([
        { id: "allow", label: "允许一次", behavior: "allow" },
        { id: "deny", label: "拒绝", behavior: "deny" },
        {
          id: "allow_session",
          label: "本会话始终允许",
          behavior: "allow",
          persist: "session",
          description: "仅本会话有效，不写入文件：Bash(git status)",
        },
        {
          id: "allow_project",
          label: "永久允许",
          behavior: "allow",
          persist: "permanent",
          description: "写入项目的 .claude/settings.local.json：Bash(git status)",
        },
      ]);
      expect(request.defaultDeny).toBeUndefined();
      expect(JSON.stringify(events)).not.toContain("permission_suggestions");
      expect(JSON.stringify(events)).not.toContain("destination");
    });

    test("allow_session 把建议的 destination 改写成 session 回传", async () => {
      const { session, promise, request } = await openPermission(
        "Bash",
        { command: "git status" },
        { suggestions: BASH_SUGGESTIONS },
      );
      await session.respondToPermission(request.id, { behavior: "allow", selectedActionId: "allow_session" });
      await expect(promise).resolves.toEqual({
        behavior: "allow",
        updatedInput: { command: "git status" },
        updatedPermissions: [
          {
            type: "addRules",
            rules: [{ toolName: "Bash", ruleContent: "git status" }],
            behavior: "allow",
            destination: "session",
          },
        ],
      });
    });

    test("allow_project 把规则 / 目录改写成 localSettings，setMode 保持 session", async () => {
      const { session, promise, request } = await openPermission(
        "Edit",
        { file_path: "a.txt" },
        {
          suggestions: [
            { type: "addRules", rules: [{ toolName: "Edit" }], behavior: "allow", destination: "session" },
            { type: "addDirectories", directories: ["C:/work"], destination: "session" },
            { type: "setMode", mode: "acceptEdits", destination: "session" },
          ],
        },
      );
      await session.respondToPermission(request.id, { behavior: "allow", selectedActionId: "allow_project" });
      await expect(promise).resolves.toMatchObject({
        behavior: "allow",
        updatedPermissions: [
          { type: "addRules", rules: [{ toolName: "Edit" }], destination: "localSettings" },
          { type: "addDirectories", directories: ["C:/work"], destination: "localSettings" },
          { type: "setMode", mode: "acceptEdits", destination: "session" },
        ],
      });
    });

    test("普通「允许一次」不带 updatedPermissions", async () => {
      const { session, promise, request } = await openPermission(
        "Bash",
        { command: "git status" },
        { suggestions: BASH_SUGGESTIONS },
      );
      await session.respondToPermission(request.id, { behavior: "allow", selectedActionId: "allow" });
      await expect(promise).resolves.toEqual({ behavior: "allow", updatedInput: { command: "git status" } });
    });

    test("suppress_always_allow_rule 为 true 时不显示任何始终允许入口", async () => {
      const { request } = await openPermission(
        "Bash",
        { command: "rm x" },
        { suggestions: BASH_SUGGESTIONS, suppressAlwaysAllowRule: true },
      );
      expect(request.actions?.map((a) => a.id)).toEqual(["allow", "deny"]);
    });

    test("default_to_no 为 true 时请求带 defaultDeny", async () => {
      const { request } = await openPermission("Bash", { command: "rm x" }, { defaultToNo: true });
      expect(request.defaultDeny).toBe(true);
    });

    test("受限路径补充到说明里", async () => {
      const { request } = await openPermission(
        "Read",
        { file_path: "D:/other/a.txt" },
        { blockedPath: "D:/other" },
      );
      expect(request.description).toBe("受限路径：D:/other");
    });

    test("仅 setMode 的建议只有本会话档，bypassPermissions 不进永久档，非允许规则被丢弃", async () => {
      const onlyMode = await openPermission(
        "Edit",
        { file_path: "a.txt" },
        { suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] },
      );
      expect(onlyMode.request.actions?.map((a) => a.id)).toEqual(["allow", "deny", "allow_session"]);
      expect(onlyMode.request.actions?.[2]?.description).toBe(
        "仅本会话有效，不写入文件：切换为「自动接受编辑」模式",
      );

      const bypass = await openPermission(
        "Bash",
        { command: "x" },
        {
          suggestions: [
            { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "x" }], behavior: "allow", destination: "session" },
            { type: "setMode", mode: "bypassPermissions", destination: "session" },
            { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "deny", destination: "session" },
            { type: "replaceRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" },
          ],
        },
      );
      await bypass.session.respondToPermission(bypass.request.id, {
        behavior: "allow",
        selectedActionId: "allow_project",
      });
      const result = await bypass.promise;
      expect(result).toMatchObject({ updatedPermissions: [{ type: "addRules", destination: "localSettings" }] });
      expect(result.behavior === "allow" ? result.updatedPermissions : []).toHaveLength(1);
    });

    test("ExitPlanMode / AskUserQuestion 不提供始终允许", async () => {
      const plan = await openPermission("ExitPlanMode", { plan: "p" }, { suggestions: BASH_SUGGESTIONS });
      expect(plan.request.actions?.map((a) => a.id)).toEqual(["approve", "keep_planning"]);
      const ask = await openPermission("AskUserQuestion", { questions: [] }, { suggestions: BASH_SUGGESTIONS });
      expect(ask.request.actions?.map((a) => a.id)).toEqual(["allow", "deny"]);
    });

    test("回传 setMode 后同步本地 mode 并发 mode_changed（不重复调用 set_permission_mode）", async () => {
      const { h, session, events, promise, request } = await openPermission(
        "Edit",
        { file_path: "a.txt" },
        {
          suggestions: [
            { type: "addRules", rules: [{ toolName: "Edit" }], behavior: "allow", destination: "session" },
            { type: "setMode", mode: "acceptEdits", destination: "session" },
          ],
        },
      );
      await session.respondToPermission(request.id, { behavior: "allow", selectedActionId: "allow_session" });
      await promise;
      expect(events.at(-1)).toEqual({ type: "mode_changed", modeId: "acceptEdits" });
      expect(h.clis[0]!.calls.setPermissionMode).toEqual([]);
    });
  });

  describe("MCP elicitation", () => {
    function elicit(cli: FakeCli, ctx: Partial<Parameters<NonNullable<ClaudeCliOptions["onElicitation"]>>[0]> = {}) {
      return cli.options.onElicitation!({
        signal: new AbortController().signal,
        mode: "form",
        mcpServerName: "forms",
        message: "请填写表单",
        ...ctx,
      });
    }

    const SCHEMA = {
      type: "object",
      properties: {
        name: { type: "string", title: "姓名" },
        age: { type: "integer", minimum: 1, maximum: 120 },
        tags: { type: "array", items: { enum: ["a", "b"] } },
      },
      required: ["name"],
    };

    async function openElicitation(ctx: Parameters<typeof elicit>[1]) {
      const h = createHarness();
      const session = await h.client.createSession({ cwd: "." });
      const events = collect(session);
      await session.startTurn("x");
      const promise = elicit(h.clis[0]!, ctx);
      const request = session.getPendingPermissions()[0]!;
      return { h, session, events, promise, request };
    }

    test("form：变成 kind elicitation 的审批，fields 按 property_order 归一化，actions 为 提交 / 拒绝 / 取消", async () => {
      const { events, request } = await openElicitation({
        requestedSchema: SCHEMA,
        propertyOrder: ["age", "name", "tags"],
        title: "填写资料",
      });
      expect(request).toMatchObject({
        provider: "claude",
        name: "mcp:forms",
        kind: "elicitation",
        title: "填写资料",
        input: { serverName: "forms", mode: "form", message: "请填写表单" },
        detail: {
          type: "elicitation",
          serverName: "forms",
          mode: "form",
          message: "请填写表单",
          fields: [
            { key: "age", required: false, type: "integer", min: 1, max: 120 },
            { key: "name", title: "姓名", required: true, type: "string" },
            { key: "tags", required: false, type: "multiselect", options: [{ value: "a", label: "a" }, { value: "b", label: "b" }] },
          ],
        },
        actions: [
          { id: "submit", label: "提交", behavior: "allow" },
          { id: "decline", label: "拒绝", behavior: "deny" },
          { id: "cancel", label: "取消", behavior: "deny" },
        ],
      });
      expect(events.find((e) => e.type === "permission_requested")).toMatchObject({
        turnId: expect.any(String),
        request: { id: request.id },
      });
    });

    test("form：提交 → accept + content；拒绝 → decline；取消 → cancel 并中断回合", async () => {
      const accept = await openElicitation({ requestedSchema: SCHEMA });
      await accept.session.respondToPermission(accept.request.id, {
        behavior: "allow",
        selectedActionId: "submit",
        updatedInput: { content: { name: "小明", age: 3 } },
      });
      await expect(accept.promise).resolves.toEqual({ action: "accept", content: { name: "小明", age: 3 } });
      // 表单内容不进 permission_resolved（该事件会广播并落盘）
      expect(accept.events.at(-1)).toEqual({
        type: "permission_resolved",
        requestId: accept.request.id,
        response: { behavior: "allow", selectedActionId: "submit" },
      });

      const noContent = await openElicitation({ requestedSchema: SCHEMA });
      await noContent.session.respondToPermission(noContent.request.id, { behavior: "allow" });
      await expect(noContent.promise).resolves.toEqual({ action: "accept", content: {} });

      const decline = await openElicitation({ requestedSchema: SCHEMA });
      await decline.session.respondToPermission(decline.request.id, { behavior: "deny", selectedActionId: "decline" });
      await expect(decline.promise).resolves.toEqual({ action: "decline" });
      expect(decline.h.clis[0]!.calls.interrupt).toBe(0);

      const cancel = await openElicitation({ requestedSchema: SCHEMA });
      await cancel.session.respondToPermission(cancel.request.id, {
        behavior: "deny",
        selectedActionId: "cancel",
        interrupt: true,
      });
      await expect(cancel.promise).resolves.toEqual({ action: "cancel" });
      expect(cancel.h.clis[0]!.calls.interrupt).toBe(1);
      expect(cancel.events.at(-1)).toMatchObject({ type: "turn_canceled", reason: "interrupted" });
    });

    test("url：actions 为 已完成 / 拒绝 / 取消，已完成回 accept 且不带 content；detail 带 url 与 elicitationId", async () => {
      const { session, promise, request } = await openElicitation({
        mode: "url",
        mcpServerName: "oauth",
        message: "请在浏览器里授权",
        url: "https://example.com/auth",
        elicitationId: "elic-1",
      });
      expect(request).toMatchObject({
        kind: "elicitation",
        title: "oauth 需要你在浏览器中完成操作",
        detail: {
          type: "elicitation",
          mode: "url",
          url: "https://example.com/auth",
          elicitationId: "elic-1",
        },
        actions: [
          { id: "done", label: "已完成", behavior: "allow" },
          { id: "decline", label: "拒绝", behavior: "deny" },
          { id: "cancel", label: "取消", behavior: "deny" },
        ],
      });
      expect((request.detail as { fields?: unknown }).fields).toBeUndefined();
      await session.respondToPermission(request.id, {
        behavior: "allow",
        selectedActionId: "done",
        updatedInput: { content: { ignored: true } },
      });
      await expect(promise).resolves.toEqual({ action: "accept" });
    });

    test("system elicitation_complete：对应的 url 请求发 permission_resolved 并回 accept，其它 id 不受影响", async () => {
      const { h, session, events, promise, request } = await openElicitation({
        mode: "url",
        mcpServerName: "oauth",
        message: "授权",
        url: "https://example.com/auth",
        elicitationId: "elic-1",
      });
      h.clis[0]!.emit({ type: "system", subtype: "elicitation_complete", mcp_server_name: "oauth", elicitation_id: "other" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(session.getPendingPermissions()).toHaveLength(1);

      h.clis[0]!.emit({ type: "system", subtype: "elicitation_complete", mcp_server_name: "oauth", elicitation_id: "elic-1" });
      await expect(promise).resolves.toEqual({ action: "accept" });
      expect(session.getPendingPermissions()).toHaveLength(0);
      expect(events.at(-1)).toEqual({
        type: "permission_resolved",
        requestId: request.id,
        response: { behavior: "allow", selectedActionId: "done" },
      });
      await expect(session.respondToPermission(request.id, { behavior: "allow" })).rejects.toMatchObject({
        code: "PERMISSION_NOT_FOUND",
      });
    });

    test("CLI 撤回（abort）→ cancel + permission_resolved；回合取消时挂起的表单也回 cancel", async () => {
      const h = createHarness();
      const session = await h.client.createSession({ cwd: "." });
      const events = collect(session);
      await session.startTurn("x");

      const controller = new AbortController();
      const promise = elicit(h.clis[0]!, { signal: controller.signal });
      expect(session.getPendingPermissions()).toHaveLength(1);
      controller.abort();
      await expect(promise).resolves.toEqual({ action: "cancel" });
      expect(session.getPendingPermissions()).toHaveLength(0);
      expect(events.at(-1)).toMatchObject({ type: "permission_resolved", response: { behavior: "deny" } });

      const pending = elicit(h.clis[0]!);
      await session.interrupt();
      await expect(pending).resolves.toEqual({ action: "cancel" });
    });

    test("会话已关闭 / 没有进行中的回合时直接回 cancel，不产生审批", async () => {
      const h = createHarness();
      const session = await h.client.createSession({ cwd: "." });
      await session.startTurn("x");
      const cli = h.clis[0]!;
      await session.close();
      await expect(elicit(cli)).resolves.toEqual({ action: "cancel" });
      expect(session.getPendingPermissions()).toHaveLength(0);
    });
  });

  test("拒绝 / 继续规划附带的理由（message）原样作为 deny.message 回给 Claude", async () => {
    const h = createHarness();
    const session = await h.client.createSession({ cwd: "." });
    await session.startTurn("x");
    const cli = h.clis[0]!;
    const toolPromise = canUseTool(cli, "Bash", { command: "rm -rf /" }, { toolUseId: "t-reason" });
    const tool = session.getPendingPermissions()[0]!;
    await session.respondToPermission(tool.id, { behavior: "deny", selectedActionId: "deny", message: "别动根目录" });
    await expect(toolPromise).resolves.toEqual({ behavior: "deny", message: "别动根目录" });

    const planPromise = canUseTool(cli, "ExitPlanMode", { plan: "1. 改代码" }, { toolUseId: "t-plan-reason" });
    const plan = session.getPendingPermissions()[0]!;
    await session.respondToPermission(plan.id, {
      behavior: "deny",
      selectedActionId: "keep_planning",
      message: "先补测试",
    });
    await expect(planPromise).resolves.toEqual({ behavior: "deny", message: "先补测试" });
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

  const QUESTION_INPUT = {
    questions: [
      {
        question: "用哪个日期库？",
        header: "库",
        multiSelect: false,
        options: [
          { label: "dayjs", description: "轻量" },
          { label: "luxon", description: "功能全", preview: "import { DateTime } from 'luxon'" },
        ],
      },
      {
        question: "启用哪些功能？",
        header: "功能",
        multiSelect: true,
        options: [
          { label: "缓存", description: "加快构建" },
          { label: "日志", description: "" },
          { description: "缺 label 的选项被跳过" },
        ],
      },
      { header: "缺 question 的题目被跳过", options: [] },
    ],
  };
  const PARSED_QUESTIONS = [
    {
      question: "用哪个日期库？",
      header: "库",
      multiSelect: false,
      options: [
        { label: "dayjs", description: "轻量" },
        { label: "luxon", description: "功能全", preview: "import { DateTime } from 'luxon'" },
      ],
    },
    {
      question: "启用哪些功能？",
      header: "功能",
      multiSelect: true,
      options: [{ label: "缓存", description: "加快构建" }, { label: "日志" }],
    },
  ];

  test("AskUserQuestion：question 审批，回答随 updatedInput 回传，完成的工具卡片带 answers", async () => {
    const h = createHarness();
    h.setup(
      (q) =>
        (q.onUser = () => {
          q.emit(
            msg.init(),
            msg.assistant("m1", [
              { type: "tool_use", id: "toolu_q", name: "AskUserQuestion", input: QUESTION_INPUT },
            ]),
          );
        }),
    );
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("问我");
    await waitUntil(() => toolCalls(events).length === 1);
    expect(toolCalls(events)[0]).toEqual({
      type: "tool_call",
      callId: "toolu_q",
      name: "AskUserQuestion",
      status: "running",
      error: null,
      detail: { type: "question", questions: PARSED_QUESTIONS },
    });

    const cli = h.clis[0]!;
    const promise = canUseTool(cli, "AskUserQuestion", QUESTION_INPUT, { toolUseId: "toolu_q" });
    const requested = events.find((e) => e.type === "permission_requested");
    if (requested?.type !== "permission_requested") throw new Error("缺少 permission_requested");
    expect(requested.request).toMatchObject({
      name: "AskUserQuestion",
      kind: "question",
      title: "Claude 有问题需要你回答",
      input: QUESTION_INPUT,
      detail: { type: "question", questions: PARSED_QUESTIONS },
      actions: [
        { id: "submit", label: "提交回答", behavior: "allow" },
        { id: "skip", label: "跳过", behavior: "deny" },
      ],
    });

    const answers = { "用哪个日期库？": "luxon", "启用哪些功能？": "缓存, 自定义说明" };
    // 前端只回传 answers 时也要保证 questions 原样透传
    await session.respondToPermission(requested.request.id, {
      behavior: "allow",
      selectedActionId: "submit",
      updatedInput: { answers },
    });
    await expect(promise).resolves.toEqual({
      behavior: "allow",
      updatedInput: { ...QUESTION_INPUT, answers },
    } satisfies ClaudePermissionResult);

    cli.emit(
      msg.toolResult("toolu_q", 'User has answered your questions: "用哪个日期库？"="luxon"'),
      msg.result(cli.received[0]!.uuid),
    );
    await waitUntil(() => terminalEvents(events).length === 1);
    expect(toolCalls(events).at(-1)).toEqual({
      type: "tool_call",
      callId: "toolu_q",
      name: "AskUserQuestion",
      status: "completed",
      error: null,
      detail: { type: "question", questions: PARSED_QUESTIONS, answers },
    });
  });

  test("AskUserQuestion：allow 但没有回答按 deny；跳过使用默认 message", async () => {
    const h = createHarness();
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("x");
    const cli = h.clis[0]!;

    const unanswered = canUseTool(cli, "AskUserQuestion", QUESTION_INPUT, { toolUseId: "q1" });
    const first = session.getPendingPermissions()[0]!;
    await session.respondToPermission(first.id, {
      behavior: "allow",
      selectedActionId: "submit",
      updatedInput: { answers: { "用哪个日期库？": "  " } },
    });
    await expect(unanswered).resolves.toEqual({ behavior: "deny", message: "用户没有回答问题" });
    expect(events.at(-1)).toEqual({
      type: "permission_resolved",
      requestId: first.id,
      response: { behavior: "deny", selectedActionId: "submit", message: "用户没有回答问题" },
    });

    const skipped = canUseTool(cli, "AskUserQuestion", QUESTION_INPUT, { toolUseId: "q2" });
    const second = session.getPendingPermissions()[0]!;
    await session.respondToPermission(second.id, { behavior: "deny", selectedActionId: "skip" });
    await expect(skipped).resolves.toEqual({ behavior: "deny", message: "用户跳过了这些问题" });

    // 题目解析不出来时按普通工具审批
    const malformed = canUseTool(cli, "AskUserQuestion", { questions: "?" }, { toolUseId: "q3" });
    const third = session.getPendingPermissions()[0]!;
    expect(third).toMatchObject({ kind: "tool", actions: [{ id: "allow" }, { id: "deny" }] });
    await session.respondToPermission(third.id, { behavior: "deny" });
    await expect(malformed).resolves.toEqual({ behavior: "deny", message: "用户拒绝了该操作" });
  });

  test("上下文压缩：compacting → running，compact_boundary → 同 id 的 completed；之后 result 不再报压缩前的已用量", async () => {
    const status = (value: string | null, extra: Record<string, unknown> = {}) => ({
      type: "system",
      subtype: "status",
      status: value,
      session_id: SESSION_ID,
      uuid: `st-${String(value)}`,
      ...extra,
    });
    const h = createHarness();
    let round = 0;
    h.setup(
      (q) =>
        (q.onUser = (user) => {
          round += 1;
          if (round === 1) {
            q.emit(
              msg.init(),
              msg.streamStart("m1"), // 压缩前已用 100
              status("compacting"),
              status("compacting"),
              {
                type: "system",
                subtype: "compact_boundary",
                session_id: SESSION_ID,
                uuid: "cb",
                compact_metadata: { trigger: "manual", pre_tokens: 150_000, post_tokens: 12_000 },
              },
              status(null, { compact_result: "success" }),
              msg.result(user.uuid),
            );
          } else {
            q.emit(
              status("compacting"),
              status(null, { compact_result: "failed", compact_error: "摘要失败" }),
              msg.result(user.uuid),
            );
          }
        }),
    );
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    const compactions = () =>
      events.flatMap((e) => (e.type === "timeline" && e.item.type === "compaction" ? [e] : []));

    const { turnId } = await session.startTurn("/compact");
    await waitUntil(() => terminalEvents(events).length === 1);
    const [running, completed] = compactions();
    expect(compactions()).toHaveLength(2);
    expect(running).toEqual({
      type: "timeline",
      turnId,
      item: { type: "compaction", compactionId: expect.stringMatching(/^compact-/), status: "running" },
    });
    expect(completed).toEqual({
      type: "timeline",
      turnId,
      item: {
        type: "compaction",
        compactionId: running?.type === "timeline" && running.item.type === "compaction" ? running.item.compactionId : "",
        status: "completed",
        trigger: "manual",
        preTokens: 150_000,
      },
    });
    expect(terminalEvents(events)[0]).toMatchObject({
      type: "turn_completed",
      usage: { contextWindowUsedTokens: 12_000, contextWindowMaxTokens: 200_000 },
    });

    await session.startTurn("再来");
    await waitUntil(() => terminalEvents(events).length === 2);
    const [, , failedStart, failed] = compactions();
    expect(failed).toMatchObject({
      item: {
        type: "compaction",
        compactionId: failedStart?.type === "timeline" && failedStart.item.type === "compaction" ? failedStart.item.compactionId : "",
        status: "failed",
        error: "摘要失败",
      },
    });
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

  test("CLI 自发轮次：可中断；中断后的过期输出与 result 不再开新回合", async () => {
    const h = createHarness();
    h.setup((q) => (q.onUser = (user) => q.emit(msg.init(), msg.result(user.uuid))));
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("x");
    await waitUntil(() => terminalEvents(events).length === 1);
    const cli = h.clis[0]!;

    // 无输入地自行开始一轮（以 init 开头），工具权限照常走审批
    cli.emit(msg.init(), msg.streamStart("bg-1"), msg.textDelta("后台"));
    await waitUntil(() => events.some((e) => e.type === "timeline" && e.item.type === "assistant_message"));
    const started = events.find((e) => e.type === "turn_started" && e.origin === "background");
    expect(started).toBeDefined();
    const bgTurnId = started!.type === "turn_started" ? started!.turnId : "";
    const decision = canUseTool(cli, "Bash", { command: "ls" });
    await waitUntil(() => events.some((e) => e.type === "permission_requested"));
    expect(events.find((e) => e.type === "permission_requested")).toMatchObject({ turnId: bgTurnId });

    await session.interrupt();
    expect(cli.calls.interrupt).toBe(1);
    await expect(decision).resolves.toMatchObject({ behavior: "deny" });
    expect(terminalEvents(events).at(-1)).toEqual({ type: "turn_canceled", turnId: bgTurnId, reason: "interrupted" });

    // 被中断那一轮的尾巴：没有 init，不开新回合
    const before = events.length;
    cli.emit(msg.assistant("bg-1", [{ type: "text", text: "后台尾巴" }]), msg.result(undefined, { subtype: "error_during_execution", isError: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.slice(before)).toEqual([]);
  });

  test("CLI 自发轮次中 startTurn：挂起的审批作废，先结束自发轮次再开新回合；被接管轮次的 result 跳过一次", async () => {
    const h = createHarness();
    h.setup((q) => (q.onUser = (user) => {
      if (q.received.length === 1) q.emit(msg.init(), msg.result(user.uuid));
    }));
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("x");
    await waitUntil(() => terminalEvents(events).length === 1);
    const cli = h.clis[0]!;
    // 只有 init + 空 result 的空轮（真实 CLI 偶尔会有）：不显示成回合
    cli.emit(msg.init(), msg.result(undefined, { result: "" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.filter((e) => e.type === "turn_started")).toHaveLength(1);

    // 自发轮次第一件事就是请求工具权限：此时才开回合
    cli.emit(msg.init());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const decision = canUseTool(cli, "Bash", { command: "ls" });
    await waitUntil(() => events.some((e) => e.type === "permission_requested"));
    const started = events.find((e) => e.type === "turn_started" && e.origin === "background");
    expect(events.find((e) => e.type === "permission_requested")).toMatchObject({
      turnId: started?.type === "turn_started" ? started.turnId : "?",
    });

    const { turnId } = await session.startTurn("插话");
    await expect(decision).resolves.toMatchObject({ behavior: "deny", message: "用户发送了新消息，已取消该请求" });
    const types = events.map((e) => e.type);
    expect(types.slice(types.indexOf("permission_requested"))).toEqual([
      "permission_requested",
      "permission_resolved",
      "turn_completed",
      "turn_started",
    ]);
    expect(events.at(-1)).toEqual({ type: "turn_started", turnId });
    // 用户消息照常写入 stdin，由 CLI 排队
    expect(cli.received).toHaveLength(2);

    // 先到的是被接管自发轮次的 result（不带 uuid）：跳过；之后用户消息那一轮的 result 才结束本回合
    cli.emit(msg.result(undefined));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(terminalEvents(events)).toHaveLength(2);
    cli.emit(msg.init(), msg.result(cli.received[1]!.uuid));
    await waitUntil(() => terminalEvents(events).length === 3);
    expect(terminalEvents(events).at(-1)).toMatchObject({ type: "turn_completed", turnId });
    expect(events.filter((e) => e.type === "turn_started")).toHaveLength(3);
  });

  test("CLI 刚发 init、还没输出时用户发送：不开自发回合，那一轮的 result 跳过一次", async () => {
    const h = createHarness();
    h.setup((q) => (q.onUser = (user) => {
      if (q.received.length === 1) q.emit(msg.init(), msg.result(user.uuid));
    }));
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("x");
    await waitUntil(() => terminalEvents(events).length === 1);
    const cli = h.clis[0]!;
    cli.emit(msg.init());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { turnId } = await session.startTurn("y");
    // 自发那一轮的输出与 result 先到：输出并入本回合，result 跳过
    cli.emit(msg.assistant("bg", [{ type: "text", text: "后台" }]), msg.result(undefined));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(terminalEvents(events)).toHaveLength(1);
    cli.emit(msg.init(), msg.result(cli.received[1]!.uuid));
    await waitUntil(() => terminalEvents(events).length === 2);
    expect(events.filter((e) => e.type === "turn_started")).toEqual([
      expect.objectContaining({ type: "turn_started" }),
      { type: "turn_started", turnId },
    ]);
    expect(events.find((e) => e.type === "timeline" && e.item.type === "assistant_message")).toMatchObject({ turnId });
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

  test("forkSession（design.md 4.23）：首次拉起带 --fork-session，拿到新会话 id 后重启不再分叉；turn_completed 带 nativeRef", async () => {
    const NEW_ID = "99999999-8888-7777-6666-555555555555";
    const h = createHarness();
    h.setup((q) => {
      q.onUser = (user, cli) => {
        cli.emit(
          msg.init(NEW_ID),
          { ...msg.assistant(`msg-${cli.received.length}`, [{ type: "text", text: "好" }]), session_id: NEW_ID },
          { ...msg.result(user.uuid), session_id: NEW_ID },
        );
      };
    });
    const session = await h.client.forkSession!(
      { provider: "claude", sessionId: SESSION_ID },
      { cwd: ".", nativeRef: "uuid-at" },
    );
    // 还没有自己的原生 id：不能把原会话的 id 当成持久化句柄
    expect(session.id).toBeNull();
    expect(session.describePersistence()).toBeNull();
    expect(h.clis).toHaveLength(0);
    const events = collect(session);
    await session.startTurn("x");
    await waitUntil(() => terminalEvents(events).length === 1);
    expect(h.clis[0]!.options).toMatchObject({
      resumeSessionId: SESSION_ID,
      forkSession: true,
      resumeSessionAt: "uuid-at",
    });
    expect(events).toContainEqual({ type: "thread_started", sessionId: NEW_ID });
    expect(session.describePersistence()).toEqual({ provider: "claude", sessionId: NEW_ID });
    expect(terminalEvents(events)[0]).toMatchObject({
      type: "turn_completed",
      nativeRef: "a-msg-1",
    });

    // 思考强度变化触发重启：以新会话 id 恢复，不再带分叉参数
    await session.setThinking!("high");
    await session.startTurn("y");
    await waitUntil(() => terminalEvents(events).length === 2);
    expect(h.clis[1]!.options.resumeSessionId).toBe(NEW_ID);
    expect(h.clis[1]!.options.forkSession).toBeUndefined();
    expect(h.clis[1]!.options.resumeSessionAt).toBeUndefined();
  });

  test("forkSession 缺少原 sessionId 时报错", async () => {
    const h = createHarness();
    await expect(
      h.client.forkSession!({ provider: "claude", sessionId: "" }, { cwd: "." }),
    ).rejects.toThrow("sessionId");
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

describe("斜杠命令与 MCP（design.md 4.14）", () => {
  const commandsResponse = {
    models: [{ value: "default", displayName: "Default" }],
    commands: [
      { name: "compact", description: "Clear history but keep a summary", argumentHint: "<instructions>" },
      { name: "mcp", description: "Manage MCP servers" },
      { name: "compact", description: "重复项按 name 去重" },
      { name: "review", description: "Review", aliases: ["r", 1] },
      { description: "缺 name" },
      "bogus",
    ],
  } as unknown as ClaudeInitializeResponse;
  const expectedCommands = [
    { name: "compact", description: "Clear history but keep a summary", argumentHint: "<instructions>" },
    { name: "mcp", description: "Manage MCP servers" },
    { name: "review", description: "Review", aliases: ["r"] },
  ];

  test("fetchCatalog 顺带返回 initialize 的斜杠命令（去重、跳过非法项），命令按 cwd 缓存", async () => {
    const h = createHarness();
    h.setup((cli) => {
      cli.initialized = Promise.resolve(commandsResponse);
    });
    const first = await h.client.fetchCatalog({ cwd: "J:\a" });
    expect(first.commands).toEqual(expectedCommands);
    await h.client.fetchCatalog({ cwd: "J:\a" });
    expect(h.clis).toHaveLength(1);
    // 换 cwd：项目级命令可能不同，再探测一次
    await h.client.fetchCatalog({ cwd: "J:\b" });
    expect(h.clis).toHaveLength(2);
    expect(h.clis[1]!.options.cwd).toBe("J:\b");
    // 不传 cwd：模型已缓存，不为命令单独探测
    const noCwd = await h.client.fetchCatalog();
    expect(h.clis).toHaveLength(2);
    expect(noCwd.commands).toBeUndefined();
  });

  test("listCommands：进程未启动时退回目录（不启动会话进程）；之后用 initialize 应答；commands_changed 整体替换", async () => {
    const h = createHarness();
    h.setup((cli) => {
      cli.initialized = Promise.resolve(commandsResponse);
      cli.onUser = replyText("好的");
    });
    const session = await h.client.createSession({ cwd: "J:\w" });
    expect(await session.listCommands!()).toEqual(expectedCommands);
    // 只起了一个探测进程，没有发用户消息
    expect(h.clis).toHaveLength(1);
    expect(h.clis[0]!.received).toHaveLength(0);

    const events = collect(session);
    await session.startTurn("hi");
    await waitUntil(() => terminalEvents(events).length === 1);
    expect(h.clis).toHaveLength(2);
    expect(await session.listCommands!()).toEqual(expectedCommands);

    const before = events.length;
    h.clis[1]!.emit({
      type: "system",
      subtype: "commands_changed",
      session_id: SESSION_ID,
      uuid: "cc",
      commands: [{ name: "clear", description: "清空" }, { name: "clear" }],
    });
    await vi.waitFor(async () =>
      expect(await session.listCommands!()).toEqual([{ name: "clear", description: "清空" }]),
    );
    // 不影响时间线
    expect(events).toHaveLength(before);
  });

  test("getMcpStatus：映射 mcp_status（非法 status 归 pending、toolCount）；进程未启动时启动但不发消息", async () => {
    const h = createHarness();
    h.setup((cli) => {
      cli.mcpStatusResponse = {
        mcpServers: [
          { name: "fs", status: "connected", scope: "user", tools: [{ name: "read" }, { name: "write" }] },
          { name: "gh", status: "needs-auth" },
          { name: "bad", status: "failed", error: "spawn ENOENT" },
          { name: "odd", status: "weird" },
          { status: "connected" },
        ],
      };
    });
    const session = await h.client.createSession({ cwd: "." });
    await expect(session.getMcpStatus!()).resolves.toEqual({
      reconnect: "server",
      servers: [
        { name: "fs", status: "connected", scope: "user", toolCount: 2 },
        { name: "gh", status: "needs-auth" },
        { name: "bad", status: "failed", error: "spawn ENOENT" },
        { name: "odd", status: "pending" },
      ],
    });
    expect(h.clis).toHaveLength(1);
    expect(h.clis[0]!.received).toHaveLength(0);

    // 之后的回合复用同一进程
    h.clis[0]!.onUser = replyText("好的");
    const events = collect(session);
    await session.startTurn("x");
    await waitUntil(() => terminalEvents(events).length === 1);
    expect(h.clis).toHaveLength(1);
  });

  test("getStatus：会话 / 账户 / MCP 汇总；缺的项跳过", async () => {
    const h = createHarness();
    h.setup((cli) => {
      cli.initialized = Promise.resolve({
        current_permission_mode: "acceptEdits",
        output_style: "default",
        account: { email: "dev@example.com", subscriptionType: "max", apiProvider: "firstParty", organization: "" },
      });
      cli.mcpStatusResponse = {
        mcpServers: [
          { name: "fs", status: "connected" },
          { name: "gh", status: "needs-auth" },
          { name: "bad", status: "failed", error: "spawn ENOENT" },
        ],
      };
    });
    const session = await h.client.createSession({ cwd: "J:\\work" });
    const sections = await session.getStatus!();
    expect(sections).toEqual([
      {
        title: "会话",
        rows: [
          { label: "Claude Code 版本", value: "2.1.296 (Claude Code)" },
          { label: "工作目录", value: "J:\\work" },
          { label: "模型", value: "默认（跟随设置）" },
          { label: "权限模式", value: "自动接受编辑（acceptEdits）" },
          { label: "输出风格", value: "default" },
        ],
      },
      {
        title: "账户",
        rows: [
          { label: "邮箱", value: "dev@example.com" },
          { label: "订阅类型", value: "max" },
          { label: "API 服务", value: "firstParty" },
        ],
      },
      {
        title: "MCP",
        rows: [
          { label: "概览", value: "3 个服务器：1 已连接，1 失败，1 需要认证" },
          { label: "gh", value: "需要认证" },
          { label: "bad", value: "失败：spawn ENOENT" },
        ],
      },
    ]);
  });

  test("getStatus：MCP 查询失败只降级该分组；没有账户信息时不出现「账户」", async () => {
    const h = createHarness();
    h.setup((cli) => {
      cli.mcpStatus = async () => {
        throw new Error("mcp 超时");
      };
    });
    const session = await h.client.createSession({ cwd: ".", model: "opus" });
    const sections = await session.getStatus!();
    expect(sections.map((s) => s.title)).toEqual(["会话", "MCP"]);
    expect(sections[0]!.rows).toContainEqual({ label: "模型", value: "opus" });
    expect(sections[1]!.rows).toEqual([{ label: "状态", value: "读取失败：mcp 超时" }]);
  });

  test("reconnectMcp：发 mcp_reconnect 带 serverName；缺 serverName 返回 NOT_SUPPORTED", async () => {
    const h = createHarness();
    const session = await h.client.createSession({ cwd: "." });
    await session.reconnectMcp!("fs");
    expect(h.clis[0]!.calls.mcpReconnect).toEqual(["fs"]);
    await expect(session.reconnectMcp!()).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    expect(h.clis[0]!.calls.mcpReconnect).toEqual(["fs"]);
  });
});

describe("后台任务（design.md 4.15）", () => {
  const taskStarted = (extra: Record<string, unknown> = {}) => ({
    type: "system",
    subtype: "task_started",
    session_id: SESSION_ID,
    task_id: "bk1",
    tool_use_id: "toolu_b",
    description: "pnpm build",
    task_type: "local_bash",
    is_backgrounded: true,
    ...extra,
  });

  function collectTasks(session: AgentSession): AgentBackgroundTask[][] {
    const snapshots: AgentBackgroundTask[][] = [];
    session.subscribe((event) => {
      if (event.type === "provider_background_tasks") snapshots.push(event.tasks);
    });
    return snapshots;
  }

  /** 先启动 claude 进程（getMcpStatus 不发用户消息），返回假进程 */
  async function launch(h: Harness, session: AgentSession): Promise<FakeCli> {
    await session.getMcpStatus!();
    return h.clis.at(-1)!;
  }

  test("登记 local_bash，从工具结果取到输出路径；状态由 task_updated / task_notification 更新", async () => {
    const h = createHarness();
    const session = await h.client.createSession({ cwd: "." });
    const snapshots = collectTasks(session);
    const cli = await launch(h, session);

    cli.emit(taskStarted());
    cli.emit(
      msg.toolResult(
        "toolu_b",
        "Command running in background with ID: bk1. Output is being written to: C:\t\bk1.output",
      ),
    );
    await waitUntil(() => snapshots.at(-1)?.[0]?.hasOutput === true);
    expect(snapshots.at(-1)).toMatchObject([{ taskId: "bk1", kind: "command", status: "running", hasOutput: true }]);

    cli.emit({
      type: "system",
      subtype: "task_notification",
      session_id: SESSION_ID,
      task_id: "bk1",
      tool_use_id: "toolu_b",
      status: "completed",
      summary: "done",
      output_file: "C:\t\bk1.output",
    });
    await waitUntil(() => snapshots.at(-1)?.[0]?.status === "completed");
    expect(session.listBackgroundTasks!()).toMatchObject([{ taskId: "bk1", status: "completed", summary: "done" }]);
  });

  test("前台 Bash 与子代理（local_agent）不登记；前台 Bash 转入后台后登记", async () => {
    const h = createHarness();
    const session = await h.client.createSession({ cwd: "." });
    const snapshots = collectTasks(session);
    const cli = await launch(h, session);
    cli.emit(
      taskStarted({ task_id: "a1", tool_use_id: "toolu_a", task_type: "local_agent", subagent_type: "Explore" }),
      taskStarted({ task_id: "f1", tool_use_id: "toolu_f", is_backgrounded: false }),
    );
    cli.emit({ type: "system", subtype: "task_progress", session_id: SESSION_ID, task_id: "a1", usage: { total_tokens: 3 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(snapshots).toHaveLength(0);
    expect(session.listBackgroundTasks!()).toEqual([]);

    cli.emit({ type: "system", subtype: "task_updated", session_id: SESSION_ID, task_id: "f1", patch: { is_backgrounded: true } });
    await waitUntil(() => snapshots.length > 0);
    expect(snapshots.at(-1)).toMatchObject([{ taskId: "f1", kind: "command", status: "running" }]);
  });

  test("command 取自 assistant 的 Bash tool_use（主线程与子代理 sidechain 都收），exitCode 取自 task_notification 的 summary", async () => {
    const h = createHarness();
    const session = await h.client.createSession({ cwd: "." });
    const snapshots = collectTasks(session);
    const cli = await launch(h, session);
    cli.emit(
      msg.assistant("m1", [{ type: "tool_use", id: "toolu_b", name: "Bash", input: { command: "pnpm build", run_in_background: true } }]),
      // 子代理 sidechain 里发起的后台命令
      msg.assistant("m2", [{ type: "tool_use", id: "toolu_c", name: "PowerShell", input: { command: "Start-Sleep 9" } }], "toolu_parent"),
    );
    cli.emit(taskStarted(), taskStarted({ task_id: "bk2", tool_use_id: "toolu_c" }));
    await waitUntil(() => (snapshots.at(-1)?.length ?? 0) === 2);
    expect(snapshots.at(-1)).toMatchObject([
      { taskId: "bk1", command: "pnpm build" },
      { taskId: "bk2", command: "Start-Sleep 9" },
    ]);

    cli.emit({
      type: "system",
      subtype: "task_notification",
      session_id: SESSION_ID,
      task_id: "bk1",
      status: "failed",
      summary: 'Background command "pnpm build" failed (exit code 3)',
    });
    await waitUntil(() => snapshots.at(-1)?.[0]?.status === "failed");
    expect(snapshots.at(-1)?.[0]).toMatchObject({ exitCode: 3 });
  });

  test("stopBackgroundTask：发 stop_task；未知任务 TASK_NOT_FOUND；已结束任务不再发", async () => {
    const h = createHarness();
    const session = await h.client.createSession({ cwd: "." });
    const snapshots = collectTasks(session);
    const cli = await launch(h, session);
    cli.emit(taskStarted());
    await waitUntil(() => snapshots.length > 0);

    await session.stopBackgroundTask!("bk1");
    expect(cli.calls.stopTask).toEqual(["bk1"]);
    await expect(session.stopBackgroundTask!("nope")).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });

    cli.emit({ type: "system", subtype: "task_updated", session_id: SESSION_ID, task_id: "bk1", patch: { status: "killed" } });
    await waitUntil(() => snapshots.at(-1)?.[0]?.status === "stopped");
    await session.stopBackgroundTask!("bk1");
    expect(cli.calls.stopTask).toEqual(["bk1"]);
  });

  test("stopBackgroundTask：stop_task 失败时，任务不在存活集合则本地标 stopped 不抛；仍在集合则抛错", async () => {
    const h = createHarness();
    const session = await h.client.createSession({ cwd: "." });
    const snapshots = collectTasks(session);
    const cli = await launch(h, session);
    cli.stopTask = async () => {
      throw new Error("no such task");
    };
    cli.emit(taskStarted());
    await waitUntil(() => snapshots.length > 0);

    cli.emit({ type: "system", subtype: "background_tasks_changed", session_id: SESSION_ID, tasks: [{ task_id: "bk1" }] });
    await expect(session.stopBackgroundTask!("bk1")).rejects.toThrow("no such task");

    cli.emit({ type: "system", subtype: "background_tasks_changed", session_id: SESSION_ID, tasks: [] });
    await session.stopBackgroundTask!("bk1");
    expect(snapshots.at(-1)?.[0]).toMatchObject({ status: "stopped", error: "CLI 中已不存在该任务" });
  });

  test("readBackgroundTaskOutput：只读 CLI 报告的路径，读尾部并标记截断；无路径 / 文件不存在返回空", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "agentdeck-task-out-"));
    try {
      const file = path.join(dir, "bk1.output");
      writeFileSync(file, "aaaa1\nbbbb2\ncccc3\n");
      const h = createHarness();
      const session = await h.client.createSession({ cwd: "." });
      const snapshots = collectTasks(session);
      const cli = await launch(h, session);
      cli.emit(taskStarted(), taskStarted({ task_id: "bk2", tool_use_id: "toolu_c" }));
      await waitUntil(() => (snapshots.at(-1)?.length ?? 0) === 2);
      await expect(session.readBackgroundTaskOutput!("bk1", 1024)).resolves.toEqual({
        text: "",
        truncated: false,
        size: 0,
      });

      cli.emit(msg.toolResult("toolu_b", `Command running in background with ID: bk1. Output is being written to: ${file}`));
      await waitUntil(() => snapshots.at(-1)?.[0]?.hasOutput === true);
      await expect(session.readBackgroundTaskOutput!("bk1", 1024)).resolves.toEqual({
        text: "aaaa1\nbbbb2\ncccc3\n",
        truncated: false,
        size: 18,
      });
      await expect(session.readBackgroundTaskOutput!("bk1", 9)).resolves.toEqual({
        text: "cccc3\n",
        truncated: true,
        size: 18,
      });
      await expect(session.readBackgroundTaskOutput!("nope", 9)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("claude 进程退出：仍在运行的任务标为已停止（会话已结束）并推送；关闭会话同理", async () => {
    const h = createHarness();
    const session = await h.client.createSession({ cwd: "." });
    const snapshots = collectTasks(session);
    const cli = await launch(h, session);
    cli.emit(taskStarted());
    await waitUntil(() => snapshots.length > 0);
    cli.end();
    await waitUntil(() => snapshots.at(-1)?.[0]?.status === "stopped");
    expect(snapshots.at(-1)).toMatchObject([{ taskId: "bk1", status: "stopped", error: "会话已结束" }]);

    // 进程重启后旧任务保留，新任务照常登记；close 再把仍在运行的标为已停止
    const second = await h.client.createSession({ cwd: "." });
    const secondSnapshots = collectTasks(second);
    const secondCli = await launch(h, second);
    secondCli.emit(taskStarted({ task_id: "bk9" }));
    await waitUntil(() => secondSnapshots.length > 0);
    await second.close();
    expect(secondSnapshots.at(-1)).toMatchObject([{ taskId: "bk9", status: "stopped", error: "会话已结束" }]);
  });
});

describe("ClaudeAgentSession 运行中插话（design.md 4.22）", () => {
  test("capabilities.steer 为真；没有进行中的回合时 steer 报错", async () => {
    const h = createHarness();
    expect(h.client.capabilities).toEqual({ steer: true });
    const session = await h.client.createSession({ cwd: "." });
    await expect(session.steer!("插话")).rejects.toThrow("当前没有可插话的用户回合");
  });

  test("steer 写入带新 uuid 的 user 消息；回合仍以原 uuid 的 result 结束，过期的插话 result 不影响下一轮", async () => {
    const h = createHarness();
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("第一条");
    const cli = h.clis[0]!;
    const first = cli.received[0]!;
    cli.emit(msg.init(), msg.assistant("m1", [{ type: "text", text: "处理中" }]));

    await session.steer!("请补充一句");
    expect(cli.received).toHaveLength(2);
    const steered = cli.received[1]!;
    expect(steered.uuid).not.toBe(first.uuid);
    expect(steered.message.content).toEqual([{ type: "text", text: "请补充一句" }]);
    // 插话不开新回合
    expect(events.filter((e) => e.type === "turn_started")).toHaveLength(1);
    expect(terminalEvents(events)).toHaveLength(0);

    // 被吸收：只有原 uuid 的 result，回合正常结束
    cli.emit(msg.result(first.uuid));
    await waitUntil(() => terminalEvents(events).length === 1);
    expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_completed" });

    // 下一轮里到达的插话消息 uuid 的 result（未被吸收的兜底场景）不能提前结束新回合
    await session.startTurn("第二条");
    const second = cli.received[2]!;
    cli.emit(msg.result(steered.uuid));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(terminalEvents(events)).toHaveLength(1);
    cli.emit(msg.result(second.uuid));
    await waitUntil(() => terminalEvents(events).length === 2);
  });
});

describe("额度事件与输出速度（design.md 4.30）", () => {
  const rateLimitEvent = (info: Record<string, unknown>, parent: string | null = null) => ({
    type: "rate_limit_event",
    parent_tool_use_id: parent,
    rate_limit_info: info,
    uuid: "rl",
    session_id: SESSION_ID,
  });
  const messageDelta = (outputTokens: number, parent: string | null = null) => ({
    type: "stream_event",
    parent_tool_use_id: parent,
    session_id: SESSION_ID,
    uuid: "md",
    event: { type: "message_delta", usage: { output_tokens: outputTokens } },
  });
  const rateLimits = (events: AgentStreamEvent[]) =>
    events.flatMap((e) => (e.type === "rate_limits_updated" ? [e.rateLimits] : []));

  test("有 unifiedWindows：逐窗口映射，utilization×100、resetsAt 秒转毫秒，allowed_warning → warning", async () => {
    const h = createHarness();
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("hi");
    h.clis[0]!.emit(
      rateLimitEvent({
        status: "allowed_warning",
        resetsAt: 1791921600,
        rateLimitType: "seven_day",
        utilization: 0.96,
        unifiedWindows: {
          five_hour: { utilization: 0.03, resetsAt: 1791891600 },
          seven_day: { utilization: 0.96, resetsAt: 1791921600 },
          seven_day_opus: { utilization: 0.07 },
        },
      }),
    );
    await waitUntil(() => rateLimits(events).length === 1);
    const limits = rateLimits(events)[0]!;
    expect(limits.status).toBe("warning");
    expect(limits.windows).toEqual([
      { id: "five_hour", label: "5 小时", usedPercent: 3, resetsAt: 1791891600_000 },
      { id: "seven_day", label: "7 天", usedPercent: 96, resetsAt: 1791921600_000 },
      { id: "seven_day_opus", label: "seven_day_opus", usedPercent: 7 },
    ]);
    expect(limits.updatedAt).toBeGreaterThan(0);
    // 不进 usage
    expect(events.some((e) => e.type === "usage_updated")).toBe(false);
  });

  test("没有 unifiedWindows：用顶层 rateLimitType + utilization + resetsAt；status 映射 allowed / rejected", async () => {
    const h = createHarness();
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("hi");
    const cli = h.clis[0]!;
    cli.emit(rateLimitEvent({ status: "allowed", rateLimitType: "five_hour", utilization: 0.5, resetsAt: 1000 }));
    cli.emit(rateLimitEvent({ status: "rejected", rateLimitType: "seven_day", utilization: 1, resetsAt: 2000 }));
    // 无可用窗口的事件被忽略
    cli.emit(rateLimitEvent({ status: "allowed" }));
    await waitUntil(() => rateLimits(events).length === 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rateLimits(events)).toHaveLength(2);
    expect(rateLimits(events)[0]).toMatchObject({
      status: "allowed",
      windows: [{ id: "five_hour", label: "5 小时", usedPercent: 50, resetsAt: 1_000_000 }],
    });
    expect(rateLimits(events)[1]).toMatchObject({
      status: "rejected",
      windows: [{ id: "seven_day", label: "7 天", usedPercent: 100, resetsAt: 2_000_000 }],
    });
  });

  test("子代理 sidechain 里的 rate_limit_event 同样处理", async () => {
    const h = createHarness();
    const session = await h.client.createSession({ cwd: "." });
    const events = collect(session);
    await session.startTurn("hi");
    h.clis[0]!.emit(
      rateLimitEvent({ status: "allowed", rateLimitType: "five_hour", utilization: 0.1 }, "toolu_sub"),
    );
    await waitUntil(() => rateLimits(events).length === 1);
    expect(rateLimits(events)[0]!.windows[0]).toMatchObject({ id: "five_hour", usedPercent: 10 });
  });

  const streamEvent = (event: Record<string, unknown>) => ({
    type: "stream_event",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: "se",
    event,
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const messageStop = () => streamEvent({ type: "message_stop" });
  const blockStart = (blockType: string) =>
    streamEvent({ type: "content_block_start", index: 0, content_block: { type: blockType } });
  const inputJsonDelta = () =>
    streamEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } });

  test("输出速度：按单次响应记账，≥100 token 且 ≥100ms 才合格，message_stop 才下发（每秒最多一次），短响应不拉低，sidechain 不计，result 把未结束的响应收尾", async () => {
    let now = 1_000_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const h = createHarness();
      const session = await h.client.createSession({ cwd: "." });
      const events = collect(session);
      await session.startTurn("hi");
      const cli = h.clis[0]!;
      const user = cli.received[0]!;
      // 每次发完等一下，保证消息在时钟推进之前已被处理
      const feed = async (...messages: Parameters<typeof cli.emit>) => {
        cli.emit(...messages);
        await settle();
      };
      const speeds = () =>
        events.flatMap((e) =>
          e.type === "usage_updated" && e.usage.outputTokensPerSecond !== undefined
            ? [e.usage]
            : [],
        );
      // m1：生成 0.5 秒、50 token（<100 token，不合格）后 message_stop：没有合格响应，不下发
      await feed(msg.init(), msg.streamStart("m1"), msg.textDelta("你好"));
      await waitUntil(() => events.some((e) => e.type === "timeline"));
      now += 500;
      await feed(messageDelta(50), messageStop());
      expect(speeds()).toHaveLength(0);
      // 间隔 1 秒（首 token 等待）不计入；m2 生成 1.5 秒、100 token（合格）：100 ÷ 1.5 = 66.7
      now += 1000;
      await feed(msg.streamStart("m2"), msg.textDelta("再来"));
      now += 1500;
      await feed(messageDelta(100), messageStop());
      await waitUntil(() => speeds().length === 1);
      expect(speeds()[0]).toEqual({ outputTokensPerSecond: 66.7 });
      // 子代理 sidechain 的 message_delta / message_stop 不计入
      await feed(messageDelta(9999, "toolu_sub"));
      // m3：生成 0.2 秒、200 token（合格）；距上次下发不足 1 秒：节流，不下发
      now += 500;
      await feed(msg.streamStart("m3"), blockStart("thinking"), messageDelta(200));
      now += 200;
      await feed(messageStop());
      expect(speeds()).toHaveLength(1);
      // m4（只有工具参数、20 token）不合格，不进入 Σ，也不拉低速度：
      // Σ token ÷ Σ 时长 = (100 + 200) ÷ (1.5 + 0.2) = 176.5（若 m4 的 0.5 秒也计入会是 300 ÷ 2.2 = 136.4）
      now += 300;
      await feed(msg.streamStart("m4"), blockStart("tool_use"), messageDelta(20));
      now += 500;
      await feed(messageStop());
      await waitUntil(() => speeds().length === 2);
      expect(speeds()[1]).toEqual({ outputTokensPerSecond: 176.5 });
      // m5 被中断，没有 message_stop：生成 2 秒、300 token（合格）。result 把它收尾，
      // 最终 (100 + 200 + 300) ÷ (1.5 + 0.2 + 2) = 162.2；分子取流里累计的 token，而不是 result.usage.output_tokens
      now += 1000;
      await feed(msg.streamStart("m5"), msg.textDelta("中断"), messageDelta(300));
      now += 2000;
      const result = msg.result(user.uuid);
      result.usage.output_tokens = 400;
      await feed(result);
      await waitUntil(() => terminalEvents(events).length === 1);
      const done = terminalEvents(events)[0]!;
      expect(done).toMatchObject({ type: "turn_completed", usage: { outputTokens: 400, outputTokensPerSecond: 162.2 } });
      // 合格累计：token 100 + 200 + 300 = 600，时长 1500 + 200 + 2000 = 3700ms；600 ÷ 3.7 秒 = 162.2
      expect(done).toMatchObject({ usage: { speedOutputTokens: 600, speedGenerationMs: 3700 } });
    } finally {
      spy.mockRestore();
    }
  });

  test("输出速度：先只有思考块（无 thinking_delta 文字）→ tool_use → 之后才有文字，按生成段计算而不是从首段文字算", async () => {
    let now = 1_000_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const h = createHarness();
      const session = await h.client.createSession({ cwd: "." });
      const events = collect(session);
      await session.startTurn("hi");
      const cli = h.clis[0]!;
      const user = cli.received[0]!;
      // 每次发完等一下，保证消息在时钟推进之前已被处理
      const feed = async (...messages: Parameters<typeof cli.emit>) => {
        cli.emit(...messages);
        await settle();
      };
      const speeds = () =>
        events.flatMap((e) =>
          e.type === "usage_updated" && e.usage.outputTokensPerSecond !== undefined
            ? [e.usage.outputTokensPerSecond]
            : [],
        );
      // m1：思考块 20 秒没有任何文字，随后 tool_use 参数 2 秒，共 600 token
      await feed(msg.init(), msg.streamStart("m1"), blockStart("thinking"));
      now += 20_000;
      await feed(blockStart("tool_use"), inputJsonDelta());
      now += 2_000;
      await feed(messageDelta(600), messageStop());
      await waitUntil(() => speeds().length === 1);
      expect(speeds()[0]).toBe(27.3); // 600 ÷ 22 秒
      // 工具执行 30 秒，不计入
      now += 30_000;
      // m2：整回合第 52 秒才出现第一段可见文字，生成 2 秒，共 200 token；累计 24 秒、800 token
      await feed(msg.streamStart("m2"), blockStart("text"), msg.textDelta("完成"));
      now += 2_000;
      await feed(messageDelta(200), messageStop());
      await waitUntil(() => speeds().length === 2);
      expect(speeds()[1]).toBe(33.3); // 800 ÷ 24 秒；旧口径从首段文字算会得到 400
      await feed(msg.result(user.uuid));
      await waitUntil(() => terminalEvents(events).length === 1);
      expect(terminalEvents(events)[0]).toMatchObject({
        type: "turn_completed",
        usage: { outputTokensPerSecond: 33.3 },
      });
    } finally {
      spy.mockRestore();
    }
  });
});
