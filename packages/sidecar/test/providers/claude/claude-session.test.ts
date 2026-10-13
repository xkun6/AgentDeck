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
