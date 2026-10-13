// Derived from paseo packages/server/src/server/agent/providers/claude/agent.ts and query.ts (Apache-2.0); modified for AgentDeck
// 大幅精简：一个会话一个长生命周期 claude 子进程（stream-json stdio 协议，见 claude-cli-session.ts），每轮写一条用户消息；
// 只保留 AgentDeck 协议需要的事件翻译、权限中转、中断、模型/模式切换与 tree-kill 关闭。
// 去掉了 paseo 的 steer、rewind、历史回放、快速模式、思考预算等功能；子代理按 paseo 的 task 协议 + sidechain
// 移植（design.md 4.11），但不做子代理 effort hooks 与磁盘回放；
// 思考强度（--effort / --thinking disabled）按 paseo 的做法在切换后标记重启，下一轮以 --resume 重新拉起。
// CLI 自发轮次（后台任务完成后 CLI 自行续写）按 paseo 的 autonomous turn 处理，以 init 为起点识别（design.md 4.12）。
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
  ToolCallTimelineItem,
} from "@agentdeck/protocol";

import type {
  AgentAvailability,
  AgentClient,
  AgentSession,
  AgentSessionConfig,
  AgentSessionEvent,
  ProviderSubagentInputEvent,
} from "../../agent/types.js";
import type { Logger } from "../../logger.js";
import { DATA_DIR_ENV, readConfiguredAgentPath } from "../../utils/coding-agent-paths.js";
import { createExternalProcessEnv } from "../../utils/process-env.js";
import { withTimeout } from "../../utils/promise-timeout.js";
import type { ProcessTerminator } from "../../utils/tree-kill.js";
import {
  createClaudeCliSession,
  type ClaudeCliFactory,
  type ClaudeCliHandle,
} from "./claude-cli-session.js";
import { ClaudeSidechainTracker } from "./sidechain-tracker.js";
import { ClaudeTaskProtocolSource } from "./subagents/live-source.js";
import { foldSubagentObservations, type SubagentObservation } from "./subagents/observation.js";
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
  buildOutputCandidates,
  toolResultText,
} from "./tool-call-mapper.js";
import {
  CLAUDE_ASK_USER_QUESTION_TOOL,
  readQuestionAnswers,
  toQuestionToolDetail,
} from "./tool-call-detail-parser.js";
import type {
  ClaudeAssistantMessage,
  ClaudeCanUseTool,
  ClaudeCompactBoundaryMessage,
  ClaudeContentBlock,
  ClaudeImageMediaType,
  ClaudeInitializeResponse,
  ClaudeOutputMessage,
  ClaudePermissionMode,
  ClaudePermissionResult,
  ClaudeResultMessage,
  ClaudeStatusSystemMessage,
  ClaudeStreamEvent,
  ClaudeTaskSystemMessage,
  ClaudeUserContentBlock,
  ClaudeUserInput,
  ClaudeUserOutputMessage,
} from "./stream-json-types.js";
import { readClaudeUserSettings, withSettingsModels } from "./settings-models.js";
import {
  isClaudeThinkingOption,
  withClaudeThinkingOptions,
} from "./thinking-options.js";
import {
  normalizeThinkingOptionId,
  THINKING_APPLIES_NEXT_TURN_NOTICE,
} from "../shared/thinking-options.js";

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

/** AskUserQuestion 的应答动作（design.md 4.13） */
const QUESTION_PERMISSION_ACTIONS: AgentPermissionAction[] = [
  { id: "submit", label: "提交回答", behavior: "allow" },
  { id: "skip", label: "跳过", behavior: "deny" },
];
const QUESTION_SKIPPED_MESSAGE = "用户跳过了这些问题";
const QUESTION_UNANSWERED_MESSAGE = "用户没有回答问题";

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
  private readonly loadSettings: () => Promise<Record<string, unknown> | null>;
  private readonly cliFactory: ClaudeCliFactory;
  private readonly resolveExecutable: () => Promise<ClaudeExecutableResolution>;
  private readonly terminateProcess: ProcessTerminator | undefined;
  /** 「编程 Agent」页配置文件所在的数据目录（AGENTDECK_DATA_DIR），配置变化时作废可执行文件缓存 */
  private readonly dataDir: string | undefined;
  private cached: { at: number; key: string; promise: Promise<ClaudeExecutableResolution> } | null = null;
  private modelCache: { at: number; models: AgentModelDefinition[] } | null = null;
  private modelProbe: Promise<AgentModelDefinition[] | null> | null = null;

  constructor(options: ClaudeAgentClientOptions) {
    this.provider = options.providerId ?? CLAUDE_PROVIDER_ID;
    this.label = options.label ?? "Claude Code";
    this.logger = options.logger;
    this.childEnv = buildClaudeChildEnv(options.env, options.launch);
    this.extraArgs = options.launch?.extraArgs ? [...options.launch.extraArgs] : [];
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
    this.dataDir = options.env[DATA_DIR_ENV];
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
    // initialize 应答里的模型已按 CLI 报告定好档位（含「不支持」）；静态别名与设置发现的模型按清单 / 标准组补档位
    const models =
      (await this.loadModels(opts?.cwd)) ?? CLAUDE_MODELS.map((model) => withClaudeThinkingOptions(model));
    const decided = new Set(models.map((model) => model.id));
    const settings = await this.loadSettings().catch(() => null);
    return {
      models: withSettingsModels(
        models.map((model) => ({ ...model, provider: this.provider })),
        settings,
        this.provider,
      ).map((model) => (decided.has(model.id) ? model : withClaudeThinkingOptions(model))),
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
      cli = this.cliFactory({
        executablePath: resolution.path,
        cwd,
        env: this.childEnv,
        ...(this.extraArgs.length > 0 ? { extraArgs: this.extraArgs } : {}),
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
    const thinkingOptionId = normalizeThinkingOptionId(cfg.thinkingOptionId);
    if (thinkingOptionId !== null) {
      assertClaudeThinkingOption(thinkingOptionId);
    }
    const resolution = await this.resolve();
    if (!resolution.available) {
      throw new Error(resolution.reason);
    }
    return new ClaudeAgentSession({
      logger: this.logger,
      env: this.childEnv,
      providerId: this.provider,
      ...(this.extraArgs.length > 0 ? { extraArgs: this.extraArgs } : {}),
      cliFactory: this.cliFactory,
      ...(this.terminateProcess ? { terminateProcess: this.terminateProcess } : {}),
      executablePath: resolution.path,
      cwd: cfg.cwd,
      model: cfg.model ?? null,
      modeId,
      thinkingOptionId,
      resumeSessionId,
    });
  }

  /**
   * 成功结果缓存 60 秒（provider.list 与 agent.create 都会调用）；失败不缓存，便于安装后立即生效。
   * 缓存以「编程 Agent」页配置的路径为键：每次都重读配置文件，配置变化即重新解析，保存后无需重启 sidecar。
   */
  private resolve(): Promise<ClaudeExecutableResolution> {
    const now = Date.now();
    const key = readConfiguredAgentPath(this.dataDir, "claude") ?? "";
    if (this.cached && this.cached.key === key && now - this.cached.at < AVAILABILITY_CACHE_MS) {
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
    this.cached = { at: now, key, promise };
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
  /** 思考强度，null / 缺省表示跟随 Claude Code 设置（不传 --effort） */
  thinkingOptionId?: string | null;
  resumeSessionId: string | null;
}

interface ActiveTurn {
  turnId: string;
  /**
   * 本轮用户消息的 uuid；CLI 在 result.user_message_uuid 中回显，用于识别过期 result。
   * null 表示 CLI 自发轮次（design.md 4.12）：没有对应的用户消息，收到任意 result 即结束。
   */
  userMessageUuid: string | null;
  /**
   * 本轮接管了一个还没收到 result 的自发轮次：用户消息在 CLI 里排在那一轮之后，
   * 先到的那条不带 user_message_uuid 的 result 属于被接管的自发轮次，跳过一次
   * （尚未见过 CLI 回显 uuid 时的兜底，见 cliEchoesUserMessageUuid）。
   */
  skipSupersededResult: boolean;
}

interface PendingPermission {
  request: AgentPermissionRequest;
  input: Record<string, unknown>;
  /** CLI 给出的 tool_use_id（与 toolUses 的键一致），回答问题后据此更新工具卡片的 input */
  toolUseId?: string;
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
  /** 思考强度（null 为跟随设置）；只能在启动参数里指定 */
  private thinkingOptionId: string | null;
  /** 思考强度在 claude 进程运行期间改变：下一轮开始前结束旧进程，以 --resume 带新参数重启 */
  private cliRestartNeeded = false;

  private cli: ClaudeCliHandle | null = null;

  private activeTurn: ActiveTurn | null = null;
  /** 没有进行中的回合时到达的后台任务完成提示，下一轮开始后再发（design.md 4.12） */
  private pendingNotices: AgentTimelineItem[] = [];
  /**
   * 没有我方回合时 CLI 发了 init，即自行开始了一轮；等它真正产出内容才开自发回合
   * （CLI 偶尔会跑只有 init + 空 result 的空轮，不该显示成一个回合），收到 result 时清除。
   */
  private backgroundRunPending = false;
  /**
   * CLI 会在用户回合的 result 里回显 user_message_uuid（2.1.296 实测，含本地斜杠命令）；见过一次后，
   * 用户回合里不带 uuid 的 result 一律属于 CLI 自发轮次，不结束用户回合。
   */
  private cliEchoesUserMessageUuid = false;
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly toolUses = new Map<string, ToolUseEntry>();
  /** 已通过 stream_event 增量输出过文本 / 思考的 API message id，完整 assistant 消息到达时跳过对应块 */
  private readonly streamedText = new Set<string>();
  private readonly streamedThinking = new Set<string>();
  private currentStreamMessageId: string | null = null;
  private contextInputTokens = 0;
  private contextOutputTokens = 0;
  /** 进行中的上下文压缩（status compacting 时生成，compact_boundary / 失败时清空，design.md 4.13） */
  private compactionId: string | null = null;
  /** 父会话 Task / Agent 调用的 input（按 tool_use_id，会话级）：子代理标题、类型与描述来源 */
  private readonly subagentToolInputs = new Map<string, Record<string, unknown>>();
  /** 子代理父卡片的最近一次推送（按 callId）：后续推送在此合并，保留 log 且终态不回退 */
  private readonly subAgentCards = new Map<string, ToolCallTimelineItem>();
  private readonly taskProtocolSource = new ClaudeTaskProtocolSource({
    getToolInput: (toolUseId) => this.subagentToolInputs.get(toolUseId) ?? null,
  });
  private readonly sidechainTracker = new ClaudeSidechainTracker({
    getToolInput: (toolUseId) => this.subagentToolInputs.get(toolUseId) ?? null,
    // 早于 task 协议的 CLI 什么都不公告，此时由 tracker 从帧推导身份与状态
    isDescriptorOwnedElsewhere: () => this.taskProtocolSource.isActive,
    needsSyntheticParentToolCard: (toolUseId) =>
      this.taskProtocolSource.needsSyntheticParentToolCard(toolUseId),
  });

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
    this.thinkingOptionId = normalizeThinkingOptionId(options.thinkingOptionId);
    this.sessionId = options.resumeSessionId;
  }

  get id(): string | null {
    return this.sessionId;
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    if (this.closed) {
      throw new Error("Claude 会话已关闭");
    }
    const background = this.activeTurn;
    if (background && background.userMessageUuid !== null) {
      throw new Error("Claude 会话正在执行中");
    }
    if (background) {
      // 自发轮次进行中（参照 paseo startTurn → completeAutonomousTurn）：先结束它，用户消息照常写入 stdin，
      // 由 CLI 排在当前这一轮之后处理（2.1.296 实测），这一轮剩余的输出并入新回合。仍挂起的审批作废，
      // 否则 CLI 卡在审批上、用户消息永远轮不到。不清 streamed 集合与运行中的工具：它们的后续帧还会到达。
      this.activeTurn = null;
      this.denyAllPendingPermissions("用户发送了新消息，已取消该请求");
      this.emit({ type: "turn_completed", turnId: background.turnId });
    } else if (this.cliRestartNeeded) {
      // 思考强度变了：结束旧进程，下面 ensureCli 以 --resume 带新参数重新拉起
      // （接管自发轮次时不重启，免得杀掉正在进行的那一轮，留到之后的回合）
      this.cliRestartNeeded = false;
      await this.teardownCli();
    }
    const turnId = randomUUID();
    const message = toClaudeUserInput(prompt, this.sessionId);
    const turn: ActiveTurn = {
      turnId,
      userMessageUuid: message.uuid,
      // CLI 正在跑一轮自发的（不论是否已显示成回合）：它的 result 先到
      skipSupersededResult: background !== null || this.backgroundRunPending,
    };
    this.backgroundRunPending = false;
    this.activeTurn = turn;
    this.emit({ type: "turn_started", turnId });
    this.flushPendingNotices(turn);

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

  subscribe(cb: (event: AgentSessionEvent) => void): () => void {
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

    const isPlan = pending.request.kind === "plan";
    if (pending.request.kind === "question") {
      this.respondToQuestion(requestId, pending, response);
      return;
    }
    this.emit({ type: "permission_resolved", requestId, response });
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

  /**
   * AskUserQuestion 的应答（design.md 4.13）：allow 时 updatedInput 合并在原 input 上（questions 原样回传），
   * 没有回答按 deny 处理；回答写回该工具调用的 input，工具卡片完成时 detail 带上 answers。
   */
  private respondToQuestion(
    requestId: string,
    pending: PendingPermission,
    response: AgentPermissionResponse,
  ): void {
    if (response.behavior === "allow") {
      const updatedInput = { ...pending.input, ...response.updatedInput };
      if (readQuestionAnswers(updatedInput.answers)) {
        const entry = pending.toolUseId ? this.toolUses.get(pending.toolUseId) : undefined;
        if (entry) {
          entry.input = updatedInput;
        }
        this.emit({ type: "permission_resolved", requestId, response });
        pending.resolve({ behavior: "allow", updatedInput });
        return;
      }
    }
    const message =
      response.behavior === "deny"
        ? (response.message ?? QUESTION_SKIPPED_MESSAGE)
        : QUESTION_UNANSWERED_MESSAGE;
    const interrupt = response.behavior === "deny" && response.interrupt === true;
    this.emit({
      type: "permission_resolved",
      requestId,
      response: {
        behavior: "deny",
        ...(response.selectedActionId ? { selectedActionId: response.selectedActionId } : {}),
        message,
        ...(interrupt ? { interrupt: true } : {}),
      },
    });
    pending.resolve({ behavior: "deny", message, ...(interrupt ? { interrupt: true } : {}) });
  }

  async interrupt(): Promise<void> {
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }
    this.activeTurn = null;
    this.backgroundRunPending = false;
    this.denyAllPendingPermissions("回合已取消");
    this.cancelRunningTools(turn.turnId);
    this.failCompaction(turn, "压缩已中断");
    // 回合取消：前台子代理随之结束（已转入后台的不动）
    this.sidechainTracker.clear();
    this.emitSubagentObservations(this.taskProtocolSource.cancelRunningForegroundTasks());

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
    this.sidechainTracker.clear();
    this.taskProtocolSource.reset();
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

  /**
   * 思考强度只能通过启动参数指定：进程已在运行时标记重启，下一轮生效（参照 paseo queryRestartNeeded）。
   * 正在运行一轮时返回「下一轮生效」提示。
   */
  async setThinking(thinkingOptionId: string | null): Promise<{ notice?: string }> {
    const next = normalizeThinkingOptionId(thinkingOptionId);
    if (next !== null) {
      assertClaudeThinkingOption(next);
    }
    if (next !== this.thinkingOptionId && this.cli) {
      this.cliRestartNeeded = true;
    }
    this.thinkingOptionId = next;
    this.emit({ type: "thinking_option_changed", thinkingOptionId: next });
    return this.activeTurn ? { notice: THINKING_APPLIES_NEXT_TURN_NOTICE } : {};
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
      "启动 Claude Code 会话（exe=%s, cwd=%s, model=%s, mode=%s, thinking=%s, resume=%s）",
      this.executablePath,
      this.cwd,
      model ?? "default",
      this.mode ?? "跟随设置",
      this.thinkingOptionId ?? "跟随设置",
      this.sessionId ?? "-",
    );
    const cli = this.cliFactory({
      executablePath: this.executablePath,
      cwd: this.cwd,
      env: { ...this.env },
      ...(this.extraArgs && this.extraArgs.length > 0 ? { extraArgs: this.extraArgs } : {}),
      model,
      permissionMode: launchMode,
      thinkingOptionId: this.thinkingOptionId,
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
    this.backgroundRunPending = false;
    // 进程已退出：仍走一遍 close，确保残留的子进程树被清理
    void cli.close().catch(() => undefined);
    if (this.closed) {
      return;
    }
    if (failure) {
      this.logger.warn("Claude Code 消息流异常结束：%s", failure);
    }
    // 进程丢失：它拥有的子代理（含后台）全部失败
    this.sidechainTracker.clear();
    this.emitSubagentObservations(this.taskProtocolSource.failRunningTasks());
    const turn = this.activeTurn;
    this.failCompaction(turn, "Claude Code 进程已退出");
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
    this.backgroundRunPending = false;
    if (cli) {
      await cli.close().catch((error: unknown) => {
        this.logger.warn("结束 Claude Code 进程失败：%s", errorMessage(error));
      });
      if (!this.closed) {
        // 主动重建进程（切换思考强度 / 中断失败）：旧进程里仍在运行的子代理（如后台子代理）随之结束
        this.sidechainTracker.clear();
        this.emitSubagentObservations(this.taskProtocolSource.failRunningTasks());
      }
    }
  }

  // -------------------------------------------------------------------------
  // 事件翻译
  // -------------------------------------------------------------------------

  private handleMessage(message: ClaudeOutputMessage): void {
    const parentToolUseId = readParentToolUseId(message);
    if (parentToolUseId) {
      // 子代理（sidechain）内部输出不进主时间线，改写入子代理时间线（design.md 4.11）
      this.handleSidechainFrame(message, parentToolUseId);
      return;
    }
    if (message.type === "stream_event" || message.type === "assistant" || message.type === "user") {
      this.startPendingBackgroundTurn();
    }
    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          this.captureSession(message.session_id);
          // CLI 每开始一轮都先发 init；此时没有我方回合，说明是 CLI 自发的（后台任务完成后的续写等）
          if (!this.activeTurn) {
            this.backgroundRunPending = true;
          }
        } else if (message.subtype === "status") {
          const status = (message as ClaudeStatusSystemMessage).status;
          if (status === "requesting") {
            // 已经在请求模型：不是空轮，尽早显示「运行中」
            this.startPendingBackgroundTurn();
          } else if (status === "compacting") {
            this.handleCompactionStarted();
          } else {
            this.handleCompactionStatusEnded(message as ClaudeStatusSystemMessage);
          }
        } else if (message.subtype === "compact_boundary") {
          this.handleCompactBoundary(message as ClaudeCompactBoundaryMessage);
        }
        this.handleTaskAnnouncement(message);
        return;
      case "stream_event":
        this.handleStreamEvent(message.event);
        return;
      case "assistant":
        this.captureSession(message.session_id);
        this.handleAssistantMessage(message.message);
        return;
      case "user":
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
    if (isClaudeSubagentToolName(name) && isRecord(input)) {
      this.subagentToolInputs.set(callId, input);
    }
    const item = mapClaudeRunningToolCall({ callId, name, input });
    if (item) {
      this.emitTimeline(turn, item);
    }
  }

  private handleUserMessage(message: ClaudeUserOutputMessage): void {
    const turn = this.activeTurn;
    const content = message.message?.content;
    if (!Array.isArray(content)) {
      return;
    }
    const results = (content as ClaudeContentBlock[]).filter(
      (block) => block?.type === "tool_result" || block?.type === "mcp_tool_result",
    );
    // 父消息出现 Task 的 tool_result：对应 sidechain 结束
    for (const block of results) {
      if (typeof block.tool_use_id === "string") {
        this.emitSubagentEvents(
          this.sidechainTracker.finish(
            block.tool_use_id,
            block.is_error === true ? "failed" : "completed",
          ),
        );
      }
    }
    if (!turn) {
      return;
    }
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
    // 任何 result 都意味着 CLI 当前这一轮结束了
    this.backgroundRunPending = false;
    const echoedUuid = message.user_message_uuid;
    if (echoedUuid) {
      this.cliEchoesUserMessageUuid = true;
    }
    if (!turn) {
      return; // 已中断回合的过期 result，或没有任何输出的空自发轮次
    }
    if (turn.userMessageUuid !== null) {
      if (echoedUuid && echoedUuid !== turn.userMessageUuid) {
        this.logger.debug("忽略非当前回合的 Claude result（uuid=%s）", echoedUuid);
        return;
      }
      // 不带 uuid 的 result 属于排在用户消息之前的 CLI 自发轮次（含只有 init + result 的空轮）
      if (!echoedUuid && (this.cliEchoesUserMessageUuid || turn.skipSupersededResult)) {
        turn.skipSupersededResult = false;
        this.logger.debug("忽略 CLI 自发轮次的 Claude result（当前为用户回合）");
        return;
      }
    }
    this.captureSession(message.session_id);

    const usage = this.convertUsage(message);
    this.emit({ type: "usage_updated", usage });
    this.cancelRunningTools(turn.turnId);
    this.emitSubagentEvents(
      this.sidechainTracker.finishAll(
        message.subtype === "success" && !message.is_error ? "completed" : "failed",
      ),
    );

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
  // 上下文压缩（design.md 4.13）
  // -------------------------------------------------------------------------

  /** status compacting：开始压缩（同一次压缩重复的 compacting 不再新发） */
  private handleCompactionStarted(): void {
    const turn = this.startPendingBackgroundTurn();
    if (this.compactionId) {
      return;
    }
    this.compactionId = `compact-${randomUUID()}`;
    this.emitTimeline(turn, { type: "compaction", compactionId: this.compactionId, status: "running" });
  }

  /** compacting 之后的 status（null 等）：只处理压缩失败，成功由 compact_boundary 表达 */
  private handleCompactionStatusEnded(message: ClaudeStatusSystemMessage): void {
    if (!this.compactionId || message.compact_result !== "failed") {
      return;
    }
    const error =
      typeof message.compact_error === "string" && message.compact_error.trim()
        ? message.compact_error.trim()
        : "上下文压缩失败";
    this.failCompaction(this.activeTurn, error);
  }

  /** compact_boundary：压缩完成，沿用 compacting 时的 id（没有则新建） */
  private handleCompactBoundary(message: ClaudeCompactBoundaryMessage): void {
    const turn = this.startPendingBackgroundTurn();
    const meta = message.compact_metadata;
    const trigger = meta?.trigger === "auto" || meta?.trigger === "manual" ? meta.trigger : undefined;
    const preTokens = toCount(meta?.pre_tokens);
    const compactionId = this.compactionId ?? `compact-${randomUUID()}`;
    this.compactionId = null;
    // 压缩后上下文只剩摘要：「已用」改为 post_tokens（没有则清零），之后的 message_start 会给出准确值，
    // 避免压缩后（如手动 /compact 那一轮）的 result 仍报压缩前的大数字
    this.contextInputTokens = toCount(meta?.post_tokens);
    this.contextOutputTokens = 0;
    this.emitTimeline(turn, {
      type: "compaction",
      compactionId,
      status: "completed",
      ...(trigger ? { trigger } : {}),
      ...(preTokens > 0 ? { preTokens } : {}),
    });
  }

  /** 进行中的压缩以失败收尾（压缩失败、回合中断、进程退出） */
  private failCompaction(turn: ActiveTurn | null, error: string): void {
    const compactionId = this.compactionId;
    if (!compactionId) {
      return;
    }
    this.compactionId = null;
    this.emitTimeline(turn, { type: "compaction", compactionId, status: "failed", error });
  }

  // -------------------------------------------------------------------------
  // 权限
  // -------------------------------------------------------------------------

  private readonly handleCanUseTool: ClaudeCanUseTool = async (toolName, input, options) => {
    const turn = this.closed ? null : this.startPendingBackgroundTurn();
    if (this.closed || !turn) {
      return { behavior: "deny", message: "当前没有进行中的回合" };
    }
    const requestId = `perm-${randomUUID()}`;
    const isPlan = toolName === "ExitPlanMode";
    // AskUserQuestion 需要用户作答（design.md 4.13）；题目解析不出来时按普通工具审批
    const question = toolName === CLAUDE_ASK_USER_QUESTION_TOOL ? toQuestionToolDetail(input) : null;
    const detail: ToolCallDetail | undefined = isPlan
      ? { type: "plan", text: typeof input.plan === "string" ? input.plan : "" }
      : (question ??
        mapClaudeRunningToolCall({
          callId: options.toolUseId || requestId,
          name: toolName,
          input,
        })?.detail);
    const description = options.description ?? options.decisionReason;
    const kind: AgentPermissionRequest["kind"] = isPlan ? "plan" : question ? "question" : "tool";
    const title =
      kind === "plan"
        ? "批准执行计划？"
        : kind === "question"
          ? "Claude 有问题需要你回答"
          : (options.title ?? `允许使用 ${options.displayName ?? toolName}？`);
    const actions =
      kind === "plan"
        ? PLAN_PERMISSION_ACTIONS
        : kind === "question"
          ? QUESTION_PERMISSION_ACTIONS
          : TOOL_PERMISSION_ACTIONS;
    const request: AgentPermissionRequest = {
      id: requestId,
      provider: this.provider,
      name: toolName,
      kind,
      title,
      ...(description ? { description } : {}),
      input,
      ...(detail ? { detail } : {}),
      actions: actions.map((action) => ({ ...action })),
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
      this.pendingPermissions.set(requestId, {
        request,
        input,
        ...(options.toolUseId ? { toolUseId: options.toolUseId } : {}),
        resolve,
        cleanup,
      });
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
        this.emit({ type: "timeline", turnId, item: this.mergeSubAgentCard(item) });
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

  /** CLI 自发的一轮（design.md 4.12）产出第一条内容时开回合：没有用户消息，result 到达时照常结束 */
  private startPendingBackgroundTurn(): ActiveTurn | null {
    if (this.activeTurn || !this.backgroundRunPending) {
      return this.activeTurn;
    }
    this.backgroundRunPending = false;
    const turn: ActiveTurn = {
      turnId: randomUUID(),
      userMessageUuid: null,
      skipSupersededResult: false,
    };
    this.activeTurn = turn;
    this.logger.info("Claude Code 自行开始了一轮（后台任务完成等），turnId=%s", turn.turnId);
    this.emit({ type: "turn_started", turnId: turn.turnId, origin: "background" });
    this.flushPendingNotices(turn);
    return turn;
  }

  private flushPendingNotices(turn: ActiveTurn): void {
    const notices = this.pendingNotices;
    this.pendingNotices = [];
    for (const item of notices) {
      this.emitTimeline(turn, item);
    }
  }

  private emitTimeline(turn: ActiveTurn | null, item: AgentTimelineItem): void {
    const merged = item.type === "tool_call" ? this.mergeSubAgentCard(item) : item;
    this.emit({ type: "timeline", ...(turn ? { turnId: turn.turnId } : {}), item: merged });
  }

  // -------------------------------------------------------------------------
  // provider 子代理（design.md 4.11）
  // -------------------------------------------------------------------------

  /** task_started / task_updated / task_progress / task_notification */
  private handleTaskAnnouncement(message: ClaudeOutputMessage): void {
    if (message.type === "system" && message.subtype === "task_notification") {
      this.handleNonSubagentTaskNotification(message as ClaudeTaskSystemMessage);
    }
    const observations = this.taskProtocolSource.observe(message);
    if (observations.length === 0) {
      return;
    }
    this.emitSubagentObservations(observations);
    for (const observation of observations) {
      // 嵌套子代理的卡片在上级子代理的时间线里，不进父会话时间线
      if (observation.kind !== "declared" || observation.parentSubagentId) continue;
      if (!this.taskProtocolSource.needsSyntheticParentToolCard(observation.id)) continue;
      // 后台子代理没有 sidechain 帧：声明时立即补一张父卡片
      this.emitTimeline(this.activeTurn, {
        type: "tool_call",
        callId: observation.id,
        name: "Task",
        status: "running",
        error: null,
        detail: {
          type: "sub_agent",
          ...(observation.title ? { subAgentType: observation.title } : {}),
          ...(observation.description ? { description: observation.description } : {}),
          log: "",
          actions: [],
        },
      });
    }
  }

  /**
   * 非子代理任务（后台命令等）的完成通知 → 一张已结束的 `task_notification` 卡片（参照 paseo
   * appendTaskNotificationEvents）。子代理任务的完成已由子代理卡片与状态表达，不重复；子代理发起的任务
   * 进该子代理的时间线；没有进行中的回合时先暂存，下一轮（通常就是 CLI 随即自发的那一轮）开始后再发。
   */
  private handleNonSubagentTaskNotification(message: ClaudeTaskSystemMessage): void {
    const taskId = typeof message.task_id === "string" && message.task_id ? message.task_id : null;
    const toolUseId = typeof message.tool_use_id === "string" ? message.tool_use_id : null;
    if (taskId && this.taskProtocolSource.isDeclaredTask(taskId)) return;
    if (toolUseId && this.subagentToolInputs.has(toolUseId)) return;
    const item = mapTaskNotificationToToolCall(message, taskId);
    const owner = taskId ? this.taskProtocolSource.resolveTaskOwner(taskId) : undefined;
    if (owner) {
      this.emitSubagentEvents([{ type: "timeline", id: owner, item }]);
    } else if (this.activeTurn) {
      this.emitTimeline(this.activeTurn, item);
    } else {
      this.pendingNotices.push(item);
    }
  }

  /** 子代理内部的帧：路由到该子代理，不进父时间线 */
  private handleSidechainFrame(message: ClaudeOutputMessage, parentToolUseId: string): void {
    const canonicalId = this.taskProtocolSource.resolveSubagentId(parentToolUseId);
    // CLI 一旦公告 task 就公告全部 task：未声明 id 的帧属于被过滤的工作（workflow 子任务、后台杂务等）
    if (this.taskProtocolSource.announcesTasks && !canonicalId) {
      return;
    }
    const routedId = canonicalId ?? parentToolUseId;
    // 子代理实际运行的模型只出现在它自己的帧里
    const runtime = foldSubagentObservations(
      this.taskProtocolSource.observeSidechainFrame(message, routedId),
    );
    const { events, parentCard } = this.sidechainTracker.handleMessage(message, routedId);
    this.emitSubagentEvents([...runtime, ...events]);
    if (parentCard) {
      this.emitTimeline(this.activeTurn, parentCard);
    }
  }

  /**
   * 子代理父卡片合并：主时间线的 Task/Agent 调用、task_started 补的卡片与 tracker 的卡片共用 callId，
   * 后来的推送补全而不是抹掉已有的 log / 类型 / 描述；终态不会被 running 覆盖。
   */
  private mergeSubAgentCard(item: ToolCallTimelineItem): ToolCallTimelineItem {
    if (item.detail.type !== "sub_agent") {
      return item;
    }
    const previous = this.subAgentCards.get(item.callId);
    const previousDetail = previous?.detail.type === "sub_agent" ? previous.detail : undefined;
    const subAgentType = item.detail.subAgentType ?? previousDetail?.subAgentType;
    const description = item.detail.description ?? previousDetail?.description;
    const actions = item.detail.actions ?? previousDetail?.actions;
    const keepPreviousStatus =
      previous !== undefined && previous.status !== "running" && item.status === "running";
    const merged: ToolCallTimelineItem = {
      ...item,
      name: item.name === "Task" && previous ? previous.name : item.name,
      status: keepPreviousStatus ? previous.status : item.status,
      error: keepPreviousStatus ? (previous.error ?? null) : (item.error ?? null),
      detail: {
        type: "sub_agent",
        ...(subAgentType ? { subAgentType } : {}),
        ...(description ? { description } : {}),
        log: item.detail.log || previousDetail?.log || "",
        ...(actions ? { actions } : {}),
      },
    };
    this.subAgentCards.set(item.callId, merged);
    return merged;
  }

  private emitSubagentObservations(observations: readonly SubagentObservation[]): void {
    this.emitSubagentEvents(foldSubagentObservations(observations));
  }

  private emitSubagentEvents(events: readonly ProviderSubagentInputEvent[]): void {
    for (const event of events) {
      this.emit({ type: "provider_subagent", event });
    }
  }

  private emit(event: AgentSessionEvent): void {
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

function assertClaudeThinkingOption(thinkingOptionId: string): void {
  if (!isClaudeThinkingOption(thinkingOptionId)) {
    throw new Error(`Claude Code 不支持思考强度：${thinkingOptionId}`);
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
    // 思考档位优先用应答里的 supportsEffort / supportedEffortLevels
    if (id === "default") {
      // `default` 表示不传 --model；沿用内置的中文标签
      models.push(
        withClaudeThinkingOptions(
          { ...builtinDefault, provider: providerId, ...(description ? { description } : {}) },
          entry,
        ),
      );
    } else {
      models.push(
        withClaudeThinkingOptions(
          { provider: providerId, id, label, ...(description ? { description } : {}) },
          entry,
        ),
      );
    }
  }
  if (models.length === 0) {
    return null;
  }
  if (!seen.has("default")) {
    models.unshift(withClaudeThinkingOptions({ ...builtinDefault, provider: providerId }));
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

/** 后台任务完成通知 → 已结束的工具卡片（参照 paseo task-notification-tool-call.ts） */
function mapTaskNotificationToToolCall(
  message: ClaudeTaskSystemMessage,
  taskId: string | null,
): ToolCallTimelineItem {
  const summary = typeof message.summary === "string" ? message.summary.trim() : "";
  const outputFile = typeof message.output_file === "string" ? message.output_file.trim() : "";
  const rawStatus = typeof message.status === "string" ? message.status.toLowerCase() : "";
  let status: ToolCallTimelineItem["status"] = "completed";
  if (rawStatus === "failed" || rawStatus === "error") {
    status = "failed";
  } else if (rawStatus === "stopped" || rawStatus === "killed") {
    status = "canceled";
  }
  const fallbackLabel =
    status === "failed" ? "后台任务失败" : status === "canceled" ? "后台任务已停止" : "后台任务已完成";
  const label = summary || fallbackLabel;
  return {
    type: "tool_call",
    callId: `task_notification_${taskId ?? randomUUID()}`,
    name: "task_notification",
    status,
    error: status === "failed" ? label : null,
    detail: {
      type: "plain_text",
      label,
      ...(outputFile ? { text: `输出文件：${outputFile}` } : {}),
    },
    metadata: {
      source: "claude_task_notification",
      ...(taskId ? { taskId } : {}),
      ...(rawStatus ? { status: rawStatus } : {}),
    },
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

/** 派出子代理的工具（Workflow 也走 task 协议，但它的卡片由 CLI 自己的 Workflow 调用承载） */
function isClaudeSubagentToolName(name: string): boolean {
  return name === "Task" || name === "Agent" || name === "Workflow";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 带非空 parent_tool_use_id 的消息来自子代理（sidechain） */
function readParentToolUseId(message: ClaudeOutputMessage): string | null {
  if (!("parent_tool_use_id" in message)) {
    return null;
  }
  const value = message.parent_tool_use_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}
