// Derived from paseo packages/server/src/server/agent/providers/claude/agent.ts and query.ts (Apache-2.0); modified for AgentDeck
// 大幅精简：一个会话一个长生命周期 query（streaming input），每轮 push 一条用户消息；
// 只保留 AgentDeck 协议需要的事件翻译、权限中转、中断、模型/模式切换与 tree-kill 关闭。
// 去掉了 paseo 的子代理侧链、steer、rewind、历史回放、快速模式、思考预算等功能。
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";

import {
  query as sdkQuery,
  type CanUseTool,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type SpawnOptions as ClaudeSpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentMode,
  AgentModelDefinition,
  AgentPermissionAction,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentStreamEvent,
  AgentTimelineItem,
  AgentUsage,
  ToolCallDetail,
} from "@agentdeck/protocol";

import type {
  AgentAvailability,
  AgentClient,
  AgentSession,
  AgentSessionConfig,
} from "../../agent/types.js";
import type { Logger } from "../../logger.js";
import { createExternalProcessEnv } from "../../utils/process-env.js";
import { withTimeout } from "../../utils/promise-timeout.js";
import { spawnProcess } from "../../utils/spawn.js";
import { terminateWithTreeKill, type ProcessTerminator } from "../../utils/tree-kill.js";
import {
  createDefaultClaudeExecutableDeps,
  resolveClaudeExecutable,
  type ClaudeExecutableResolution,
} from "./claude-executable.js";
import {
  mapClaudeCanceledToolCall,
  mapClaudeCompletedToolCall,
  mapClaudeFailedToolCall,
  mapClaudeRunningToolCall,
  resolveClaudeToolKind,
} from "./tool-call-mapper.js";

export const CLAUDE_PROVIDER_ID = "claude";

/** Claude Code 接受的模型别名；`default` 表示不传 model，沿用 CLI 默认 / 用户配置 */
export const CLAUDE_MODELS: AgentModelDefinition[] = [
  {
    provider: CLAUDE_PROVIDER_ID,
    id: "default",
    label: "默认（跟随 Claude Code 配置）",
    description: "不指定模型，使用 Claude Code 的默认模型或用户设置",
    isDefault: true,
  },
  { provider: CLAUDE_PROVIDER_ID, id: "sonnet", label: "Sonnet（均衡）" },
  { provider: CLAUDE_PROVIDER_ID, id: "opus", label: "Opus（最强）" },
  { provider: CLAUDE_PROVIDER_ID, id: "haiku", label: "Haiku（最快）" },
];

export const CLAUDE_MODES: AgentMode[] = [
  { id: "default", label: "默认", description: "敏感操作逐项请求审批" },
  { id: "acceptEdits", label: "自动接受编辑", description: "文件编辑自动通过，其它操作仍需审批" },
  { id: "plan", label: "计划模式", description: "只读分析并给出计划，批准后才执行" },
  {
    id: "bypassPermissions",
    label: "跳过所有审批",
    description: "所有工具调用直接执行（危险）",
    dangerous: true,
  },
];

const DEFAULT_MODE: PermissionMode = "default";
const INTERRUPT_TIMEOUT_MS = 3_000;
const AVAILABILITY_CACHE_MS = 60_000;
const KILL_GRACEFUL_TIMEOUT_MS = 1_500;
const KILL_FORCE_TIMEOUT_MS = 1_500;

/** 父进程若本身运行在 Claude Code 里，这些变量会让子 claude 认为自己嵌套在另一个会话中 */
const PARENT_SESSION_ENV_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_AGENT_SDK_VERSION",
];

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const TOOL_PERMISSION_ACTIONS: AgentPermissionAction[] = [
  { id: "allow", label: "允许一次", behavior: "allow" },
  { id: "deny", label: "拒绝", behavior: "deny" },
];

const PLAN_PERMISSION_ACTIONS: AgentPermissionAction[] = [
  { id: "approve", label: "批准计划", behavior: "allow" },
  { id: "keep_planning", label: "继续规划", behavior: "deny" },
];

/** SDK Query 中本 provider 用到的部分（测试可注入假实现） */
export type ClaudeQueryHandle = AsyncIterable<SDKMessage> &
  Pick<Query, "interrupt" | "setModel" | "setPermissionMode" | "close">;

export type ClaudeQueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => ClaudeQueryHandle;

const defaultQueryFn: ClaudeQueryFn = (params) => sdkQuery(params);

export interface ClaudeAgentClientOptions {
  logger: Logger;
  /** sidecar 进程环境；传给 claude 前会剔除 AGENTDECK_* 与父 Claude 会话变量 */
  env: NodeJS.ProcessEnv;
  queryFn?: ClaudeQueryFn;
  resolveExecutable?: () => Promise<ClaudeExecutableResolution>;
  terminateProcess?: ProcessTerminator;
}

export class ClaudeAgentClient implements AgentClient {
  readonly provider = CLAUDE_PROVIDER_ID;
  readonly kind = "claude" as const;
  readonly label = "Claude Code";

  private readonly logger: Logger;
  private readonly childEnv: Record<string, string>;
  private readonly queryFn: ClaudeQueryFn;
  private readonly resolveExecutable: () => Promise<ClaudeExecutableResolution>;
  private readonly terminateProcess: ProcessTerminator;
  private cached: { at: number; promise: Promise<ClaudeExecutableResolution> } | null = null;

  constructor(options: ClaudeAgentClientOptions) {
    this.logger = options.logger;
    this.childEnv = buildClaudeChildEnv(options.env);
    this.queryFn = options.queryFn ?? defaultQueryFn;
    this.resolveExecutable =
      options.resolveExecutable ??
      (() =>
        resolveClaudeExecutable(
          createDefaultClaudeExecutableDeps(options.env, (message) => this.logger.warn(message)),
        ));
    this.terminateProcess = options.terminateProcess ?? terminateWithTreeKill;
  }

  async isAvailable(): Promise<AgentAvailability> {
    const resolution = await this.resolve();
    if (!resolution.available) {
      return { available: false, reason: resolution.reason };
    }
    return { available: true, command: [resolution.path] };
  }

  async fetchCatalog(): Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }> {
    return {
      models: CLAUDE_MODELS.map((model) => ({ ...model })),
      modes: CLAUDE_MODES.map((mode) => ({ ...mode })),
    };
  }

  async createSession(cfg: AgentSessionConfig): Promise<AgentSession> {
    return this.openSession(cfg, null);
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    cfg: { cwd: string },
  ): Promise<AgentSession> {
    if (!handle.sessionId) {
      throw new Error("恢复 Claude 会话需要 sessionId");
    }
    return this.openSession({ cwd: cfg.cwd }, handle.sessionId);
  }

  private async openSession(
    cfg: AgentSessionConfig,
    resumeSessionId: string | null,
  ): Promise<ClaudeAgentSession> {
    const modeId = cfg.modeId ?? DEFAULT_MODE;
    assertClaudeMode(modeId);
    const resolution = await this.resolve();
    if (!resolution.available) {
      throw new Error(resolution.reason);
    }
    return new ClaudeAgentSession({
      logger: this.logger,
      env: this.childEnv,
      queryFn: this.queryFn,
      terminateProcess: this.terminateProcess,
      executablePath: resolution.path,
      cwd: cfg.cwd,
      model: cfg.model ?? null,
      modeId,
      resumeSessionId,
    });
  }

  /** 成功结果缓存 60 秒（provider.list 与 agent.create 都会调用）；失败不缓存，便于安装后立即生效 */
  private resolve(): Promise<ClaudeExecutableResolution> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < AVAILABILITY_CACHE_MS) {
      return this.cached.promise;
    }
    const promise = this.resolveExecutable().then(
      (resolution) => {
        if (!resolution.available && this.cached?.promise === promise) {
          this.cached = null;
        }
        return resolution;
      },
      (error: unknown) => {
        if (this.cached?.promise === promise) {
          this.cached = null;
        }
        throw error;
      },
    );
    this.cached = { at: now, promise };
    return promise;
  }
}

export interface ClaudeAgentSessionOptions {
  logger: Logger;
  /** 已清洗的子进程环境 */
  env: Record<string, string>;
  queryFn: ClaudeQueryFn;
  terminateProcess?: ProcessTerminator;
  executablePath: string;
  cwd: string;
  model: string | null;
  modeId: string;
  resumeSessionId: string | null;
}

interface ActiveTurn {
  turnId: string;
  /** 本轮用户消息的 uuid；CLI 在 result.user_message_uuid 中回显，用于识别过期 result */
  userMessageUuid: string;
}

interface PendingPermission {
  request: AgentPermissionRequest;
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
  cleanup: () => void;
}

interface ToolUseEntry {
  name: string;
  input: unknown;
  /** TodoWrite 等以其它 timeline 形式展示的工具，不发 tool_call */
  hidden: boolean;
}

interface AsyncMessageInput<T> {
  push(item: T): void;
  end(): void;
  iterable: AsyncIterable<T>;
}

export class ClaudeAgentSession implements AgentSession {
  readonly provider = CLAUDE_PROVIDER_ID;

  private readonly logger: Logger;
  private readonly env: Record<string, string>;
  private readonly queryFn: ClaudeQueryFn;
  private readonly terminateProcess: ProcessTerminator;
  private readonly executablePath: string;
  private readonly cwd: string;

  private sessionId: string | null;
  private threadStarted = false;
  private closed = false;
  private model: string | null;
  private mode: PermissionMode;

  private query: ClaudeQueryHandle | null = null;
  private input: AsyncMessageInput<SDKUserMessage> | null = null;
  private child: ChildProcess | null = null;

  private activeTurn: ActiveTurn | null = null;
  private readonly listeners = new Set<(event: AgentStreamEvent) => void>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly toolUses = new Map<string, ToolUseEntry>();
  /** 已通过 stream_event 增量输出过文本 / 思考的 API message id，完整 assistant 消息到达时跳过对应块 */
  private readonly streamedText = new Set<string>();
  private readonly streamedThinking = new Set<string>();
  private currentStreamMessageId: string | null = null;
  private contextInputTokens = 0;
  private contextOutputTokens = 0;

  constructor(options: ClaudeAgentSessionOptions) {
    assertClaudeMode(options.modeId);
    this.logger = options.logger;
    this.env = options.env;
    this.queryFn = options.queryFn;
    this.terminateProcess = options.terminateProcess ?? terminateWithTreeKill;
    this.executablePath = options.executablePath;
    this.cwd = options.cwd;
    this.model = options.model;
    this.mode = options.modeId;
    this.sessionId = options.resumeSessionId;
  }

  get id(): string | null {
    return this.sessionId;
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    if (this.closed) {
      throw new Error("Claude 会话已关闭");
    }
    if (this.activeTurn) {
      throw new Error("Claude 会话正在执行中");
    }
    const turnId = randomUUID();
    const message = toSdkUserMessage(prompt, this.sessionId);
    const turn: ActiveTurn = { turnId, userMessageUuid: message.uuid ?? randomUUID() };
    this.activeTurn = turn;
    this.emit({ type: "turn_started", turnId });

    try {
      const input = this.ensureQuery();
      input.push(message);
    } catch (error) {
      this.logger.error("启动 Claude Code 失败：%s", errorMessage(error));
      this.finishTurn(turn, {
        type: "turn_failed",
        turnId,
        error: `启动 Claude Code 失败：${errorMessage(error)}`,
      });
    }
    return { turnId };
  }

  subscribe(cb: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return Array.from(this.pendingPermissions.values(), (pending) => pending.request);
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      throw new Error(`找不到待处理的权限请求：${requestId}`);
    }
    this.pendingPermissions.delete(requestId);
    pending.cleanup();
    this.emit({ type: "permission_resolved", requestId, response });

    const isPlan = pending.request.kind === "plan";
    if (response.behavior === "allow") {
      pending.resolve({
        behavior: "allow",
        updatedInput: response.updatedInput ?? pending.input,
      });
      // 批准计划后离开 plan 模式，后续工具调用仍逐项审批
      if (isPlan && this.mode === "plan") {
        await this.setMode("default").catch((error: unknown) => {
          this.logger.warn("批准计划后切换模式失败：%s", errorMessage(error));
        });
      }
      return;
    }
    pending.resolve({
      behavior: "deny",
      message:
        response.message ?? (isPlan ? "用户希望继续完善计划，暂不执行" : "用户拒绝了该操作"),
      ...(response.interrupt ? { interrupt: true } : {}),
    });
  }

  async interrupt(): Promise<void> {
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }
    this.activeTurn = null;
    this.denyAllPendingPermissions("回合已取消");
    this.cancelRunningTools(turn.turnId);

    const query = this.query;
    if (query) {
      try {
        await withTimeout(query.interrupt(), INTERRUPT_TIMEOUT_MS, "中断 Claude Code 超时（3 秒）");
      } catch (error) {
        // 中断失败或超时：直接拆掉当前 query，下一轮以 resume 重新拉起
        this.logger.warn("中断 Claude Code 失败，重建会话进程：%s", errorMessage(error));
        await this.teardownQuery();
      }
    }
    this.emit({ type: "turn_canceled", turnId: turn.turnId, reason: "interrupted" });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    const turn = this.activeTurn;
    this.activeTurn = null;
    this.denyAllPendingPermissions("会话已关闭");
    if (turn) {
      this.cancelRunningTools(turn.turnId);
      this.emit({ type: "turn_canceled", turnId: turn.turnId, reason: "closed" });
    }
    this.closed = true;
    await this.teardownQuery();
    this.listeners.clear();
  }

  describePersistence(): AgentPersistenceHandle | null {
    return this.sessionId ? { provider: CLAUDE_PROVIDER_ID, sessionId: this.sessionId } : null;
  }

  async setModel(modelId: string | null): Promise<void> {
    if (this.query) {
      await this.query.setModel(normalizeModel(modelId) ?? undefined);
    }
    this.model = modelId;
    this.emit({ type: "model_changed", modelId });
  }

  async setMode(modeId: string): Promise<void> {
    assertClaudeMode(modeId);
    if (this.query) {
      await this.query.setPermissionMode(modeId);
    }
    this.mode = modeId;
    this.emit({ type: "mode_changed", modeId });
  }

  // -------------------------------------------------------------------------
  // query 生命周期
  // -------------------------------------------------------------------------

  private ensureQuery(): AsyncMessageInput<SDKUserMessage> {
    if (this.query && this.input) {
      return this.input;
    }
    const input = createAsyncMessageInput<SDKUserMessage>();
    const options = this.buildOptions();
    this.logger.info(
      "启动 Claude Code 会话（exe=%s, cwd=%s, model=%s, mode=%s, resume=%s）",
      this.executablePath,
      this.cwd,
      options.model ?? "default",
      this.mode,
      options.resume ?? "-",
    );
    const query = this.queryFn({ prompt: input.iterable, options });
    this.query = query;
    this.input = input;
    void this.pump(query, input);
    return input;
  }

  private buildOptions(): Options {
    const model = normalizeModel(this.model);
    return {
      cwd: this.cwd,
      includePartialMessages: true,
      permissionMode: this.mode,
      // 允许会话中途切换到 bypassPermissions（只是放行该模式，不改变当前模式）
      allowDangerouslySkipPermissions: true,
      canUseTool: this.handleCanUseTool,
      pathToClaudeCodeExecutable: this.executablePath,
      spawnClaudeCodeProcess: this.spawnClaudeProcess,
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project", "local"],
      stderr: this.handleStderr,
      env: { ...this.env },
      ...(model ? { model } : {}),
      ...(this.sessionId ? { resume: this.sessionId } : {}),
    };
  }

  private readonly spawnClaudeProcess = (spawnOptions: ClaudeSpawnOptions): SpawnedProcess => {
    // pathToClaudeCodeExecutable 指向 cli.js 时 SDK 会给出 "node"/"bun"，换成当前 node，避免依赖 PATH
    const command =
      spawnOptions.command === "node" || spawnOptions.command === "bun"
        ? process.execPath
        : spawnOptions.command;
    const child = spawnProcess(command, [...spawnOptions.args], {
      ...(spawnOptions.cwd ? { cwd: spawnOptions.cwd } : {}),
      env: spawnOptions.env,
      stdio: ["pipe", "pipe", "pipe"],
      // 绕过 cmd.exe：SDK 会传 --mcp-config 等内联 JSON 参数，经过 cmd.exe 会被破坏
      shell: false,
      ...(spawnOptions.signal ? { signal: spawnOptions.signal } : {}),
    });
    this.child = child;
    child.stderr?.on("data", (chunk: Buffer | string) => this.handleStderr(chunk.toString()));
    child.once("exit", (code, signal) => {
      this.logger.debug("Claude Code 进程退出（code=%s, signal=%s）", code, signal);
      if (this.child === child) {
        this.child = null;
      }
    });
    if (!child.stdin || !child.stdout) {
      throw new Error("Claude Code 进程缺少 stdio 管道");
    }
    return child as unknown as SpawnedProcess;
  };

  private readonly handleStderr = (data: string): void => {
    const text = data.trim();
    if (text) {
      this.logger.info("[claude stderr] %s", text);
    }
  };

  private async pump(
    query: ClaudeQueryHandle,
    input: AsyncMessageInput<SDKUserMessage>,
  ): Promise<void> {
    let failure: string | null = null;
    try {
      for await (const message of query) {
        if (this.query !== query) {
          break;
        }
        try {
          this.handleMessage(message);
        } catch (error) {
          this.logger.error("处理 Claude 消息出错：%s", errorMessage(error));
        }
      }
    } catch (error) {
      failure = errorMessage(error);
    }

    if (this.query !== query) {
      return; // 已被 teardown / 重建
    }
    this.query = null;
    this.input = null;
    input.end();
    if (this.closed) {
      return;
    }
    if (failure) {
      this.logger.warn("Claude Code 消息流异常结束：%s", failure);
    }
    const turn = this.activeTurn;
    if (turn) {
      this.denyAllPendingPermissions("Claude Code 进程已退出");
      this.cancelRunningTools(turn.turnId);
      this.finishTurn(turn, {
        type: "turn_failed",
        turnId: turn.turnId,
        error: failure ? `Claude Code 异常退出：${failure}` : "Claude Code 进程意外结束",
      });
    }
  }

  private async teardownQuery(): Promise<void> {
    const query = this.query;
    const input = this.input;
    const child = this.child;
    this.query = null;
    this.input = null;
    this.child = null;
    input?.end();
    if (child) {
      await this.terminateProcess(child, {
        gracefulTimeoutMs: KILL_GRACEFUL_TIMEOUT_MS,
        forceTimeoutMs: KILL_FORCE_TIMEOUT_MS,
      }).catch((error: unknown) => {
        this.logger.warn("结束 Claude Code 进程树失败：%s", errorMessage(error));
      });
    }
    try {
      query?.close();
    } catch (error) {
      this.logger.debug("关闭 Claude query 出错：%s", errorMessage(error));
    }
  }

  // -------------------------------------------------------------------------
  // 事件翻译
  // -------------------------------------------------------------------------

  private handleMessage(message: SDKMessage): void {
    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          this.captureSession(message.session_id);
        }
        return;
      case "stream_event":
        if (message.parent_tool_use_id) {
          return; // 子代理内部输出不进主时间线
        }
        this.handleStreamEvent(message.event as unknown as StreamEventLike);
        return;
      case "assistant":
        if (message.parent_tool_use_id) {
          return;
        }
        this.captureSession(message.session_id);
        this.handleAssistantMessage(message.message as unknown as AssistantMessageLike);
        return;
      case "user":
        if (message.parent_tool_use_id) {
          return;
        }
        this.handleUserMessage(message);
        return;
      case "result":
        this.handleResult(message);
        return;
      default:
        return;
    }
  }

  private captureSession(sessionId: string | undefined): void {
    if (!sessionId) {
      return;
    }
    this.sessionId = sessionId;
    if (!this.threadStarted) {
      this.threadStarted = true;
      this.emit({ type: "thread_started", sessionId });
    }
  }

  private handleStreamEvent(event: StreamEventLike): void {
    switch (event.type) {
      case "message_start": {
        this.currentStreamMessageId = event.message?.id ?? null;
        const usage = event.message?.usage;
        if (usage) {
          this.contextInputTokens =
            toCount(usage.input_tokens) +
            toCount(usage.cache_creation_input_tokens) +
            toCount(usage.cache_read_input_tokens);
          this.contextOutputTokens = 0;
        }
        return;
      }
      case "message_delta":
        if (event.usage?.output_tokens !== undefined) {
          this.contextOutputTokens = toCount(event.usage.output_tokens);
        }
        return;
      case "content_block_delta": {
        const turn = this.activeTurn;
        const delta = event.delta;
        if (!turn || !delta) {
          return;
        }
        const messageId = this.currentStreamMessageId;
        if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
          if (messageId) this.streamedText.add(messageId);
          this.emitTimeline(turn, {
            type: "assistant_message",
            text: delta.text,
            ...(messageId ? { messageId } : {}),
          });
        } else if (
          delta.type === "thinking_delta" &&
          typeof delta.thinking === "string" &&
          delta.thinking
        ) {
          if (messageId) this.streamedThinking.add(messageId);
          this.emitTimeline(turn, { type: "reasoning", text: delta.thinking });
        }
        return;
      }
      default:
        return;
    }
  }

  private handleAssistantMessage(message: AssistantMessageLike): void {
    const turn = this.activeTurn;
    if (!turn || !Array.isArray(message.content)) {
      return;
    }
    const messageId = typeof message.id === "string" ? message.id : null;
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          if (typeof block.text === "string" && block.text && !this.wasStreamed(this.streamedText, messageId)) {
            this.emitTimeline(turn, {
              type: "assistant_message",
              text: block.text,
              ...(messageId ? { messageId } : {}),
            });
          }
          break;
        case "thinking":
          if (
            typeof block.thinking === "string" &&
            block.thinking &&
            !this.wasStreamed(this.streamedThinking, messageId)
          ) {
            this.emitTimeline(turn, { type: "reasoning", text: block.thinking });
          }
          break;
        case "tool_use":
        case "server_tool_use":
        case "mcp_tool_use":
          this.handleToolUse(turn, block);
          break;
        default:
          break;
      }
    }
  }

  private wasStreamed(set: Set<string>, messageId: string | null): boolean {
    return messageId !== null && set.has(messageId);
  }

  private handleToolUse(turn: ActiveTurn, block: ContentBlockLike): void {
    const callId = typeof block.id === "string" ? block.id : null;
    const name = typeof block.name === "string" ? block.name : null;
    if (!callId || !name || this.toolUses.has(callId)) {
      return;
    }
    const input = block.input ?? null;
    if (name === "TodoWrite") {
      this.toolUses.set(callId, { name, input, hidden: true });
      const items = parseTodoItems(input);
      if (items) {
        this.emitTimeline(turn, { type: "todo", items });
      }
      return;
    }
    this.toolUses.set(callId, { name, input, hidden: false });
    const item = mapClaudeRunningToolCall({ callId, name, input });
    if (item) {
      this.emitTimeline(turn, item);
    }
  }

  private handleUserMessage(message: SDKUserMessage): void {
    const turn = this.activeTurn;
    const content = message.message.content;
    if (!turn || !Array.isArray(content)) {
      return;
    }
    const results = (content as unknown as ContentBlockLike[]).filter(
      (block) => block.type === "tool_result" || block.type === "mcp_tool_result",
    );
    // SDK 的 tool_use_result 是单个工具的结构化输出，只有一条结果时才能对应上
    const structured = results.length === 1 ? message.tool_use_result : undefined;
    for (const block of results) {
      this.handleToolResult(turn, block, structured);
    }
  }

  private handleToolResult(turn: ActiveTurn, block: ContentBlockLike, structured: unknown): void {
    const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
    if (!callId) {
      return;
    }
    const entry = this.toolUses.get(callId);
    this.toolUses.delete(callId);
    if (entry?.hidden) {
      return;
    }
    const name = entry?.name ?? "tool";
    const input = entry?.input ?? null;
    const text = toolResultText(block.content);
    const item =
      block.is_error === true
        ? mapClaudeFailedToolCall({
            callId,
            name,
            input,
            output: null,
            error: text || "工具调用失败",
          })
        : mapClaudeCompletedToolCall({
            callId,
            name,
            input,
            outputCandidates: buildOutputCandidates(name, text, structured),
          });
    if (item) {
      this.emitTimeline(turn, item);
    }
  }

  private handleResult(message: SDKResultMessage): void {
    const turn = this.activeTurn;
    if (!turn) {
      return; // 已中断的回合或自发回合的 result
    }
    const echoedUuid = message.user_message_uuid;
    if (echoedUuid && echoedUuid !== turn.userMessageUuid) {
      this.logger.debug("忽略非当前回合的 Claude result（uuid=%s）", echoedUuid);
      return;
    }
    this.captureSession(message.session_id);

    const usage = this.convertUsage(message);
    this.emit({ type: "usage_updated", usage });
    this.cancelRunningTools(turn.turnId);

    if (message.subtype === "success" && !message.is_error) {
      this.finishTurn(turn, { type: "turn_completed", turnId: turn.turnId, usage });
      return;
    }
    this.finishTurn(turn, {
      type: "turn_failed",
      turnId: turn.turnId,
      error: resultErrorText(message),
      code: message.subtype,
    });
  }

  private convertUsage(message: SDKResultMessage): AgentUsage {
    const usage = message.usage as unknown as Record<string, unknown> | undefined;
    const cacheRead = toCount(usage?.cache_read_input_tokens);
    const cacheCreation = toCount(usage?.cache_creation_input_tokens);
    const input = toCount(usage?.input_tokens);
    const result: AgentUsage = {
      inputTokens: input + cacheRead + cacheCreation,
      cachedInputTokens: cacheRead,
      outputTokens: toCount(usage?.output_tokens),
    };
    if (typeof message.total_cost_usd === "number") {
      result.totalCostUsd = message.total_cost_usd;
    }
    const contextWindow = Math.max(
      0,
      ...Object.values(message.modelUsage ?? {}).map((entry) => toCount(entry?.contextWindow)),
    );
    if (contextWindow > 0) {
      result.contextWindowMaxTokens = contextWindow;
    }
    const used = this.contextInputTokens + this.contextOutputTokens;
    if (used > 0) {
      result.contextWindowUsedTokens = used;
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // 权限
  // -------------------------------------------------------------------------

  private readonly handleCanUseTool: CanUseTool = async (toolName, input, options) => {
    const turn = this.activeTurn;
    if (this.closed || !turn) {
      return { behavior: "deny", message: "当前没有进行中的回合" };
    }
    const requestId = `perm-${randomUUID()}`;
    const isPlan = toolName === "ExitPlanMode";
    const detail: ToolCallDetail | undefined = isPlan
      ? { type: "plan", text: typeof input.plan === "string" ? input.plan : "" }
      : mapClaudeRunningToolCall({
          callId: options.toolUseID || requestId,
          name: toolName,
          input,
        })?.detail;
    const description = options.description ?? options.decisionReason;
    const request: AgentPermissionRequest = {
      id: requestId,
      provider: CLAUDE_PROVIDER_ID,
      name: toolName,
      kind: isPlan ? "plan" : "tool",
      title: isPlan ? "批准执行计划？" : (options.title ?? `允许使用 ${options.displayName ?? toolName}？`),
      ...(description ? { description } : {}),
      input,
      ...(detail ? { detail } : {}),
      actions: (isPlan ? PLAN_PERMISSION_ACTIONS : TOOL_PERMISSION_ACTIONS).map((action) => ({
        ...action,
      })),
    };

    return new Promise<PermissionResult>((resolve) => {
      const onAbort = () => {
        if (!this.pendingPermissions.delete(requestId)) {
          return;
        }
        const message = "权限请求已取消";
        this.emit({
          type: "permission_resolved",
          requestId,
          response: { behavior: "deny", message },
        });
        resolve({ behavior: "deny", message });
      };
      const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
      this.pendingPermissions.set(requestId, { request, input, resolve, cleanup });
      this.emit({ type: "permission_requested", turnId: turn.turnId, request });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  private denyAllPendingPermissions(message: string): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      this.pendingPermissions.delete(requestId);
      pending.cleanup();
      this.emit({ type: "permission_resolved", requestId, response: { behavior: "deny", message } });
      pending.resolve({ behavior: "deny", message });
    }
  }

  // -------------------------------------------------------------------------
  // 工具
  // -------------------------------------------------------------------------

  private cancelRunningTools(turnId: string): void {
    for (const [callId, entry] of this.toolUses) {
      if (entry.hidden) {
        continue;
      }
      const item = mapClaudeCanceledToolCall({ callId, name: entry.name, input: entry.input });
      if (item) {
        this.emit({ type: "timeline", turnId, item });
      }
    }
    this.toolUses.clear();
  }

  private finishTurn(turn: ActiveTurn, event: AgentStreamEvent): void {
    if (this.activeTurn !== turn) {
      return;
    }
    this.activeTurn = null;
    this.streamedText.clear();
    this.streamedThinking.clear();
    this.emit(event);
  }

  private emitTimeline(turn: ActiveTurn, item: AgentTimelineItem): void {
    this.emit({ type: "timeline", turnId: turn.turnId, item });
  }

  private emit(event: AgentStreamEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error("Claude 会话事件监听器出错：%s", errorMessage(error));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

interface ContentBlockLike {
  type?: string;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  text?: unknown;
  thinking?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
}

interface AssistantMessageLike {
  id?: unknown;
  content?: ContentBlockLike[];
}

interface StreamEventLike {
  type: string;
  message?: {
    id?: string;
    usage?: {
      input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
      cache_read_input_tokens?: unknown;
    };
  };
  usage?: { output_tokens?: unknown };
  delta?: { type?: string; text?: unknown; thinking?: unknown };
}

export function buildClaudeChildEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const childEnv = createExternalProcessEnv(env) as Record<string, string>;
  for (const key of Object.keys(childEnv)) {
    if (PARENT_SESSION_ENV_VARS.includes(key.toUpperCase())) {
      delete childEnv[key];
    }
  }
  return childEnv;
}

function assertClaudeMode(modeId: string): asserts modeId is PermissionMode {
  if (!CLAUDE_MODES.some((mode) => mode.id === modeId)) {
    throw new Error(`Claude Code 不支持模式：${modeId}`);
  }
}

/** `default` / 空串 / null 表示不指定模型 */
function normalizeModel(modelId: string | null | undefined): string | null {
  const trimmed = modelId?.trim();
  if (!trimmed || trimmed === "default") {
    return null;
  }
  return trimmed;
}

type SdkContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
        data: string;
      };
    };

export function toSdkUserMessage(
  prompt: AgentPromptInput,
  sessionId: string | null,
): SDKUserMessage {
  const content: SdkContentBlock[] = [];
  if (typeof prompt === "string") {
    content.push({ type: "text", text: prompt });
  } else {
    for (const part of prompt) {
      if (part.type === "text") {
        content.push({ type: "text", text: part.text });
      } else if (SUPPORTED_IMAGE_TYPES.has(part.mimeType)) {
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: part.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
            data: part.data,
          },
        });
      } else {
        content.push({ type: "text", text: `[不支持的图片类型：${part.mimeType}]` });
      }
    }
  }
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    uuid: randomUUID() as SDKUserMessage["uuid"] & string,
    session_id: sessionId ?? "",
  };
}

function parseTodoItems(input: unknown): { text: string; completed: boolean }[] | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const todos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) {
    return null;
  }
  return todos.flatMap((todo) => {
    if (!todo || typeof todo !== "object") {
      return [];
    }
    const record = todo as { content?: unknown; status?: unknown };
    if (typeof record.content !== "string") {
      return [];
    }
    return [{ text: record.content, completed: record.status === "completed" }];
  });
}

/** tool_result.content 可能是字符串或块数组；只取文本，图片等丢弃 */
function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && (block as { type?: unknown }).type === "text"
          ? String((block as { text?: unknown }).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * 工具输出候选：shell / read 等用文本（结构化 tool_use_result 的字段名与 shared schema 不一致），
 * search / fetch 优先用 SDK 的结构化输出（Glob/Grep/WebFetch/WebSearch 的 Output 与 schema 吻合）。
 */
function buildOutputCandidates(name: string, text: string, structured: unknown): unknown[] {
  const structuredCandidate =
    structured !== null && typeof structured === "object" ? [structured] : [];
  const textCandidates = text ? [text, { output: text }] : [];
  const kind = resolveClaudeToolKind(name);
  const ordered =
    kind === "search" || kind === "fetch"
      ? [...structuredCandidate, ...textCandidates]
      : [...textCandidates, ...structuredCandidate];
  return [...ordered, null];
}

function resultErrorText(message: SDKResultMessage): string {
  if (message.subtype === "success") {
    return message.result?.trim() || "Claude Code 返回了错误";
  }
  const errors = message.errors?.filter((entry) => entry.trim().length > 0) ?? [];
  if (errors.length > 0) {
    return errors.join("\n");
  }
  switch (message.subtype) {
    case "error_max_turns":
      return "已达到最大轮次限制";
    case "error_max_budget_usd":
      return "已达到预算上限";
    case "error_during_execution":
      return "Claude Code 执行过程中出错";
    default:
      return `Claude Code 执行失败（${message.subtype}）`;
  }
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Derived from paseo createAsyncMessageInput（agent.ts）：可推送的异步迭代器，作为 streaming input
function createAsyncMessageInput<T>(): AsyncMessageInput<T> {
  const queue: T[] = [];
  const resolvers: Array<(value: IteratorResult<T, void>) => void> = [];
  let closed = false;

  return {
    push(item: T) {
      if (closed) {
        return;
      }
      const resolve = resolvers.shift();
      if (resolve) {
        resolve({ value: item, done: false });
        return;
      }
      queue.push(item);
    },
    end() {
      closed = true;
      while (resolvers.length > 0) {
        resolvers.shift()?.({ value: undefined, done: true });
      }
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<T, void> {
        return {
          next: (): Promise<IteratorResult<T, void>> => {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift() as T, done: false });
            }
            if (closed) {
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise<IteratorResult<T, void>>((resolve) => {
              resolvers.push(resolve);
            });
          },
        };
      },
    },
  };
}
