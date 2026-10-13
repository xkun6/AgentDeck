// Derived from paseo packages/server/src/server/agent/providers/acp-agent.ts (Apache-2.0); modified for AgentDeck
// 改动：只保留 AgentDeck 需要的会话能力（无 terminal / fs 客户端能力、无历史导入、无 config option 回退；
// configOptions 只用 thought_level 一项做思考强度，design.md 4.10），
// 事件收敛到 AgentDeck 精简协议；SDK 在连接关闭时不会拒绝挂起请求，这里用进程退出 Promise 兜底。
import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type PermissionOption,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionModelState,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type {
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentProviderId,
  AgentStreamEvent,
  AgentUsage,
} from "@agentdeck/protocol";

import packageJson from "../../../package.json" with { type: "json" };
import { AgentRpcError } from "../../agent/errors.js";
import type { AgentSession } from "../../agent/types.js";
import type { Logger } from "../../logger.js";
import { spawnProcess } from "../../utils/spawn.js";
import { terminateWithTreeKill } from "../../utils/tree-kill.js";
import {
  ACP_PLACEHOLDER_MODEL_ID,
  findThoughtLevel,
  fromAcpUsage,
  fromAcpUsageUpdate,
  mergeToolSnapshot,
  mapToolDetail,
  permissionActions,
  planToTodo,
  selectPermissionOption,
  textFromContentBlock,
  toAcpPrompt,
  toAgentModes,
  toModelDefinitions,
  toolSnapshotToTimelineItem,
  type AcpToolSnapshot,
} from "./acp-mapping.js";
import { createTolerantNdJsonStream } from "./ndjson-stream.js";
import {
  normalizeThinkingOptionId,
  THINKING_APPLIES_NEXT_TURN_NOTICE,
} from "../shared/thinking-options.js";

/** 启动（spawn + initialize + newSession/loadSession）总超时；npx 首次运行需要下载包，放宽到 2 分钟 */
export const ACP_START_TIMEOUT_MS = 120_000;
/** interrupt 发出 cancel 后等待 prompt 结束的上限 */
export const ACP_INTERRUPT_WAIT_MS = 5_000;
const STDERR_TAIL_LIMIT = 2_000;
const METHOD_NOT_FOUND = -32601;

export interface AcpLaunchSpec {
  provider: AgentProviderId;
  label: string;
  /** 解析后的可执行文件路径 */
  executable: string;
  args: string[];
  envOverlay?: Record<string, string>;
}

export type AcpSessionInit =
  | { type: "new"; model?: string; modeId?: string; thinkingOptionId?: string | null }
  | { type: "load"; sessionId: string };

export interface AcpSessionStartOptions {
  spec: AcpLaunchSpec;
  cwd: string;
  logger: Logger;
  env: NodeJS.ProcessEnv;
  init: AcpSessionInit;
}

interface ActiveTurn {
  turnId: string;
  cancelRequested: boolean;
  finished: boolean;
  done: Promise<void>;
  resolveDone: () => void;
  toolCallIds: Set<string>;
  /** agent 未提供 messageId 时，同一段连续文本共用的兜底 id */
  fallbackMessageId: string | null;
}

interface PendingPermission {
  request: AgentPermissionRequest;
  options: PermissionOption[];
  resolve: (response: RequestPermissionResponse) => void;
}

const CANCELLED_OUTCOME: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

export class AcpAgentSession implements AgentSession {
  readonly provider: AgentProviderId;

  private readonly logger: Logger;
  private readonly label: string;
  private readonly listeners = new Set<(event: AgentStreamEvent) => void>();
  private readonly toolCalls = new Map<string, AcpToolSnapshot>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();

  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientSideConnection | null = null;
  private exited: Promise<string> = new Promise(() => undefined);
  private stderrTail = "";

  private sessionId: string | null = null;
  private agentCapabilities: AgentCapabilities | null = null;
  private modes: SessionModeState | null = null;
  private models: SessionModelState | null = null;
  private defaultModelId: string | null = null;
  private configOptions: SessionConfigOption[] | null = null;
  /** 建会话时 thought_level 的 currentValue：思考强度设回 null（跟随 Agent）时恢复成它 */
  private defaultThoughtValue: string | null = null;
  private usage: AgentUsage = {};

  private active: ActiveTurn | null = null;
  private threadStartedEmitted = false;
  private loadingHistory = false;
  private dead = false;
  private closed = false;

  private constructor(spec: AcpLaunchSpec, logger: Logger) {
    this.provider = spec.provider;
    this.label = spec.label;
    this.logger = logger;
  }

  /** spawn 子进程并完成 initialize + newSession / loadSession；失败时清理进程并抛错 */
  static async start(options: AcpSessionStartOptions): Promise<AcpAgentSession> {
    const session = new AcpAgentSession(options.spec, options.logger);
    try {
      await session.boot(options);
    } catch (error) {
      await session.close();
      throw error;
    }
    return session;
  }

  get id(): string | null {
    return this.sessionId;
  }

  /** newSession / loadSession 返回的模型与模式（ACP 只能在建会话后得知） */
  catalog(): { models: AgentModelDefinition[]; modes: AgentMode[] } {
    const thought = findThoughtLevel(this.configOptions);
    return {
      models: toModelDefinitions(
        this.provider,
        this.models?.availableModels,
        this.defaultModelId,
        thought ? { options: thought.options, defaultId: this.defaultThoughtValue } : null,
      ),
      modes: toAgentModes(this.modes?.availableModes),
    };
  }

  get currentModeId(): string | null {
    return this.modes?.currentModeId ?? null;
  }

  get currentModelId(): string | null {
    return this.models?.currentModelId ?? null;
  }

  // -------------------------------------------------------------------------
  // AgentSession
  // -------------------------------------------------------------------------

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    const { connection, sessionId } = this.requireUsable();
    if (this.active) {
      throw new AgentRpcError("TURN_IN_PROGRESS", "该 ACP 会话正在执行中");
    }
    const blocks = toAcpPrompt(prompt, this.agentCapabilities?.promptCapabilities, () =>
      this.logger.warn("[%s] agent 未声明图片输入能力，已丢弃 prompt 中的图片", this.provider),
    );
    if (blocks.length === 0) {
      throw new Error("prompt 为空（图片已被丢弃且没有文本）");
    }

    let resolveDone!: () => void;
    const turn: ActiveTurn = {
      turnId: randomUUID(),
      cancelRequested: false,
      finished: false,
      done: new Promise<void>((resolve) => {
        resolveDone = resolve;
      }),
      resolveDone: () => resolveDone(),
      toolCallIds: new Set(),
      fallbackMessageId: null,
    };
    this.active = turn;

    if (!this.threadStartedEmitted) {
      this.threadStartedEmitted = true;
      this.emit({ type: "thread_started", sessionId });
    }
    this.emit({ type: "turn_started", turnId: turn.turnId });

    connection.prompt({ sessionId, prompt: blocks }).then(
      (response) => this.onPromptResolved(turn, response),
      (error: unknown) => this.onPromptRejected(turn, error),
    );
    return { turnId: turn.turnId };
  }

  subscribe(cb: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return Array.from(this.pendingPermissions.values(), (entry) => entry.request);
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      throw new AgentRpcError("PERMISSION_NOT_FOUND", `找不到待处理的权限请求：${requestId}`);
    }
    const option = selectPermissionOption(pending.options, response);
    if (option === undefined) {
      throw new Error(`权限选项不存在：${response.selectedActionId}`);
    }

    this.pendingPermissions.delete(requestId);
    this.emit({ type: "permission_resolved", requestId, response });
    pending.resolve(
      option ? { outcome: { outcome: "selected", optionId: option.optionId } } : CANCELLED_OUTCOME,
    );

    if (response.behavior === "deny" && response.interrupt) {
      await this.interrupt();
    }
  }

  async interrupt(): Promise<void> {
    const turn = this.active;
    if (!turn || turn.finished) {
      return;
    }
    if (!turn.cancelRequested) {
      turn.cancelRequested = true;
      this.cancelPendingPermissions();
      if (this.connection && this.sessionId && !this.dead) {
        try {
          await this.connection.cancel({ sessionId: this.sessionId });
        } catch (error) {
          this.logger.warn("[%s] 发送 cancel 失败：%s", this.provider, errorMessage(error));
        }
      }
    }

    let timer: NodeJS.Timeout | undefined;
    const ended = await Promise.race([
      turn.done.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ACP_INTERRUPT_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!ended) {
      this.logger.warn("[%s] cancel 后 %dms 内 prompt 未结束，强制结束回合", this.provider, ACP_INTERRUPT_WAIT_MS);
      this.finishTurn(turn, { type: "turn_canceled", turnId: turn.turnId, reason: "interrupted" });
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const turn = this.active;
    if (turn) {
      this.finishTurn(turn, { type: "turn_canceled", turnId: turn.turnId, reason: "closed" });
    }
    this.cancelPendingPermissions();

    const child = this.child;
    if (child) {
      try {
        child.stdin.end();
      } catch {
        // 进程可能已退出
      }
      try {
        await terminateWithTreeKill(child, { gracefulTimeoutMs: 1_000, forceTimeoutMs: 2_000 });
      } catch (error) {
        this.logger.warn("[%s] 结束 ACP 子进程失败：%s", this.provider, errorMessage(error));
      }
    }
    this.listeners.clear();
  }

  describePersistence(): AgentPersistenceHandle | null {
    return this.sessionId ? { provider: this.provider, sessionId: this.sessionId } : null;
  }

  async setModel(modelId: string | null): Promise<void> {
    const { connection, sessionId } = this.requireUsable();
    if (this.usesPlaceholderModel() && (modelId === null || modelId === ACP_PLACEHOLDER_MODEL_ID)) {
      // agent 没有模型列表：占位模型即「不指定」，无需通知 agent
      this.emit({ type: "model_changed", modelId });
      return;
    }
    const target = modelId ?? this.defaultModelId;
    if (!target) {
      throw new AgentRpcError("NOT_SUPPORTED", `${this.label} 未提供默认模型，无法恢复默认`);
    }
    if (typeof connection.unstable_setSessionModel !== "function") {
      this.logger.warn("[%s] 当前 ACP SDK 不支持 unstable_setSessionModel", this.provider);
      throw new AgentRpcError("NOT_SUPPORTED", `${this.label} 不支持切换模型`);
    }
    try {
      await this.raceExit(connection.unstable_setSessionModel({ sessionId, modelId: target }));
    } catch (error) {
      this.logger.warn("[%s] 切换模型 %s 失败：%s", this.provider, target, errorMessage(error));
      throw new AgentRpcError("NOT_SUPPORTED", `${this.label} 不支持切换模型：${errorMessage(error)}`);
    }
    if (this.models) {
      this.models = { ...this.models, currentModelId: target };
    }
    this.emit({ type: "model_changed", modelId });
  }

  async setMode(modeId: string): Promise<void> {
    const { connection, sessionId } = this.requireUsable();
    try {
      await this.raceExit(connection.setSessionMode({ sessionId, modeId }));
    } catch (error) {
      this.logger.warn("[%s] 切换模式 %s 失败：%s", this.provider, modeId, errorMessage(error));
      if (errorCode(error) === METHOD_NOT_FOUND) {
        throw new AgentRpcError("NOT_SUPPORTED", `${this.label} 不支持切换模式`);
      }
      throw new Error(`切换模式失败：${errorMessage(error)}`);
    }
    if (this.modes) {
      this.modes = { ...this.modes, currentModeId: modeId };
    }
    this.emit({ type: "mode_changed", modeId });
  }

  /**
   * design.md 4.10：经 session/set_config_option 设置 thought_level；null 时设回建会话时的值。
   * agent 一般在下一次 prompt 才按新档位思考，运行中切换返回提示。
   */
  async setThinking(thinkingOptionId: string | null): Promise<{ notice?: string }> {
    const { connection, sessionId } = this.requireUsable();
    const requested = normalizeThinkingOptionId(thinkingOptionId);
    const thought = findThoughtLevel(this.configOptions);
    if (!thought) {
      throw new AgentRpcError("NOT_SUPPORTED", `${this.label} 不支持切换思考强度`);
    }
    const target = requested ?? this.defaultThoughtValue;
    if (target !== null && !thought.options.some((option) => option.id === target)) {
      throw new Error(`${this.label} 不支持思考强度：${target}`);
    }
    if (target !== null && target !== thought.currentValue) {
      await this.writeThoughtLevel(connection, sessionId, thought.configId, target);
    }
    this.emit({ type: "thinking_option_changed", thinkingOptionId: requested });
    return this.active && !this.active.finished ? { notice: THINKING_APPLIES_NEXT_TURN_NOTICE } : {};
  }

  private async writeThoughtLevel(
    connection: ClientSideConnection,
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    try {
      const response = await this.raceExit(
        connection.setSessionConfigOption({ sessionId, configId, value }),
      );
      this.configOptions = response.configOptions ?? this.configOptions;
    } catch (error) {
      this.logger.warn("[%s] 设置思考强度 %s 失败：%s", this.provider, value, errorMessage(error));
      if (errorCode(error) === METHOD_NOT_FOUND) {
        throw new AgentRpcError("NOT_SUPPORTED", `${this.label} 不支持切换思考强度`);
      }
      throw new Error(`切换思考强度失败：${errorMessage(error)}`);
    }
    // 应答未带新的 configOptions 时本地记下新值
    this.setLocalThoughtValue(configId, value);
  }

  private setLocalThoughtValue(configId: string, value: string): void {
    const current = findThoughtLevel(this.configOptions);
    if (current && current.currentValue !== value) {
      this.configOptions = (this.configOptions ?? []).map((option) =>
        option.id === configId && option.type === "select" ? { ...option, currentValue: value } : option,
      );
    }
  }

  private usesPlaceholderModel(): boolean {
    return !this.models?.availableModels?.length && findThoughtLevel(this.configOptions) !== null;
  }

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------

  private async boot(options: AcpSessionStartOptions): Promise<void> {
    const { spec, cwd, init } = options;
    this.spawn(spec, cwd, options.env);
    const connection = this.connection!;
    const timeoutMs = ACP_START_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const step = <T>(promise: Promise<T>, label: string) =>
      this.raceExit(promise, { deadline, label, timeoutMs });

    const initialized = await step(
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "AgentDeck", version: packageJson.version },
      }),
      "initialize",
    );
    this.agentCapabilities = initialized.agentCapabilities ?? null;

    if (init.type === "load") {
      if (!this.agentCapabilities?.loadSession) {
        throw new AgentRpcError("NOT_SUPPORTED", `${spec.label} 不支持恢复会话（未声明 loadSession 能力）`);
      }
      this.sessionId = init.sessionId;
      this.loadingHistory = true;
      try {
        const loaded = await step(
          connection.loadSession({ sessionId: init.sessionId, cwd, mcpServers: [] }),
          "session/load",
        );
        this.applySessionState(loaded.modes, loaded.models, loaded.configOptions);
      } finally {
        this.loadingHistory = false;
      }
      return;
    }

    const created = await step(connection.newSession({ cwd, mcpServers: [] }), "session/new");
    this.sessionId = created.sessionId;
    this.applySessionState(created.modes, created.models, created.configOptions);

    if (init.modeId !== undefined && init.modeId !== this.currentModeId) {
      await step(
        connection.setSessionMode({ sessionId: created.sessionId, modeId: init.modeId }),
        "session/set_mode",
      );
      if (this.modes) {
        this.modes = { ...this.modes, currentModeId: init.modeId };
      }
    }
    const placeholderModel = this.usesPlaceholderModel() && init.model === ACP_PLACEHOLDER_MODEL_ID;
    if (init.model !== undefined && init.model !== this.currentModelId && !placeholderModel) {
      try {
        await step(
          connection.unstable_setSessionModel({ sessionId: created.sessionId, modelId: init.model }),
          "session/set_model",
        );
        if (this.models) {
          this.models = { ...this.models, currentModelId: init.model };
        }
      } catch (error) {
        // design.md 5.1：模型设置失败忽略，沿用 agent 默认模型
        this.logger.warn("[%s] 设置初始模型 %s 失败，沿用默认：%s", this.provider, init.model, errorMessage(error));
      }
    }
    const thinking = normalizeThinkingOptionId(init.thinkingOptionId);
    const thought = findThoughtLevel(this.configOptions);
    if (thinking !== null && thought && thinking !== thought.currentValue) {
      try {
        const response = await step(
          connection.setSessionConfigOption({
            sessionId: created.sessionId,
            configId: thought.configId,
            value: thinking,
          }),
          "session/set_config_option",
        );
        this.configOptions = response.configOptions ?? this.configOptions;
        this.setLocalThoughtValue(thought.configId, thinking);
      } catch (error) {
        // 与模型一致：失败只记日志，沿用 agent 默认档位
        this.logger.warn("[%s] 设置初始思考强度 %s 失败：%s", this.provider, thinking, errorMessage(error));
      }
    }
  }

  private spawn(spec: AcpLaunchSpec, cwd: string, env: NodeJS.ProcessEnv): void {
    this.logger.info(
      "[%s] 启动 ACP agent：%s %s（cwd=%s）",
      this.provider,
      spec.executable,
      spec.args.join(" "),
      cwd,
    );
    const child = spawnProcess(spec.executable, spec.args, {
      cwd,
      env,
      ...(spec.envOverlay ? { envOverlay: spec.envOverlay } : {}),
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    this.exited = new Promise<string>((resolve) => {
      child.once("error", (error) => resolve(`启动失败：${error.message}`));
      // 用 close 而非 exit：保证 stderr 已读完，错误信息里能带上崩溃输出
      child.once("close", (code, signal) => resolve(`code=${code ?? "null"}${signal ? `, signal=${signal}` : ""}`));
    });
    void this.exited.then((detail) => this.onProcessExit(detail));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) {
          this.logger.debug("[%s][stderr] %s", this.provider, line);
        }
      }
    });

    const stream = createTolerantNdJsonStream(child.stdout, child.stdin, {
      logger: this.logger,
      provider: this.provider,
    });
    this.connection = new ClientSideConnection(
      () => ({
        requestPermission: (params) => this.handlePermissionRequest(params),
        sessionUpdate: async (params) => this.handleSessionUpdate(params),
      }),
      stream,
    );
  }

  private applySessionState(
    modes: SessionModeState | null | undefined,
    models: SessionModelState | null | undefined,
    configOptions: SessionConfigOption[] | null | undefined,
  ): void {
    this.modes = modes ?? null;
    this.models = models ?? null;
    this.defaultModelId = models?.currentModelId ?? null;
    this.configOptions = configOptions ?? null;
    this.defaultThoughtValue = findThoughtLevel(this.configOptions)?.currentValue ?? null;
  }

  /** config_option_update：记下最新配置；thought_level 的当前值变了就同步思考强度 */
  private applyConfigOptionUpdate(configOptions: SessionConfigOption[], emit: boolean): void {
    const previous = findThoughtLevel(this.configOptions)?.currentValue ?? null;
    this.configOptions = configOptions;
    const next = findThoughtLevel(configOptions)?.currentValue ?? null;
    if (emit && next !== null && next !== previous) {
      this.emit({ type: "thinking_option_changed", thinkingOptionId: next });
    }
  }

  // -------------------------------------------------------------------------
  // agent → client
  // -------------------------------------------------------------------------

  private handleSessionUpdate(notification: SessionNotification): void {
    const update = notification.update;
    if (this.loadingHistory) {
      // loadSession 会重放历史；此时还没有订阅者，只记录模式
      if (update.sessionUpdate === "current_mode_update" && this.modes) {
        this.modes = { ...this.modes, currentModeId: update.currentModeId };
      }
      if (update.sessionUpdate === "config_option_update") {
        this.applyConfigOptionUpdate(update.configOptions, false);
      }
      return;
    }
    const turn = this.active && !this.active.finished ? this.active : null;
    const turnRef = turn ? { turnId: turn.turnId } : {};

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = textFromContentBlock(update.content);
        if (!text) {
          return;
        }
        let messageId = update.messageId ?? undefined;
        if (!messageId) {
          if (turn) {
            turn.fallbackMessageId ??= randomUUID();
            messageId = turn.fallbackMessageId;
          }
        } else if (turn) {
          turn.fallbackMessageId = null;
        }
        this.emit({
          type: "timeline",
          ...turnRef,
          item: { type: "assistant_message", text, ...(messageId ? { messageId } : {}) },
        });
        return;
      }
      case "agent_thought_chunk": {
        if (turn) {
          turn.fallbackMessageId = null;
        }
        const text = textFromContentBlock(update.content);
        if (text) {
          this.emit({ type: "timeline", ...turnRef, item: { type: "reasoning", text } });
        }
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        if (turn) {
          turn.fallbackMessageId = null;
          turn.toolCallIds.add(update.toolCallId);
        }
        const previous =
          update.sessionUpdate === "tool_call_update" ? this.toolCalls.get(update.toolCallId) : undefined;
        const snapshot = mergeToolSnapshot(update, previous);
        this.toolCalls.set(update.toolCallId, snapshot);
        this.emit({ type: "timeline", ...turnRef, item: toolSnapshotToTimelineItem(snapshot) });
        return;
      }
      case "plan":
        if (turn) {
          turn.fallbackMessageId = null;
        }
        this.emit({ type: "timeline", ...turnRef, item: planToTodo(update) });
        return;
      case "current_mode_update":
        if (this.modes) {
          this.modes = { ...this.modes, currentModeId: update.currentModeId };
        }
        this.emit({ type: "mode_changed", modeId: update.currentModeId });
        return;
      case "usage_update":
        this.usage = { ...this.usage, ...fromAcpUsageUpdate(update) };
        this.emit({ type: "usage_updated", usage: { ...this.usage } });
        return;
      case "config_option_update":
        this.applyConfigOptionUpdate(update.configOptions, true);
        return;
      default:
        // user_message_chunk（user_message 由 AgentManager 统一记录）、available_commands_update、
        // session_info_update：忽略
        return;
    }
  }

  private handlePermissionRequest(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const turn = this.active && !this.active.finished ? this.active : null;
    if (this.closed || this.dead || turn?.cancelRequested) {
      return Promise.resolve(CANCELLED_OUTCOME);
    }
    const toolCallId = params.toolCall.toolCallId;
    const snapshot = mergeToolSnapshot(params.toolCall, this.toolCalls.get(toolCallId));
    const rawInput = snapshot.rawInput;
    const request: AgentPermissionRequest = {
      id: randomUUID(),
      provider: this.provider,
      name: snapshot.kind ?? snapshot.title,
      kind: "tool",
      title: snapshot.title,
      ...(rawInput !== null && typeof rawInput === "object" && !Array.isArray(rawInput)
        ? { input: rawInput as Record<string, unknown> }
        : {}),
      detail: mapToolDetail(snapshot),
      actions: permissionActions(params.options),
    };
    return new Promise<RequestPermissionResponse>((resolve) => {
      this.pendingPermissions.set(request.id, { request, options: params.options, resolve });
      this.emit({
        type: "permission_requested",
        ...(turn ? { turnId: turn.turnId } : {}),
        request,
      });
    });
  }

  // -------------------------------------------------------------------------
  // 回合收尾
  // -------------------------------------------------------------------------

  private onPromptResolved(turn: ActiveTurn, response: PromptResponse): void {
    if (turn.finished) {
      return;
    }
    if (response.usage) {
      this.usage = { ...this.usage, ...fromAcpUsage(response.usage) };
    }
    const { turnId } = turn;
    if (turn.cancelRequested || response.stopReason === "cancelled") {
      this.finishTurn(turn, { type: "turn_canceled", turnId, reason: "interrupted" });
      return;
    }
    if (response.stopReason === "refusal") {
      this.finishTurn(turn, {
        type: "turn_failed",
        turnId,
        error: `${this.label} 拒绝了该请求（stopReason=refusal）`,
        code: "REFUSAL",
      });
      return;
    }
    // end_turn / max_tokens / max_turn_requests：正常结束
    const usage = Object.keys(this.usage).length > 0 ? { ...this.usage } : undefined;
    this.finishTurn(turn, { type: "turn_completed", turnId, ...(usage ? { usage } : {}) });
  }

  private onPromptRejected(turn: ActiveTurn, error: unknown): void {
    if (turn.finished) {
      return;
    }
    if (turn.cancelRequested) {
      this.finishTurn(turn, { type: "turn_canceled", turnId: turn.turnId, reason: "interrupted" });
      return;
    }
    const code = errorCode(error);
    this.finishTurn(turn, {
      type: "turn_failed",
      turnId: turn.turnId,
      error: errorMessage(error),
      ...(code !== undefined ? { code: `ACP_${code}` } : {}),
    });
  }

  private onProcessExit(detail: string): void {
    this.dead = true;
    if (this.closed) {
      return;
    }
    this.logger.warn("[%s] ACP agent 进程退出（%s）", this.provider, detail);
    const turn = this.active;
    if (turn && !turn.finished) {
      if (turn.cancelRequested) {
        this.finishTurn(turn, { type: "turn_canceled", turnId: turn.turnId, reason: "interrupted" });
      } else {
        const stderr = this.stderrTail.trim();
        this.finishTurn(turn, {
          type: "turn_failed",
          turnId: turn.turnId,
          error: `${this.label} 进程意外退出（${detail}）${stderr ? `：${stderr}` : ""}`,
          code: "PROCESS_EXITED",
        });
      }
    } else {
      this.cancelPendingPermissions();
    }
  }

  /** 发且只发一次终态事件；未完成的工具调用标记为 canceled / failed */
  private finishTurn(turn: ActiveTurn, event: AgentStreamEvent): void {
    if (turn.finished) {
      return;
    }
    turn.finished = true;
    if (this.active === turn) {
      this.active = null;
    }
    this.cancelPendingPermissions();
    if (event.type === "turn_canceled" || event.type === "turn_failed") {
      const status = event.type === "turn_canceled" ? "canceled" : "failed";
      for (const toolCallId of turn.toolCallIds) {
        const snapshot = this.toolCalls.get(toolCallId);
        if (snapshot && snapshot.status !== "completed" && snapshot.status !== "failed") {
          this.emit({
            type: "timeline",
            turnId: turn.turnId,
            item: toolSnapshotToTimelineItem(snapshot, status),
          });
        }
      }
    }
    this.emit(event);
    turn.resolveDone();
  }

  /** 挂起的权限请求一律回 cancelled，并发 permission_resolved */
  private cancelPendingPermissions(): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      this.pendingPermissions.delete(requestId);
      this.emit({
        type: "permission_resolved",
        requestId,
        response: { behavior: "deny", message: "回合已取消", interrupt: true },
      });
      pending.resolve(CANCELLED_OUTCOME);
    }
  }

  // -------------------------------------------------------------------------
  // 小工具
  // -------------------------------------------------------------------------

  private emit(event: AgentStreamEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error("[%s] 事件监听器出错：%s", this.provider, errorMessage(error));
      }
    }
  }

  private requireUsable(): { connection: ClientSideConnection; sessionId: string } {
    if (this.closed) {
      throw new AgentRpcError("AGENT_CLOSED", `${this.label} 会话已关闭`);
    }
    if (this.dead || !this.connection || !this.sessionId) {
      throw new AgentRpcError("PROVIDER_UNAVAILABLE", `${this.label} 进程已退出，请新建会话`);
    }
    return { connection: this.connection, sessionId: this.sessionId };
  }

  /**
   * SDK 在连接关闭时不会拒绝挂起的请求，所以和进程退出赛跑；启动阶段另有总超时。
   */
  private async raceExit<T>(
    promise: Promise<T>,
    timeout?: { deadline: number; label: string; timeoutMs: number },
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const contenders: Array<Promise<T>> = [
      promise,
      this.exited.then((detail) => {
        const stderr = this.stderrTail.trim();
        throw new Error(`${this.label} 进程已退出（${detail}）${stderr ? `：${stderr}` : ""}`);
      }),
    ];
    if (timeout) {
      contenders.push(
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${this.label} 启动超时（${timeout.label}，${timeout.timeoutMs}ms）`)),
            Math.max(0, timeout.deadline - Date.now()),
          );
        }),
      );
    }
    try {
      return await Promise.race(contenders);
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new AcpRequestError(errorMessage(error), errorCode(error));
    } finally {
      clearTimeout(timer);
    }
  }
}

/** ACP 请求失败（把 SDK 拒绝的 JSON-RPC error 对象包装成 Error，保留数字错误码） */
export class AcpRequestError extends Error {
  readonly code: number | undefined;

  constructor(message: string, code: number | undefined) {
    super(message);
    this.name = "AcpRequestError";
    this.code = code;
  }
}

/** SDK 拒绝时给的是 JSON-RPC error 对象（非 Error），统一取 message */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error !== null && typeof error === "object") {
    const record = error as { message?: unknown; data?: unknown };
    if (typeof record.message === "string") {
      const data = record.data;
      const details =
        data && typeof data === "object" && typeof (data as { details?: unknown }).details === "string"
          ? `（${(data as { details: string }).details}）`
          : "";
      return `${record.message}${details}`;
    }
  }
  return String(error);
}

function errorCode(error: unknown): number | undefined {
  if (error !== null && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number") {
      return code;
    }
  }
  return undefined;
}
