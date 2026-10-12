// Derived from paseo packages/server/src/server/agent/providers/claude/agent.ts and query.ts (Apache-2.0); modified for AgentDeck
// 大幅精简：一个会话一个长生命周期 claude 子进程（stream-json stdio 协议，见 claude-cli-session.ts），每轮写一条用户消息；
// 只保留 AgentDeck 协议需要的事件翻译、权限中转、中断、模型/模式切换与 tree-kill 关闭。
// 去掉了 paseo 的子代理侧链、steer、rewind、历史回放、快速模式、思考预算等功能。
// AgentDeck 改动：不再依赖 Anthropic 的 Agent SDK，直接 spawn 用户本机安装的 claude 可执行文件。
import { randomUUID } from "node:crypto";
import os from "node:os";

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
import { AgentRpcError } from "../../agent/errors.js";
import type { Logger } from "../../logger.js";
import { createExternalProcessEnv } from "../../utils/process-env.js";
import { withTimeout } from "../../utils/promise-timeout.js";
import type { ProcessTerminator } from "../../utils/tree-kill.js";
import {
  createClaudeCliSession,
  type ClaudeCliFactory,
  type ClaudeCliHandle,
} from "./claude-cli-session.js";
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
import type {
  ClaudeAssistantMessage,
  ClaudeCanUseTool,
  ClaudeContentBlock,
  ClaudeImageMediaType,
  ClaudeInitializeResponse,
  ClaudeOutputMessage,
  ClaudePermissionMode,
  ClaudePermissionResult,
  ClaudeResultMessage,
  ClaudeStreamEvent,
  ClaudeUserContentBlock,
  ClaudeUserInput,
  ClaudeUserOutputMessage,
} from "./stream-json-types.js";
import { readClaudeUserSettings, withSettingsModels } from "./settings-models.js";

export const CLAUDE_PROVIDER_ID = "claude";

/** Claude Code 接受的模型别名；`default` 表示不传 model，沿用 CLI 默认 / 用户配置 */
export const CLAUDE_MODELS: AgentModelDefinition[] = [
  {
    provider: CLAUDE_PROVIDER_ID,
    id: "default",
    label: "默认（跟随 Claude Code 配置）",
    description: "跟随 Claude Code 设置",
    isDefault: true,
  },
  { provider: CLAUDE_PROVIDER_ID, id: "sonnet", label: "Sonnet（均衡）" },
  { provider: CLAUDE_PROVIDER_ID, id: "opus", label: "Opus（最强）" },
  { provider: CLAUDE_PROVIDER_ID, id: "haiku", label: "Haiku（最快）" },
];

/**
 * 不选模式（modeId 为 null）时不传 --permission-mode，跟随用户设置的默认模式。
 * `default` 即 CLI 的 Manual（`manual` 是 CLI 接受的别名，内部仍为 `default`）。
 */
export const CLAUDE_MODES: AgentMode[] = [
  { id: "default", label: "逐项审批", description: "敏感操作逐项请求审批" },
  { id: "acceptEdits", label: "自动接受编辑", description: "文件编辑自动通过，其它操作仍需审批" },
  {
    id: "auto",
    label: "自动模式",
    // 依据 Claude Code 文档 permission-modes「Eliminate permission prompts with auto mode」
    description: "由独立的分类器模型代为审查：常规操作直接执行，越权、可疑或高风险操作会被拦截",
  },
  { id: "plan", label: "计划模式", description: "只读分析并给出计划，批准后才执行" },
  {
    id: "bypassPermissions",
    label: "跳过所有审批",
    description: "所有工具调用直接执行（危险）",
    dangerous: true,
  },
];

/** 跟随设置时批准计划后切回基础模式；基础模式未知或本身就是 plan 时用它 */
const PLAN_EXIT_FALLBACK_MODE: ClaudePermissionMode = "default";
const INTERRUPT_TIMEOUT_MS = 3_000;
const AVAILABILITY_CACHE_MS = 60_000;
/** 模型列表来自 claude 的 initialize 应答，成功结果缓存 10 分钟 */
const MODEL_CACHE_MS = 10 * 60_000;
const MODEL_PROBE_TIMEOUT_MS = 15_000;

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

/**
 * 启动配置覆盖（自定义中转 provider 用，design.md 4.7）；不传时行为与内置 claude provider 完全相同。
 */
export interface ClaudeLaunchOverride {
  /** 从继承环境中剔除的变量（不区分大小写），在 envOverlay 之前生效 */
  stripEnv?: readonly string[];
  /** 叠加到子进程环境的变量（最后应用） */
  envOverlay?: Readonly<Record<string, string>>;
  /** 追加到 claude 启动参数末尾（如 --settings / --disallowedTools） */
  extraArgs?: readonly string[];
  /**
   * 每次启动 claude 进程（建会话 / 恢复会话 / 模型探测）前调用，返回值替代 extraArgs
   * （如需在启动时读取 settingsFile）；抛错表示无法启动，建会话 / 恢复时映射为 PROVIDER_UNAVAILABLE。
   */
  resolveExtraArgs?: () => Promise<readonly string[]>;
}

export interface ClaudeAgentClientOptions {
  logger: Logger;
  /** sidecar 进程环境；传给 claude 前会剔除 AGENTDECK_* 与父 Claude 会话变量 */
  env: NodeJS.ProcessEnv;
  /** provider id，默认 `claude`（自定义中转为 `custom:<id>`） */
  providerId?: string;
  /** 显示名，默认 `Claude Code` */
  label?: string;
  launch?: ClaudeLaunchOverride;
  /**
   * 模型发现用的 Claude 设置（顶层 model 与 env 中的模型变量，见 settings-models.ts）；返回 null 表示读不到。
   * 默认：内置 provider 读用户 `$CLAUDE_CONFIG_DIR/settings.json`（或 `~/.claude/settings.json`），
   * 带 launch 覆盖（中转）时不读用户设置。
   */
  loadSettings?: () => Promise<Record<string, unknown> | null>;
  /** 创建 claude 子进程会话（测试可注入假实现） */
  cliFactory?: ClaudeCliFactory;
  resolveExecutable?: () => Promise<ClaudeExecutableResolution>;
  terminateProcess?: ProcessTerminator;
}

export class ClaudeAgentClient implements AgentClient {
  readonly provider: string;
  readonly kind = "claude" as const;
  readonly label: string;

  private readonly logger: Logger;
  private readonly childEnv: Record<string, string>;
  private readonly extraArgs: readonly string[];
  private readonly resolveExtraArgs: (() => Promise<readonly string[]>) | undefined;
  private readonly loadSettings: () => Promise<Record<string, unknown> | null>;
  private readonly cliFactory: ClaudeCliFactory;
  private readonly resolveExecutable: () => Promise<ClaudeExecutableResolution>;
  private readonly terminateProcess: ProcessTerminator | undefined;
  private cached: { at: number; promise: Promise<ClaudeExecutableResolution> } | null = null;
  private modelCache: { at: number; models: AgentModelDefinition[] } | null = null;
  private modelProbe: Promise<AgentModelDefinition[] | null> | null = null;

  constructor(options: ClaudeAgentClientOptions) {
    this.provider = options.providerId ?? CLAUDE_PROVIDER_ID;
    this.label = options.label ?? "Claude Code";
    this.logger = options.logger;
    this.childEnv = buildClaudeChildEnv(options.env, options.launch);
    this.extraArgs = options.launch?.extraArgs ? [...options.launch.extraArgs] : [];
    this.resolveExtraArgs = options.launch?.resolveExtraArgs;
    this.loadSettings =
      options.loadSettings ??
      (options.launch ? async () => null : () => readClaudeUserSettings(options.env));
    this.cliFactory = options.cliFactory ?? createClaudeCliSession;
    this.resolveExecutable =
      options.resolveExecutable ??
      (() =>
        resolveClaudeExecutable(
          createDefaultClaudeExecutableDeps(options.env, (message) => this.logger.warn(message)),
        ));
    this.terminateProcess = options.terminateProcess;
  }

  async isAvailable(): Promise<AgentAvailability> {
    const resolution = await this.resolve();
    if (!resolution.available) {
      return { available: false, reason: resolution.reason };
    }
    return { available: true, command: [resolution.path] };
  }

  /**
   * 模型优先取 claude initialize 应答里的列表，拿不到时退回静态别名；
   * 再追加 Claude 设置里的具体模型（每次重新读取设置），`default` 的描述写明当前生效的模型。
   */
  async fetchCatalog(opts?: {
    cwd?: string;
  }): Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }> {
    const models = (await this.loadModels(opts?.cwd)) ?? CLAUDE_MODELS;
    const settings = await this.loadSettings().catch(() => null);
    return {
      models: withSettingsModels(
        models.map((model) => ({ ...model, provider: this.provider })),
        settings,
        this.provider,
      ),
      modes: CLAUDE_MODES.map((mode) => ({ ...mode })),
    };
  }

  private async loadModels(cwd: string | undefined): Promise<AgentModelDefinition[] | null> {
    if (this.modelCache && Date.now() - this.modelCache.at < MODEL_CACHE_MS) {
      return this.modelCache.models;
    }
    if (!this.modelProbe) {
      this.modelProbe = this.probeModels(cwd ?? os.homedir()).finally(() => {
        this.modelProbe = null;
      });
    }
    return this.modelProbe;
  }

  /** 起一个临时 claude 进程，只发 initialize（不发用户消息，不消耗额度），读出模型列表后立即结束 */
  private async probeModels(cwd: string): Promise<AgentModelDefinition[] | null> {
    let cli: ClaudeCliHandle | null = null;
    try {
      const resolution = await this.resolve();
      if (!resolution.available) {
        return null;
      }
      const extraArgs = await this.launchArgs();
      cli = this.cliFactory({
        executablePath: resolution.path,
        cwd,
        env: this.childEnv,
        ...(extraArgs.length > 0 ? { extraArgs } : {}),
        model: null,
        permissionMode: null,
        resumeSessionId: null,
        canUseTool: async () => ({ behavior: "deny", message: "模型探测进程不执行工具" }),
        logger: this.logger,
        controlTimeoutMs: MODEL_PROBE_TIMEOUT_MS,
        ...(this.terminateProcess ? { terminateProcess: this.terminateProcess } : {}),
      });
      const models = mapInitializeModels(await cli.initialized, this.provider);
      if (models) {
        this.modelCache = { at: Date.now(), models };
      }
      return models;
    } catch (error) {
      this.logger.warn("获取 Claude Code 模型列表失败，使用内置别名：%s", errorMessage(error));
      return null;
    } finally {
      await cli?.close().catch(() => undefined);
    }
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
    const modeId = cfg.modeId ?? null;
    if (modeId !== null) {
      assertClaudeMode(modeId);
    }
    const resolution = await this.resolve();
    if (!resolution.available) {
      throw new Error(resolution.reason);
    }
    let extraArgs: readonly string[];
    try {
      extraArgs = await this.launchArgs();
    } catch (error) {
      throw new AgentRpcError("PROVIDER_UNAVAILABLE", errorMessage(error));
    }
    return new ClaudeAgentSession({
      logger: this.logger,
      env: this.childEnv,
      providerId: this.provider,
      ...(extraArgs.length > 0 ? { extraArgs } : {}),
      cliFactory: this.cliFactory,
      ...(this.terminateProcess ? { terminateProcess: this.terminateProcess } : {}),
      executablePath: resolution.path,
      cwd: cfg.cwd,
      model: cfg.model ?? null,
      modeId,
      resumeSessionId,
    });
  }

  private async launchArgs(): Promise<readonly string[]> {
    return this.resolveExtraArgs ? [...(await this.resolveExtraArgs())] : this.extraArgs;
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
  /** 默认 `claude` */
  providerId?: string;
  /** 追加到 claude 启动参数末尾 */
  extraArgs?: readonly string[];
  cliFactory?: ClaudeCliFactory;
  terminateProcess?: ProcessTerminator;
  executablePath: string;
  cwd: string;
  model: string | null;
  /** null 表示跟随用户设置（不传 --permission-mode） */
  modeId: string | null;
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
  resolve: (result: ClaudePermissionResult) => void;
  cleanup: () => void;
}

interface ToolUseEntry {
  name: string;
  input: unknown;
  /** TodoWrite 等以其它 timeline 形式展示的工具，不发 tool_call */
  hidden: boolean;
}

export class ClaudeAgentSession implements AgentSession {
  readonly provider: string;

  private readonly logger: Logger;
  private readonly env: Record<string, string>;
  private readonly extraArgs: readonly string[] | undefined;
  private readonly cliFactory: ClaudeCliFactory;
  private readonly terminateProcess: ProcessTerminator | undefined;
  private readonly executablePath: string;
  private readonly cwd: string;

  private sessionId: string | null;
  private threadStarted = false;
  private closed = false;
  private model: string | null;
  /** null 表示跟随用户设置 */
  private mode: ClaudePermissionMode | null;
  /** 不传 --permission-mode 启动时 initialize 报告的 current_permission_mode（用户设置的默认模式） */
  private baseMode: string | null = null;
  /** 进入 plan 之前的模式（null 为跟随设置），批准计划后切回 */
  private modeBeforePlan: ClaudePermissionMode | null = null;

  private cli: ClaudeCliHandle | null = null;

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
    if (options.modeId !== null) {
      assertClaudeMode(options.modeId);
    }
    this.provider = options.providerId ?? CLAUDE_PROVIDER_ID;
    this.logger = options.logger;
    this.env = options.env;
    this.extraArgs = options.extraArgs;
    this.cliFactory = options.cliFactory ?? createClaudeCliSession;
    this.terminateProcess = options.terminateProcess;
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
    const message = toClaudeUserInput(prompt, this.sessionId);
    const turn: ActiveTurn = { turnId, userMessageUuid: message.uuid };
    this.activeTurn = turn;
    this.emit({ type: "turn_started", turnId });

    try {
      this.ensureCli().sendUserMessage(message);
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
      // 批准计划后离开 plan 模式，切回进入 plan 之前的模式
      if (isPlan && this.mode === "plan") {
        await this.leavePlanMode().catch((error: unknown) => {
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

    const cli = this.cli;
    if (cli) {
      try {
        await withTimeout(cli.interrupt(), INTERRUPT_TIMEOUT_MS, "中断 Claude Code 超时（3 秒）");
      } catch (error) {
        // 中断失败或超时：直接结束当前进程，下一轮以 --resume 重新拉起
        this.logger.warn("中断 Claude Code 失败，重建会话进程：%s", errorMessage(error));
        await this.teardownCli();
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
    await this.teardownCli();
    this.listeners.clear();
  }

  describePersistence(): AgentPersistenceHandle | null {
    return this.sessionId ? { provider: this.provider, sessionId: this.sessionId } : null;
  }

  async setModel(modelId: string | null): Promise<void> {
    if (this.cli) {
      await this.cli.setModel(normalizeModel(modelId));
    }
    this.model = modelId;
    this.emit({ type: "model_changed", modelId });
  }

  async setMode(modeId: string): Promise<void> {
    assertClaudeMode(modeId);
    if (this.cli) {
      await this.cli.setPermissionMode(modeId);
    }
    if (modeId === "plan" && this.mode !== "plan") {
      this.modeBeforePlan = this.mode;
    }
    this.mode = modeId;
    this.emit({ type: "mode_changed", modeId });
  }

  /** 切回进入 plan 之前的模式；之前为跟随设置时切回基础模式，快照 modeId 回到 null */
  private async leavePlanMode(): Promise<void> {
    const previous = this.modeBeforePlan;
    this.modeBeforePlan = null;
    if (previous) {
      await this.setMode(previous);
      return;
    }
    const target =
      this.baseMode && this.baseMode !== "plan" ? this.baseMode : PLAN_EXIT_FALLBACK_MODE;
    if (this.cli) {
      await this.cli.setPermissionMode(target);
    }
    this.mode = null;
    this.emit({ type: "mode_changed", modeId: null });
  }

  // -------------------------------------------------------------------------
  // claude 子进程生命周期
  // -------------------------------------------------------------------------

  private ensureCli(): ClaudeCliHandle {
    if (this.cli) {
      return this.cli;
    }
    const model = normalizeModel(this.model);
    // 跟随设置时进入的 plan：先不带 --permission-mode 启动以读到基础模式，再立即切到 plan
    // （控制请求先于用户消息写入 stdin，CLI 按序处理）
    const deferPlan = this.mode === "plan" && this.modeBeforePlan === null;
    const launchMode = deferPlan ? null : this.mode;
    this.logger.info(
      "启动 Claude Code 会话（exe=%s, cwd=%s, model=%s, mode=%s, resume=%s）",
      this.executablePath,
      this.cwd,
      model ?? "default",
      this.mode ?? "跟随设置",
      this.sessionId ?? "-",
    );
    const cli = this.cliFactory({
      executablePath: this.executablePath,
      cwd: this.cwd,
      env: { ...this.env },
      ...(this.extraArgs && this.extraArgs.length > 0 ? { extraArgs: this.extraArgs } : {}),
      model,
      permissionMode: launchMode,
      resumeSessionId: this.sessionId,
      canUseTool: this.handleCanUseTool,
      logger: this.logger,
      onStderr: this.handleStderr,
      ...(this.terminateProcess ? { terminateProcess: this.terminateProcess } : {}),
    });
    this.cli = cli;
    cli.initialized.then(
      (response) => {
        const current = response.current_permission_mode;
        if (launchMode === null && this.cli === cli && typeof current === "string" && current) {
          this.baseMode = current;
        }
      },
      (error: unknown) => {
        if (this.cli === cli) {
          this.logger.warn("Claude Code initialize 失败：%s", errorMessage(error));
        }
      },
    );
    if (deferPlan) {
      cli.setPermissionMode("plan").catch((error: unknown) => {
        this.logger.warn("切换到计划模式失败：%s", errorMessage(error));
      });
    }
    void this.pump(cli);
    return cli;
  }

  private readonly handleStderr = (data: string): void => {
    const text = data.trim();
    if (text) {
      this.logger.info("[claude stderr] %s", text);
    }
  };

  private async pump(cli: ClaudeCliHandle): Promise<void> {
    let failure: string | null = null;
    try {
      for await (const message of cli) {
        if (this.cli !== cli) {
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

    if (this.cli !== cli) {
      return; // 已被 teardown / 重建
    }
    this.cli = null;
    // 进程已退出：仍走一遍 close，确保残留的子进程树被清理
    void cli.close().catch(() => undefined);
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

  private async teardownCli(): Promise<void> {
    const cli = this.cli;
    this.cli = null;
    if (cli) {
      await cli.close().catch((error: unknown) => {
        this.logger.warn("结束 Claude Code 进程失败：%s", errorMessage(error));
      });
    }
  }

  // -------------------------------------------------------------------------
  // 事件翻译
  // -------------------------------------------------------------------------

  private handleMessage(message: ClaudeOutputMessage): void {
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
        this.handleStreamEvent(message.event);
        return;
      case "assistant":
        if (message.parent_tool_use_id) {
          return;
        }
        this.captureSession(message.session_id);
        this.handleAssistantMessage(message.message);
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

  private handleStreamEvent(event: ClaudeStreamEvent): void {
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

  private handleAssistantMessage(message: ClaudeAssistantMessage["message"]): void {
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

  private handleToolUse(turn: ActiveTurn, block: ClaudeContentBlock): void {
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

  private handleUserMessage(message: ClaudeUserOutputMessage): void {
    const turn = this.activeTurn;
    const content = message.message?.content;
    if (!turn || !Array.isArray(content)) {
      return;
    }
    const results = (content as ClaudeContentBlock[]).filter(
      (block) => block?.type === "tool_result" || block?.type === "mcp_tool_result",
    );
    // CLI 的 tool_use_result 是单个工具的结构化输出，只有一条结果时才能对应上
    const structured = results.length === 1 ? message.tool_use_result : undefined;
    for (const block of results) {
      this.handleToolResult(turn, block, structured);
    }
  }

  private handleToolResult(turn: ActiveTurn, block: ClaudeContentBlock, structured: unknown): void {
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

  private handleResult(message: ClaudeResultMessage): void {
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

  private convertUsage(message: ClaudeResultMessage): AgentUsage {
    const usage = message.usage;
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

  private readonly handleCanUseTool: ClaudeCanUseTool = async (toolName, input, options) => {
    const turn = this.activeTurn;
    if (this.closed || !turn) {
      return { behavior: "deny", message: "当前没有进行中的回合" };
    }
    const requestId = `perm-${randomUUID()}`;
    const isPlan = toolName === "ExitPlanMode";
    const detail: ToolCallDetail | undefined = isPlan
      ? { type: "plan", text: typeof input.plan === "string" ? input.plan : "" }
      : mapClaudeRunningToolCall({
          callId: options.toolUseId || requestId,
          name: toolName,
          input,
        })?.detail;
    const description = options.description ?? options.decisionReason;
    const request: AgentPermissionRequest = {
      id: requestId,
      provider: this.provider,
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

    return new Promise<ClaudePermissionResult>((resolve) => {
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
      const cleanup = () => options.signal.removeEventListener("abort", onAbort);
      this.pendingPermissions.set(requestId, { request, input, resolve, cleanup });
      this.emit({ type: "permission_requested", turnId: turn.turnId, request });
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
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

export function buildClaudeChildEnv(
  env: NodeJS.ProcessEnv,
  launch?: Pick<ClaudeLaunchOverride, "stripEnv" | "envOverlay">,
): Record<string, string> {
  const childEnv = createExternalProcessEnv(env) as Record<string, string>;
  const strip = new Set([
    ...PARENT_SESSION_ENV_VARS,
    ...(launch?.stripEnv ?? []).map((key) => key.toUpperCase()),
  ]);
  for (const key of Object.keys(childEnv)) {
    if (strip.has(key.toUpperCase())) {
      delete childEnv[key];
    }
  }
  return launch?.envOverlay
    ? (createExternalProcessEnv(childEnv, launch.envOverlay) as Record<string, string>)
    : childEnv;
}

function assertClaudeMode(modeId: string): asserts modeId is ClaudePermissionMode {
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

/** initialize 应答里的模型列表 → AgentModelDefinition；没有可用条目返回 null */
export function mapInitializeModels(
  response: ClaudeInitializeResponse,
  providerId: string = CLAUDE_PROVIDER_ID,
): AgentModelDefinition[] | null {
  if (!Array.isArray(response.models)) {
    return null;
  }
  const builtinDefault = CLAUDE_MODELS[0]!;
  const models: AgentModelDefinition[] = [];
  const seen = new Set<string>();
  for (const entry of response.models) {
    const id = typeof entry?.value === "string" ? entry.value.trim() : "";
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const label = typeof entry.displayName === "string" && entry.displayName ? entry.displayName : id;
    const description =
      typeof entry.description === "string" && entry.description ? entry.description : undefined;
    if (id === "default") {
      // `default` 表示不传 --model；沿用内置的中文标签
      models.push({ ...builtinDefault, provider: providerId, ...(description ? { description } : {}) });
    } else {
      models.push({ provider: providerId, id, label, ...(description ? { description } : {}) });
    }
  }
  if (models.length === 0) {
    return null;
  }
  if (!seen.has("default")) {
    models.unshift({ ...builtinDefault, provider: providerId });
  }
  return models;
}

export function toClaudeUserInput(
  prompt: AgentPromptInput,
  sessionId: string | null,
): ClaudeUserInput {
  const content: ClaudeUserContentBlock[] = [];
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
            media_type: part.mimeType as ClaudeImageMediaType,
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
    uuid: randomUUID(),
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
 * search / fetch 优先用 CLI 的结构化输出（Glob/Grep/WebFetch/WebSearch 的 Output 与 schema 吻合）。
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

function resultErrorText(message: ClaudeResultMessage): string {
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
