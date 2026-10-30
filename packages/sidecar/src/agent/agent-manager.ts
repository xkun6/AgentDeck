import { randomBytes, randomUUID } from "node:crypto";

import type {
  AgentBackgroundTask,
  AgentBackgroundTaskOutput,
  AgentMcpStatusResult,
  AgentStatusSection,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentProviderId,
  AgentSlashCommand,
  AgentSnapshot,
  AgentStatus,
  AgentStreamEnvelope,
  AgentStreamEvent,
  AgentTimelineItem,
  AgentUsage,
  ComputerUseApproval,
  ProviderSubagentDescriptor,
  ProviderSubagentUpdate,
} from "@agentdeck/protocol";

import { createSilentLogger, type Logger } from "../logger.js";
import { CLAUDE_COMPUTER_USE_TOOL_PREFIX, COMPUTER_USE_POLICY_DENIED } from "../providers/shared/interop.js";
import { withTimeout } from "../utils/promise-timeout.js";
import { normalizeCwd, type SnapshotService } from "../snapshots/snapshot-service.js";
import type { UsageLedger } from "../usage/ledger.js";
import { UsageTurnTracker } from "../usage/turn-tracker.js";
import type { AgentStore, PendingNativeFork, PersistedAgentMeta } from "./agent-store.js";
import { isDispatcher } from "./cache-keepalive.js";
import { AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS, AgentStreamCoalescer } from "./coalescer.js";
import { AgentInvalidParamsError, AgentRpcError } from "./errors.js";
import {
  ProviderSubagentStore,
  type SubagentTimelinePage,
  type SubagentTimelineQuery,
} from "./provider-subagent-store.js";
import { dedupeSlashCommands } from "./slash-commands.js";
import { searchSources, type SearchResult } from "./timeline-search.js";
import { pageTimeline } from "./timeline-page.js";
import { compactToolCallUpdates, toolCallId } from "./timeline-compact.js";
import { limitTimelineItem } from "./timeline-limits.js";
import {
  limitPermissionRequest,
  limitPermissionResponse,
  restoreTruncatedInput,
  type TruncatedInputField,
} from "./permission-limits.js";
import type {
  AgentClient,
  AgentSession,
  AgentSessionConfig,
  AgentSessionEvent,
  InteropEndpoint,
  ProviderSubagentInputEvent,
} from "./types.js";

const SESSION_CLOSE_TIMEOUT_MS = 5_000;
/** 空闲回收扫描间隔（design.md 4.34） */
const IDLE_RECLAIM_SWEEP_MS = 60_000;
export const RECLAIM_NOT_SUPPORTED_MESSAGE = "该会话不支持恢复，回收后将无法继续对话";
const PREVIEW_MAX_CHARS = 120;
/** agent.tasks.output 的 maxBytes 缺省 / 上限 */
export const TASK_OUTPUT_DEFAULT_BYTES = 64 * 1024;
export const TASK_OUTPUT_MAX_BYTES = 256 * 1024;
export const RESUME_NOT_SUPPORTED_MESSAGE = "该会话无法恢复，请新建会话";
/** summary 方式分叉时注入的历史对话文本上限（字数，保留最后部分，design.md 4.23） */
export const FORK_TRANSCRIPT_MAX_CHARS = 60_000;
const FORK_TITLE_SOURCE_MAX_CHARS = 30;

export interface AgentClientLookup {
  get(provider: AgentProviderId): AgentClient | undefined;
}

export interface AgentManagerListener {
  onStream?(envelope: AgentStreamEnvelope): void;
  onState?(agent: AgentSnapshot): void;
  onRemoved?(agentId: string): void;
  /** provider 子代理变化（design.md 4.11） */
  onSubagent?(update: ProviderSubagentUpdate): void;
  /** 后台任务整表变化（design.md 4.15） */
  onTasks?(agentId: string, tasks: AgentBackgroundTask[]): void;
  /** 用户（非调度器内部）对会话发消息 / 插话 / 中断（design.md 4.25：目标循环据此暂停） */
  onUserAction?(agentId: string, kind: "send" | "steer" | "cancel"): void;
}

export interface AgentManagerOptions {
  registry: AgentClientLookup;
  logger?: Logger;
  /** 文本合并窗口，默认 60ms */
  coalesceWindowMs?: number;
  /** 进程级 epoch，默认随机生成 */
  epoch?: string;
  now?: () => number;
  /** 会话持久化（设置了 AGENTDECK_DATA_DIR 时传入）；不传则纯内存 */
  store?: AgentStore;
  /** 跨会话用量账本（design.md 4.20）；不传则不记录 */
  usage?: UsageLedger;
  /** 按回合文件快照（design.md 4.24）；不传则不拍快照 */
  snapshots?: SnapshotService;
  /**
   * 会话互通（design.md 4.26）：返回该会话当前应注入的 MCP 端点，互通关闭时返回 undefined；
   * computerUseEndpointFor 返回 Computer Use 代理端点（design.md 4.37），未启用时返回 undefined；
   * computerUseApproval 返回当前 Computer Use 审批策略
   */
  interop?: {
    endpointFor(agentId: string): InteropEndpoint | undefined;
    computerUseEndpointFor?(agentId: string): InteropEndpoint | undefined;
    computerUseApproval?(): ComputerUseApproval;
  };
  /** 空闲回收设置（design.md 4.34）：每次扫描时读取；不传则不自动回收 */
  idleReclaim?: () => { enabled: boolean; idleMinutes: number };
  /** 翻译（design.md 4.35）：开启翻译的会话发出用户消息前调用；失败抛错即不发送。不传则不翻译 */
  translatePrompt?: (prompt: AgentPromptInput) => Promise<AgentPromptInput>;
  /** 翻译（design.md 4.35）：把用户在审批 / 提问 / 表单里填写的文字翻成 Agent 语言；失败抛错即不提交 */
  translateToAgent?: (text: string) => Promise<string>;
  /** 用户新建会话是否默认开启翻译（design.md 4.35）；不传视为 false */
  translationDefault?: () => boolean;
  /** 是否翻译用户输入（消息与审批回答，design.md 4.35）；不传视为 true */
  translateInput?: () => boolean;
}

export interface CreateAgentParams {
  /** 预先指定 agentId（委派时需要先用 id 建 worktree 分支）；缺省随机生成 */
  id?: string;
  /** 父会话与来源（design.md 4.26 / 4.27 / 4.28）；缺省为用户直接创建 */
  parentAgentId?: string;
  /** 派单回传的接收会话（design.md 4.26） */
  reportToAgentId?: string;
  /** 并行协作组 id（design.md 4.27） */
  groupId?: string;
  origin?: NonNullable<AgentSnapshot["origin"]>;
  provider: AgentProviderId;
  cwd: string;
  model?: string;
  modeId?: string;
  /** null / 省略 = 跟随 CLI 自身设置（design.md 4.10） */
  thinkingOptionId?: string | null;
  title?: string;
  /** 会话翻译开关；省略 = 用户新建的会话取默认设置（design.md 4.35） */
  translation?: boolean;
}

interface SentTurn {
  prompt: AgentPromptInput;
  clientMessageId?: string;
  /** startTurn 返回后才有 */
  turnId: string | null;
  /** 已收到本轮首个 timeline / permission_requested 输出 */
  hasOutput: boolean;
  /** 已写入 user_message_retracted */
  retracted: boolean;
  /** 缓存保活发出的回合（design.md 4.36）：turn_started 标 origin keepalive */
  keepAlive?: boolean;
}

interface ToolCallSlot {
  first: AgentStreamEnvelope;
  last: AgentStreamEnvelope;
}

interface ManagedAgent {
  id: string;
  /** 历史会话的 provider 可能已不存在 */
  client: AgentClient | undefined;
  /** 活跃的原生会话；dormant / closed 时为 null */
  session: AgentSession | null;
  snapshot: AgentSnapshot;
  /** null：历史会话的 timeline 尚未从磁盘读取（首次 agent.timeline / 恢复时惰性加载） */
  entries: AgentStreamEnvelope[] | null;
  entriesLoading: Promise<AgentStreamEnvelope[]> | null;
  /** 内存时间线里每个 callId 的首条与最新一条（design.md 4.5）；与 entries 同生共死 */
  toolCallIndex: Map<string, ToolCallSlot> | null;
  /** 事件尾链：保证同一 agent 的事件按到达顺序串行处理 */
  tail: Promise<void>;
  unsubscribe: () => void;
  /** agent.send 已受理（含恢复会话）、startTurn 尚未返回 */
  sending: boolean;
  finishedTurnIds: Set<string>;
  /** 当前进行中的 CLI 自发轮次（turn_started.origin 为 background，design.md 4.12）；agent.send 可接管 */
  backgroundTurnId: string | null;
  /** 当前 agent.send 发起的回合（供撤回，design.md 4.16）；回合结束 / 撤回完成后清空 */
  sentTurn: SentTurn | null;
  /** 被截断过 input 的挂起审批（requestId → 被截断的顶层字段）；应答时还原未被用户改动的字段，见 permission-limits.ts */
  truncatedPermissions: Map<string, TruncatedInputField[]>;
  /** 没有可用会话（关闭中 / 已关闭 / dormant） */
  closed: boolean;
  /** 进行中的恢复 */
  resuming: Promise<void> | null;
  /** 进行中的关闭 */
  closing: Promise<void> | null;
  /** 已从注册表删除 */
  removed: boolean;
  /** 最近一次推送的后台任务表（内存缓存，design.md 4.15） */
  backgroundTasks: AgentBackgroundTask[];
  /** 最近一次活动时间（design.md 4.34，只在内存）：创建 / 恢复完成 / agent.send 受理 / 发出 stream 事件 */
  lastActivityAt: number;
  /** 建会话时取到的模型目录（切换模型后校验思考强度用）；null 表示尚未取到 */
  models: AgentModelDefinition[] | null;
  /** summary 方式分叉：首次 agent.send 时前置的历史对话文本（design.md 4.23），随 meta 持久化，不进快照 */
  pendingForkContext?: string;
  /** native 方式分叉且新会话尚未拿到自己的原生 id（Claude 懒启动）：恢复 / 首次拉起时仍需带分叉参数 */
  pendingFork?: PendingNativeFork;
}

/**
 * 会话注册表：分配 agentId、维护 seq/epoch、串行处理事件、合并文本、权限中转、单 turn 约束，
 * 以及会话持久化与恢复（design.md 4.5）。
 */
export class AgentManager {
  readonly epoch: string;

  private readonly agents = new Map<string, ManagedAgent>();
  /** sidecar 自己发起的审批（Computer Use 代理，design.md 4.37）：requestId → 等待方 */
  private readonly hostPermissions = new Map<
    string,
    { agentId: string; settle: (response: AgentPermissionResponse) => void }
  >();
  /** 按 Computer Use 审批策略代答的 CLI 审批 id：provider 随后发的 permission_resolved 不再下发 */
  private readonly autoAnsweredPermissions = new Set<string>();
  private readonly listeners = new Set<AgentManagerListener>();
  private readonly registry: AgentClientLookup;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly coalescer: AgentStreamCoalescer;
  private readonly store: AgentStore | undefined;
  private readonly usage: UsageLedger | undefined;
  private readonly snapshots: SnapshotService | undefined;
  private readonly interop: AgentManagerOptions["interop"];
  private readonly idleReclaim: AgentManagerOptions["idleReclaim"];
  private readonly translatePrompt: AgentManagerOptions["translatePrompt"];
  private readonly translateToAgent: AgentManagerOptions["translateToAgent"];
  private readonly translationDefault: AgentManagerOptions["translationDefault"];
  private readonly translateInput: AgentManagerOptions["translateInput"];
  private idleReclaimTimer: NodeJS.Timeout | null = null;
  /** 每个会话的回合账本折叠器（只在内存） */
  private readonly usageTrackers = new Map<string, UsageTurnTracker>();
  /** provider 子代理（只在内存，会话关闭 / 删除时清空） */
  private readonly subagents: ProviderSubagentStore;

  constructor(options: AgentManagerOptions) {
    this.registry = options.registry;
    this.store = options.store;
    this.usage = options.usage;
    this.snapshots = options.snapshots;
    this.interop = options.interop;
    this.idleReclaim = options.idleReclaim;
    this.translatePrompt = options.translatePrompt;
    this.translateToAgent = options.translateToAgent;
    this.translationDefault = options.translationDefault;
    this.translateInput = options.translateInput;
    this.logger = options.logger ?? createSilentLogger();
    this.now = options.now ?? Date.now;
    this.epoch = options.epoch ?? randomBytes(8).toString("hex");
    this.subagents = new ProviderSubagentStore(this.now);
    if (this.idleReclaim) {
      this.idleReclaimTimer = setInterval(() => void this.reclaimIdleAgents(), IDLE_RECLAIM_SWEEP_MS);
      this.idleReclaimTimer.unref();
    }
    this.coalescer = new AgentStreamCoalescer({
      windowMs: options.coalesceWindowMs ?? AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS,
      timers: { setTimeout, clearTimeout },
      onFlush: ({ agentId, item, turnId }) => {
        const agent = this.agents.get(agentId);
        if (!agent) {
          return;
        }
        this.applyAndEmit(agent, {
          type: "timeline",
          item,
          ...(turnId !== undefined ? { turnId } : {}),
        });
      },
    });
  }

  subscribe(listener: AgentManagerListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // 请求入口
  // -------------------------------------------------------------------------

  async createAgent(params: CreateAgentParams): Promise<AgentSnapshot> {
    const client = this.registry.get(params.provider);
    if (!client) {
      throw new AgentRpcError("PROVIDER_NOT_FOUND", `未知的 provider：${params.provider}`);
    }
    const availability = await client.isAvailable();
    if (!availability.available) {
      throw new AgentRpcError(
        "PROVIDER_UNAVAILABLE",
        availability.reason ?? `provider ${params.provider} 当前不可用`,
      );
    }

    const fetchCatalog = () =>
      client.fetchCatalog({ cwd: params.cwd }).catch((error: unknown) => {
        this.logger.warn("获取 %s 模型目录失败：%s", params.provider, String(error));
        return null;
      });

    let catalog = await fetchCatalog();

    const thinkingOptionId = params.thinkingOptionId ?? null;
    const id = params.id ?? randomUUID();
    const interop = this.interop?.endpointFor(id);
    const computerUse = this.interop?.computerUseEndpointFor?.(id);
    const session = await client.createSession({
      cwd: params.cwd,
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.modeId !== undefined ? { modeId: params.modeId } : {}),
      ...(thinkingOptionId !== null ? { thinkingOptionId } : {}),
      ...(interop ? { interop } : {}),
      ...(computerUse ? { computerUse } : {}),
    });

    // ACP 等 provider 的模式要建会话后才可得：建会话前为空时再取一次（失败只记日志）。
    // modeId 不随目录变化，保持 null 表示使用 provider 默认值。
    if (!catalog || catalog.modes.length === 0) {
      catalog = (await fetchCatalog()) ?? catalog;
    }

    const now = this.now();
    const snapshot: AgentSnapshot = {
      id,
      provider: params.provider,
      cwd: params.cwd,
      ...(params.title !== undefined ? { title: params.title } : {}),
      ...(params.parentAgentId !== undefined ? { parentAgentId: params.parentAgentId } : {}),
      ...(params.reportToAgentId !== undefined ? { reportToAgentId: params.reportToAgentId } : {}),
      ...(params.origin !== undefined ? { origin: params.origin } : {}),
      ...(params.groupId !== undefined ? { groupId: params.groupId } : {}),
      ...((params.translation ?? ((params.origin ?? "user") === "user" && this.translationDefault?.()))
        ? { translation: true }
        : {}),
      model: params.model ?? null,
      modeId: params.modeId ?? null,
      thinkingOptionId,
      ...(catalog ? { availableModes: catalog.modes } : {}),
      status: "idle",
      activeTurnId: null,
      pendingPermissions: [],
      lastError: null,
      persistence: session.describePersistence(),
      lastSeq: 0,
      resumable: false,
      createdAt: now,
      updatedAt: now,
    };
    const agent: ManagedAgent = {
      ...newManagedAgent(id, client, snapshot, this.now()),
      session,
      entries: [],
      toolCallIndex: new Map(),
      closed: false,
      models: catalog?.models ?? null,
    };
    this.refreshResumable(agent);
    this.agents.set(id, agent);
    agent.unsubscribe = session.subscribe((event) => this.enqueueEvent(agent, event));
    this.logger.info("创建 agent %s（provider=%s, cwd=%s）", id, params.provider, params.cwd);
    void this.persistNow(agent);
    this.emitState(agent);
    return cloneSnapshot(snapshot);
  }

  /**
   * 启动时从磁盘恢复历史会话（design.md 4.5）：starting / idle / running / error → dormant，
   * closed 保持 closed；timeline 惰性读取。未启用持久化时为空操作。返回恢复的数量。
   */
  async restore(): Promise<number> {
    if (!this.store) {
      return 0;
    }
    const metas = await this.store.loadAll();
    let restored = 0;
    for (const metaWithFork of metas) {
      if (this.agents.has(metaWithFork.id)) {
        continue;
      }
      const { pendingForkContext, pendingFork, ...meta } = metaWithFork;
      const snapshot: AgentSnapshot = {
        ...meta,
        status: meta.status === "closed" ? "closed" : "dormant",
        activeTurnId: null,
        pendingPermissions: [],
      };
      const agent = newManagedAgent(meta.id, this.registry.get(meta.provider), snapshot, this.now());
      if (pendingForkContext !== undefined) {
        agent.pendingForkContext = pendingForkContext;
      }
      if (pendingFork !== undefined) {
        agent.pendingFork = pendingFork;
      }
      this.refreshResumable(agent);
      this.agents.set(meta.id, agent);
      restored += 1;
    }
    this.logger.info("从 %s 恢复了 %d 个历史会话", this.store.agentsDir, restored);
    return restored;
  }

  /** 按 updatedAt 倒序 */
  listAgents(): AgentSnapshot[] {
    return Array.from(this.agents.values(), (agent) => cloneSnapshot(agent.snapshot)).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
  }

  getAgent(agentId: string): AgentSnapshot {
    return cloneSnapshot(this.requireAgent(agentId).snapshot);
  }

  /** 会话开启翻译且翻译输入时把用户 prompt 翻成 Agent 语言（design.md 4.35）；否则原样返回 */
  private async translateForAgent(agent: ManagedAgent, prompt: AgentPromptInput): Promise<AgentPromptInput> {
    if (!agent.snapshot.translation || !this.translatePrompt || this.translateInput?.() === false) {
      return prompt;
    }
    return this.translatePrompt(prompt);
  }

  async sendPrompt(
    agentId: string,
    prompt: AgentPromptInput,
    clientMessageId?: string,
    /**
     * internal = 调度器发出的消息（design.md 4.25），不算用户介入；
     * translate = 用户经 agent.send 发出，会话开启翻译时先翻成 Agent 语言（design.md 4.35）；
     * keepAlive = 缓存保活（design.md 4.36，与 internal 同用），该回合的 turn_started 标 origin keepalive
     */
    opts?: { internal?: boolean; translate?: boolean; keepAlive?: boolean },
  ): Promise<{ turnId: string }> {
    const agent = this.requireAgent(agentId);
    // 恢复期间也持有 sending：并发 send 只触发一次恢复，其余按单 turn 约束返回 TURN_IN_PROGRESS。
    // CLI 自发轮次例外：由 provider 的 startTurn 结束它并开始新回合（design.md 4.12）
    const busy = agent.snapshot.status === "running" || Boolean(agent.snapshot.activeTurnId);
    const inBackgroundTurn =
      agent.backgroundTurnId !== null && agent.snapshot.activeTurnId === agent.backgroundTurnId;
    if (agent.sending || (busy && !inBackgroundTurn)) {
      throw new AgentRpcError("TURN_IN_PROGRESS", "该 agent 正在执行中，请等待当前回合结束或先取消");
    }

    if (!opts?.internal) {
      this.emitUserAction(agentId, "send");
    }
    agent.sending = true;
    agent.lastActivityAt = this.now();
    try {
      // 向已归档会话发消息自动取消归档（design.md 4.17），随后续的 agent.state 一并推送
      if (agent.snapshot.archived) {
        agent.snapshot.archived = false;
      }
      const sent = opts?.translate ? await this.translateForAgent(agent, prompt) : prompt;
      const session = await this.ensureSession(agent);
      const sentTurn: SentTurn = {
        prompt,
        ...(clientMessageId !== undefined ? { clientMessageId } : {}),
        turnId: null,
        hasOutput: false,
        retracted: false,
        ...(opts?.keepAlive ? { keepAlive: true } : {}),
      };
      agent.sentTurn = sentTurn;
      // user_message 先在事件链中占位（排在 startTurn 期间 provider 发出的事件之前），
      // startTurn 成功返回后才写入；失败则不写，避免留下没有回合的用户消息（design.md 4.4）
      let settleUserMessage!: (sent: boolean) => void;
      const userMessageSent = new Promise<boolean>((resolve) => {
        settleUserMessage = resolve;
      });
      const userMessage: AgentStreamEvent = {
        type: "timeline",
        item: {
          type: "user_message",
          ...userMessageText(prompt, sent),
          ...(clientMessageId !== undefined ? { clientMessageId } : {}),
        },
      };
      this.runInChain(agent, async () => {
        if (await userMessageSent) {
          this.processEvent(agent, userMessage);
        }
      });
      let turnId: string;
      const forkContext = agent.pendingForkContext;
      try {
        ({ turnId } = await session.startTurn(
          forkContext !== undefined ? prependForkContext(sent, forkContext) : sent,
          clientMessageId !== undefined ? { clientMessageId } : undefined,
        ));
      } catch (error) {
        settleUserMessage(false);
        if (agent.sentTurn === sentTurn) {
          agent.sentTurn = null;
        }
        throw error;
      }
      sentTurn.turnId = turnId;
      settleUserMessage(true);
      if (forkContext !== undefined && agent.pendingForkContext === forkContext) {
        // 已随首条消息发给 Agent：清除并落盘（design.md 4.23）
        delete agent.pendingForkContext;
        void this.persistNow(agent);
      }
      // 放进尾链：session 在 startTurn 返回前发出的事件都已排在前面，
      // 若 turn 已结束（finishedTurnIds）则不再标记 running。
      this.runInChain(agent, () => {
        if (agent.closed || agent.finishedTurnIds.has(turnId)) {
          if (agent.sentTurn === sentTurn) {
            agent.sentTurn = null;
          }
          return;
        }
        if (agent.snapshot.status !== "running" || agent.snapshot.activeTurnId !== turnId) {
          agent.snapshot.status = "running";
          agent.snapshot.activeTurnId = turnId;
          agent.snapshot.lastError = null;
          this.touch(agent);
          this.emitState(agent);
        }
      });
      // 持有 sending 直到尾链处理完，保证返回时快照已是 running（或该 turn 已结束），避免并发 send 钻空子
      await agent.tail;
      return { turnId };
    } finally {
      agent.sending = false;
    }
  }

  /**
   * design.md 4.14：斜杠命令（按 name 去重）。有活会话且实现了 listCommands 时用它，
   * 否则（dormant / closed / 未实现）取 provider 目录的 commands；不为此恢复会话。
   */
  async listCommands(agentId: string): Promise<AgentSlashCommand[]> {
    const agent = this.requireAgent(agentId);
    const session = agent.closed ? null : agent.session;
    if (session?.listCommands) {
      try {
        return dedupeSlashCommands(await session.listCommands());
      } catch (error) {
        this.logger.warn("获取 agent %s 的斜杠命令失败，改用目录：%s", agent.id, errorMessage(error));
      }
    }
    const client = this.registry.get(agent.snapshot.provider) ?? agent.client;
    if (!client) {
      return [];
    }
    const catalog = await client
      .fetchCatalog({ cwd: agent.snapshot.cwd })
      .catch((error: unknown) => {
        this.logger.warn("获取 %s 模型目录失败：%s", agent.snapshot.provider, errorMessage(error));
        return null;
      });
    return dedupeSlashCommands(catalog?.commands ?? []);
  }

  /** design.md 4.14：MCP 服务器状态；dormant / closed 且可恢复时先恢复会话，不受单 turn 约束 */
  async getMcpStatus(agentId: string): Promise<AgentMcpStatusResult> {
    const session = await this.ensureSession(this.requireAgent(agentId));
    if (!session.getMcpStatus) {
      throw new AgentRpcError("NOT_SUPPORTED", "该 Agent 不支持查看 MCP 服务器");
    }
    return session.getMcpStatus();
  }

  /** design.md 4.14：AgentDeck 本地 /status；会话处理同 getMcpStatus */
  async getStatus(agentId: string): Promise<{ sections: AgentStatusSection[] }> {
    const session = await this.ensureSession(this.requireAgent(agentId));
    if (!session.getStatus) {
      throw new AgentRpcError("NOT_SUPPORTED", "该 Agent 不支持查看状态");
    }
    return { sections: await session.getStatus() };
  }

  /** design.md 4.14：重连 MCP 后返回最新状态；会话处理同 getMcpStatus */
  async reconnectMcp(agentId: string, serverName?: string): Promise<AgentMcpStatusResult> {
    const session = await this.ensureSession(this.requireAgent(agentId));
    if (!session.reconnectMcp || !session.getMcpStatus) {
      throw new AgentRpcError("NOT_SUPPORTED", "该 Agent 不支持重连 MCP 服务器");
    }
    await session.reconnectMcp(serverName);
    return session.getMcpStatus();
  }

  /** design.md 4.15：后台任务列表；有活会话且实现了 listBackgroundTasks 时取会话的，否则取缓存；不恢复会话 */
  listBackgroundTasks(agentId: string): AgentBackgroundTask[] {
    const agent = this.requireAgent(agentId);
    const session = agent.closed ? null : agent.session;
    return session?.listBackgroundTasks ? session.listBackgroundTasks() : [...agent.backgroundTasks];
  }

  /** design.md 4.15：停止单个后台任务；需要会话进程在运行，不为此恢复会话 */
  async stopBackgroundTask(agentId: string, taskId: string): Promise<void> {
    const session = this.requireTaskSession(agentId);
    if (!session.stopBackgroundTask) {
      throw new AgentRpcError("NOT_SUPPORTED", "该 Agent 不支持后台任务");
    }
    await session.stopBackgroundTask(taskId);
  }

  /** design.md 4.15：读后台命令输出尾部；maxBytes 缺省 64KB、上限 256KB */
  async readBackgroundTaskOutput(
    agentId: string,
    taskId: string,
    maxBytes?: number,
  ): Promise<AgentBackgroundTaskOutput> {
    const session = this.requireTaskSession(agentId);
    if (!session.readBackgroundTaskOutput) {
      throw new AgentRpcError("NOT_SUPPORTED", "该 Agent 不支持后台任务");
    }
    return session.readBackgroundTaskOutput(
      taskId,
      Math.min(maxBytes ?? TASK_OUTPUT_DEFAULT_BYTES, TASK_OUTPUT_MAX_BYTES),
    );
  }

  private requireTaskSession(agentId: string): AgentSession {
    const agent = this.requireAgent(agentId);
    const session = agent.closed ? null : agent.session;
    if (!session) {
      throw new AgentRpcError("AGENT_CLOSED", "会话进程未运行，无法操作后台任务");
    }
    return session;
  }

  async cancel(agentId: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    if (agent.closed) {
      return;
    }
    if (!agent.snapshot.activeTurnId && agent.snapshot.status !== "running" && !agent.sending) {
      return;
    }
    this.emitUserAction(agentId, "cancel");
    await agent.session?.interrupt();
    await agent.tail;
  }

  /**
   * design.md 4.22：运行中插话。校验当前有进行中的（非自发）回合且 provider 支持后，把 user_message
   * （steer: true，归属当前 turnId）占位进事件链，provider.steer 成功后才写入；失败不落盘。
   */
  async steer(
    agentId: string,
    prompt: AgentPromptInput,
    clientMessageId?: string,
    /** translate 同 sendPrompt（design.md 4.35）；翻译在校验之前，翻译期间回合结束则按无回合处理 */
    opts?: { translate?: boolean },
  ): Promise<void> {
    const agent = this.requireAgent(agentId);
    const sent = opts?.translate ? await this.translateForAgent(agent, prompt) : prompt;
    // 先等已到达的事件处理完，activeTurnId 才准确
    await agent.tail;
    const turnId = agent.snapshot.activeTurnId;
    const session = agent.closed ? null : agent.session;
    if (!session || !turnId || agent.finishedTurnIds.has(turnId)) {
      throw new AgentRpcError("NOT_SUPPORTED", "当前没有进行中的回合");
    }
    if (!session.steer) {
      throw new AgentRpcError("NOT_SUPPORTED", "该 Agent 不支持运行中插话");
    }
    if (agent.backgroundTurnId === turnId) {
      throw new AgentRpcError("NOT_SUPPORTED", "CLI 自发轮次进行中不支持插话，请直接发送消息");
    }
    this.emitUserAction(agentId, "steer");
    let settleUserMessage!: (sent: boolean) => void;
    const userMessageSent = new Promise<boolean>((resolve) => {
      settleUserMessage = resolve;
    });
    const userMessage: AgentStreamEvent = {
      type: "timeline",
      turnId,
      item: {
        type: "user_message",
        ...userMessageText(prompt, sent),
        ...(clientMessageId !== undefined ? { clientMessageId } : {}),
        steer: true,
      },
    };
    this.runInChain(agent, async () => {
      if (await userMessageSent) {
        this.processEvent(agent, userMessage);
      }
    });
    try {
      await session.steer(
        sent,
        clientMessageId !== undefined ? { clientMessageId } : undefined,
      );
    } catch (error) {
      settleUserMessage(false);
      throw error;
    }
    settleUserMessage(true);
    await agent.tail;
  }

  /**
   * design.md 4.16：Agent 首次响应前撤回本轮用户消息。校验与写入 user_message_retracted
   * 在同一事件链任务内完成（与输出事件串行，避免竞态），随后走与 cancel 相同的中断路径。
   */
  async retract(agentId: string): Promise<{ prompt: AgentPromptInput; clientMessageId?: string }> {
    const agent = this.requireAgent(agentId);
    // 先等已到达的事件处理完，hasOutput 才准确
    await agent.tail;
    const turn = agent.sentTurn;
    const unavailable = (message: string) => new AgentRpcError("RETRACT_UNAVAILABLE", message);
    if (
      agent.closed ||
      !turn ||
      turn.turnId === null ||
      turn.retracted ||
      agent.snapshot.activeTurnId !== turn.turnId ||
      agent.backgroundTurnId === turn.turnId
    ) {
      throw unavailable("当前没有可撤回的回合");
    }
    if (turn.hasOutput) {
      throw unavailable("Agent 已开始响应，无法撤回");
    }
    // 先占住，防并发重复撤回；链内再校验一次输出
    turn.retracted = true;
    const turnId = turn.turnId;
    let written = false;
    this.runInChain(agent, () => {
      if (turn.hasOutput || agent.sentTurn !== turn) {
        return;
      }
      written = true;
      this.processEvent(agent, {
        type: "user_message_retracted",
        turnId,
        ...(turn.clientMessageId !== undefined ? { clientMessageId: turn.clientMessageId } : {}),
      });
    });
    await agent.tail;
    if (!written) {
      turn.retracted = false;
      throw unavailable("Agent 已开始响应，无法撤回");
    }
    await this.cancel(agentId);
    return {
      prompt: turn.prompt,
      ...(turn.clientMessageId !== undefined ? { clientMessageId: turn.clientMessageId } : {}),
    };
  }

  /**
   * design.md 4.23：基于原会话新建分叉会话。throughSeq 缺省 = 整个会话（原会话运行中返回 TURN_IN_PROGRESS）；
   * 给出时必须落在已结束的回合上，只保留到该回合结束。provider 支持原生分叉（且无需截断或有回合锚点）
   * 时走原生，否则新建空会话并把对话整理成文本，首次 agent.send 时前置注入。原生分叉失败 →
   * PROVIDER_UNAVAILABLE，且不会留下新会话。
   */
  async forkAgent(
    agentId: string,
    opts: { throughSeq?: number; title?: string } = {},
  ): Promise<AgentSnapshot> {
    const origin = this.requireAgent(agentId);
    // 先等已到达的事件处理完，再读时间线
    await origin.tail;
    const entries = await this.loadEntries(origin);
    const busy =
      origin.snapshot.status === "running" ||
      Boolean(origin.snapshot.activeTurnId) ||
      origin.sending;
    const plan = planFork(entries, opts.throughSeq, busy);

    const client = this.registry.get(origin.snapshot.provider) ?? origin.client;
    if (!client) {
      throw new AgentRpcError("PROVIDER_NOT_FOUND", `未知的 provider：${origin.snapshot.provider}`);
    }
    const availability = await client.isAvailable();
    if (!availability.available) {
      throw new AgentRpcError(
        "PROVIDER_UNAVAILABLE",
        availability.reason ?? `provider ${origin.snapshot.provider} 当前不可用`,
      );
    }

    const originSnapshot = origin.snapshot;
    const id = randomUUID();
    const forkInterop = this.interop?.endpointFor(id);
    const forkComputerUse = this.interop?.computerUseEndpointFor?.(id);
    const cfg: AgentSessionConfig = {
      cwd: originSnapshot.cwd,
      ...(forkInterop ? { interop: forkInterop } : {}),
      ...(forkComputerUse ? { computerUse: forkComputerUse } : {}),
      ...(originSnapshot.model != null ? { model: originSnapshot.model } : {}),
      ...(originSnapshot.modeId != null ? { modeId: originSnapshot.modeId } : {}),
      ...(originSnapshot.thinkingOptionId != null
        ? { thinkingOptionId: originSnapshot.thinkingOptionId }
        : {}),
    };
    const originHandle = originSnapshot.persistence;
    const native =
      client.forkSession !== undefined &&
      Boolean(originHandle?.sessionId) &&
      (plan.whole || plan.nativeRef !== undefined);

    let session: AgentSession;
    try {
      session = native
        ? await client.forkSession!(structuredClone(originHandle!), {
            ...cfg,
            ...(!plan.whole && plan.nativeRef !== undefined ? { nativeRef: plan.nativeRef } : {}),
          })
        : await client.createSession(cfg);
    } catch (error) {
      const message = errorMessage(error);
      this.logger.warn("分叉 agent %s 失败：%s", origin.id, message);
      throw new AgentRpcError(
        "PROVIDER_UNAVAILABLE",
        native ? `原生分叉会话失败：${message}` : `创建分叉会话失败：${message}`,
      );
    }

    const retained = entries.filter((entry) => entry.seq <= plan.endSeq);
    const originTitle = forkSourceTitle(originSnapshot);
    const now = this.now();
    const copied: AgentStreamEnvelope[] = retained.map((entry, index) =>
      copyForkEntry(entry, id, index + 1, this.epoch),
    );
    copied.push({
      agentId: id,
      seq: copied.length + 1,
      epoch: this.epoch,
      timestamp: now,
      event: { type: "timeline", item: { type: "notice", text: `已从「${originTitle}」分叉` } },
    });

    const handle = session.describePersistence();
    const title = opts.title?.trim() || `${originTitle}（分叉）`;
    const preview = firstUserPreview(copied);
    const snapshot: AgentSnapshot = {
      id,
      provider: originSnapshot.provider,
      cwd: originSnapshot.cwd,
      title,
      model: originSnapshot.model ?? null,
      modeId: originSnapshot.modeId ?? null,
      thinkingOptionId: originSnapshot.thinkingOptionId ?? null,
      ...(originSnapshot.availableModes ? { availableModes: originSnapshot.availableModes } : {}),
      status: "idle",
      activeTurnId: null,
      pendingPermissions: [],
      lastError: null,
      persistence: handle,
      ...(preview !== undefined ? { preview } : {}),
      ...(originSnapshot.translation ? { translation: true } : {}),
      lastSeq: copied.length,
      resumable: false,
      createdAt: now,
      updatedAt: now,
    };
    const agent: ManagedAgent = {
      ...newManagedAgent(id, client, snapshot, this.now()),
      session,
      entries: copied,
      toolCallIndex: buildToolCallIndex(copied),
      closed: false,
      models: origin.models,
    };
    if (native && handle === null) {
      // 新会话还没有自己的原生 id（Claude 进程懒启动）：记下来，首次拉起 / 恢复时仍带分叉参数
      agent.pendingFork = {
        handle: structuredClone(originHandle!),
        ...(!plan.whole && plan.nativeRef !== undefined ? { nativeRef: plan.nativeRef } : {}),
      };
    } else if (!native) {
      const transcript = buildForkTranscript(retained);
      if (transcript) {
        agent.pendingForkContext = transcript;
      }
    }
    this.refreshResumable(agent);
    this.agents.set(id, agent);
    agent.unsubscribe = session.subscribe((event) => this.enqueueEvent(agent, event));
    for (const entry of copied) {
      this.store?.appendEntry(id, entry);
    }
    this.logger.info(
      "分叉 agent %s → %s（方式=%s, 截至 seq=%d）",
      origin.id,
      id,
      native ? "native" : "summary",
      plan.endSeq,
    );
    await this.persistNow(agent);
    this.emitState(agent);
    return cloneSnapshot(snapshot);
  }

  async respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void> {
    const host = this.hostPermissions.get(requestId);
    if (host && host.agentId === agentId) {
      // sidecar 发起的审批：直接交给等待方，不经 provider
      const agent = this.requireAgent(agentId);
      this.hostPermissions.delete(requestId);
      agent.truncatedPermissions.delete(requestId);
      host.settle(response);
      this.enqueueEvent(agent, { type: "permission_resolved", requestId, response });
      await agent.tail;
      return;
    }
    const agent = this.requireOpenAgent(agentId);
    const request = agent.snapshot.pendingPermissions.find((item) => item.id === requestId);
    if (!request) {
      throw new AgentRpcError("PERMISSION_NOT_FOUND", `找不到待处理的权限请求：${requestId}`);
    }
    // 翻译失败在这里抛出：请求保持待处理，截断记录也还在，可重试
    const translated = await this.translatePermissionResponse(agent, request, response);
    // 回传给 provider 的 updatedInput：UI 没改过的被截断字段换回原始值
    const truncated = agent.truncatedPermissions.get(requestId);
    agent.truncatedPermissions.delete(requestId);
    const outgoing: AgentPermissionResponse =
      truncated && translated.behavior === "allow" && translated.updatedInput
        ? { ...translated, updatedInput: restoreTruncatedInput(translated.updatedInput, truncated) }
        : translated;
    await this.requireSession(agent).respondToPermission(requestId, outgoing);
    // 兜底：session 未发 permission_resolved 时补发（已解决的会在处理时被去重丢弃）
    this.enqueueEvent(agent, { type: "permission_resolved", requestId, response });
    await agent.tail;
  }

  /** 当前模式下 CLI 是否自己审批 MCP 工具调用（design.md 4.37）；会话未加载或不支持判断时为 false */
  cliApprovesMcpTools(agentId: string): boolean {
    return this.agents.get(agentId)?.session?.cliApprovesMcpTools?.() ?? false;
  }

  /**
   * sidecar 自己发起的工具审批（Computer Use 代理，design.md 4.37）：在该会话发出 permission_requested，
   * 等用户经 agent.permission.respond 应答。回合结束 / 会话关闭视为拒绝；signal 中断时撤回请求。
   */
  requestHostPermission(
    agentId: string,
    request: Omit<AgentPermissionRequest, "id" | "provider">,
    signal?: AbortSignal,
  ): Promise<AgentPermissionResponse> {
    const agent = this.requireOpenAgent(agentId);
    const id = `cu-${randomUUID()}`;
    return new Promise((resolve) => {
      const onAbort = () => {
        if (!this.hostPermissions.delete(id)) {
          return;
        }
        const response: AgentPermissionResponse = { behavior: "deny", message: "权限请求已取消" };
        this.enqueueEvent(agent, { type: "permission_resolved", requestId: id, response });
        resolve(response);
      };
      this.hostPermissions.set(id, {
        agentId,
        settle: (response) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(response);
        },
      });
      this.enqueueEvent(agent, {
        type: "permission_requested",
        request: { ...request, id, provider: agent.snapshot.provider },
      });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Computer Use 审批策略为允许 / 拒绝时（design.md 4.37），Claude CLI 发来的 Computer Use 工具审批直接代答，
   * 不下发、不进快照；返回 true 表示已代答
   */
  private autoAnswerComputerUse(agent: ManagedAgent, request: AgentPermissionRequest): boolean {
    if (request.kind !== "tool" || !request.name.startsWith(CLAUDE_COMPUTER_USE_TOOL_PREFIX) || !agent.session) {
      return false;
    }
    const approval = this.interop?.computerUseApproval?.();
    if (approval !== "allow" && approval !== "deny") {
      return false;
    }
    const response: AgentPermissionResponse =
      approval === "allow" ? { behavior: "allow" } : { behavior: "deny", message: COMPUTER_USE_POLICY_DENIED };
    this.autoAnsweredPermissions.add(request.id);
    agent.session.respondToPermission(request.id, response).catch((error: unknown) => {
      this.autoAnsweredPermissions.delete(request.id);
      this.logger.warn("agent %s 代答 Computer Use 审批 %s 失败：%s", agent.id, request.id, String(error));
    });
    return true;
  }

  /** 结束该会话所有 sidecar 发起的审批（视为拒绝）；快照里的 pendingPermissions 由调用方清空 */
  private denyHostPermissions(agentId: string, message: string): void {
    for (const [id, pending] of this.hostPermissions) {
      if (pending.agentId === agentId) {
        this.hostPermissions.delete(id);
        pending.settle({ behavior: "deny", message });
      }
    }
  }

  /**
   * design.md 4.35：会话开启翻译且翻译输入时，把用户填写的文字翻成 Agent 语言——拒绝理由、提问回答（整值都是选项
   * label 的原样保留，isSecret 题不翻）、MCP 表单里无 format 的非 secret 文本字段。
   */
  private async translatePermissionResponse(
    agent: ManagedAgent,
    request: AgentPermissionRequest,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResponse> {
    const translate = this.translateToAgent;
    if (!agent.snapshot.translation || !translate || this.translateInput?.() === false) {
      return response;
    }
    if (response.behavior === "deny") {
      return response.message?.trim() ? { ...response, message: await translate(response.message) } : response;
    }
    const input = response.updatedInput;
    const detail = request.detail;
    if (!input || !detail) {
      return response;
    }
    if (detail.type === "question" && isPlainRecord(input.answers)) {
      const answers: Record<string, unknown> = { ...input.answers };
      await Promise.all(
        detail.questions.map(async (question) => {
          const value = answers[question.question];
          if (typeof value !== "string" || !value.trim() || question.isSecret) {
            return;
          }
          const labels = new Set(question.options.map((option) => option.label));
          if (value.split(", ").every((part) => labels.has(part))) {
            return;
          }
          answers[question.question] = await translate(value);
        }),
      );
      return { ...response, updatedInput: { ...input, answers } };
    }
    if (detail.type === "elicitation" && isPlainRecord(input.content)) {
      const content: Record<string, unknown> = { ...input.content };
      await Promise.all(
        (detail.fields ?? []).map(async (field) => {
          const value = content[field.key];
          if (field.type !== "string" || field.format || field.secret || typeof value !== "string" || !value.trim()) {
            return;
          }
          content[field.key] = await translate(value);
        }),
      );
      return { ...response, updatedInput: { ...input, content } };
    }
    return response;
  }

  async setModel(agentId: string, modelId: string | null): Promise<AgentSnapshot> {
    const agent = this.requireOpenAgent(agentId);
    const session = this.requireSession(agent);
    if (!session.setModel) {
      throw new AgentRpcError("NOT_SUPPORTED", `provider ${agent.snapshot.provider} 不支持切换模型`);
    }
    await session.setModel(modelId);
    this.enqueueEvent(agent, { type: "model_changed", modelId });
    await agent.tail;
    await this.reconcileThinkingForModel(agent, session, modelId);
    return cloneSnapshot(agent.snapshot);
  }

  /** design.md 4.10：切换思考强度，下一轮生效；运行中切换时返回 provider 给出的提示 */
  async setThinking(
    agentId: string,
    thinkingOptionId: string | null,
  ): Promise<{ agent: AgentSnapshot; notice?: string }> {
    const agent = this.requireOpenAgent(agentId);
    const session = this.requireSession(agent);
    if (!session.setThinking) {
      throw new AgentRpcError(
        "NOT_SUPPORTED",
        `provider ${agent.snapshot.provider} 不支持切换思考强度`,
      );
    }
    const result = await session.setThinking(thinkingOptionId);
    this.enqueueEvent(agent, { type: "thinking_option_changed", thinkingOptionId });
    await agent.tail;
    const notice = result?.notice;
    return { agent: cloneSnapshot(agent.snapshot), ...(notice ? { notice } : {}) };
  }

  async setMode(agentId: string, modeId: string): Promise<AgentSnapshot> {
    const agent = this.requireOpenAgent(agentId);
    const session = this.requireSession(agent);
    if (!session.setMode) {
      throw new AgentRpcError("NOT_SUPPORTED", `provider ${agent.snapshot.provider} 不支持切换模式`);
    }
    await session.setMode(modeId);
    this.enqueueEvent(agent, { type: "mode_changed", modeId });
    await agent.tail;
    return cloneSnapshot(agent.snapshot);
  }

  async close(agentId: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    await this.closeAgent(agent, "closed");
  }

  /** design.md 4.34：手动回收——结束 provider 进程，会话转为 dormant；未加载时原样返回 */
  async reclaim(agentId: string): Promise<AgentSnapshot> {
    const agent = this.requireAgent(agentId);
    if (agent.session === null && !agent.resuming) {
      return cloneSnapshot(agent.snapshot);
    }
    const snapshot = agent.snapshot;
    if (
      agent.sending ||
      agent.resuming ||
      snapshot.status === "running" ||
      snapshot.status === "starting" ||
      snapshot.activeTurnId
    ) {
      throw new AgentRpcError("TURN_IN_PROGRESS", "该 agent 正在执行中，请等待当前回合结束或先取消");
    }
    if (!snapshot.resumable) {
      throw new AgentRpcError("NOT_SUPPORTED", RECLAIM_NOT_SUPPORTED_MESSAGE);
    }
    this.logger.info("回收空闲 agent %s（手动）", agent.id);
    await this.closeAgent(agent, "dormant");
    return cloneSnapshot(agent.snapshot);
  }

  /** design.md 4.34：自动回收扫描一轮，返回被回收的 agentId */
  async reclaimIdleAgents(): Promise<string[]> {
    const settings = this.idleReclaim?.();
    if (!settings?.enabled) {
      return [];
    }
    const now = this.now();
    const thresholdMs = settings.idleMinutes * 60_000;
    const targets = Array.from(this.agents.values()).filter(
      (agent) =>
        isIdleReclaimable(agent) && !this.waitingOnChild(agent) && now - agent.lastActivityAt >= thresholdMs,
    );
    await Promise.allSettled(
      targets.map((agent) => {
        this.logger.info(
          "回收空闲 agent %s（空闲 %d 分钟）",
          agent.id,
          Math.floor((now - agent.lastActivityAt) / 60_000),
        );
        return this.closeAgent(agent, "dormant");
      }),
    );
    return targets.map((agent) => agent.id);
  }

  /** design.md 4.26：派单任务完成后回收干活的会话，条件同自动回收，只是不等空闲时长；未回收返回 false */
  async reclaimIfIdle(agentId: string): Promise<boolean> {
    const agent = this.agents.get(agentId);
    if (this.idleReclaim?.().enabled === false || !agent || !isIdleReclaimable(agent) || this.waitingOnChild(agent)) {
      return false;
    }
    this.logger.info("回收空闲 agent %s（派单任务已完成）", agent.id);
    await this.closeAgent(agent, "dormant");
    return true;
  }

  /**
   * 不自动回收：有派单出去的会话仍在工作（design.md 4.26）；或开启缓存保活，且是派单会话或有子会话仍在工作（4.36，否则保活无从发出）
   */
  private waitingOnChild(agent: ManagedAgent): boolean {
    // 已归档的不保活（cache-keepalive.ts），不必为它留着进程
    const keepAlive = agent.snapshot.cacheKeepAlive === true && agent.snapshot.archived !== true;
    if (keepAlive && isDispatcher(agent.snapshot, Array.from(this.agents.values(), (other) => other.snapshot))) {
      return true;
    }
    for (const other of this.agents.values()) {
      const child = other.snapshot;
      if (
        (child.reportToAgentId === agent.id || (keepAlive && child.parentAgentId === agent.id)) &&
        (child.status === "running" ||
          child.status === "starting" ||
          Boolean(child.activeTurnId) ||
          child.backgroundActive === true)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * design.md 4.17：只改元数据（标题 / 置顶 / 归档）。任何状态可调，不恢复会话、不受单 turn 约束、
   * 不改 updatedAt；立即落盘 meta 并推 agent.state。title 为 null / 空白 = 清除自定义标题。
   */
  async updateAgent(
    agentId: string,
    patch: {
      title?: string | null;
      pinned?: boolean;
      archived?: boolean;
      interopTarget?: boolean;
      translation?: boolean;
      cacheKeepAlive?: boolean;
    },
  ): Promise<AgentSnapshot> {
    const agent = this.requireAgent(agentId);
    const snapshot = agent.snapshot;
    // 缓存保活只对 Claude 类 provider 可开（design.md 4.36）；先校验，不合法时整个 patch 都不生效
    if (patch.cacheKeepAlive === true && this.registry.get(snapshot.provider)?.kind !== "claude") {
      throw new AgentRpcError("NOT_SUPPORTED", "该 Agent 不支持缓存保活");
    }
    if (patch.title !== undefined) {
      const title = patch.title?.trim() ?? "";
      if (title) {
        snapshot.title = title;
      } else {
        delete snapshot.title;
      }
    }
    if (patch.pinned !== undefined) {
      snapshot.pinned = patch.pinned;
    }
    if (patch.archived !== undefined) {
      snapshot.archived = patch.archived;
    }
    if (patch.interopTarget !== undefined) {
      snapshot.interopTarget = patch.interopTarget;
    }
    if (patch.translation !== undefined) {
      snapshot.translation = patch.translation;
    }
    if (patch.cacheKeepAlive !== undefined) {
      snapshot.cacheKeepAlive = patch.cacheKeepAlive;
    }
    await this.persistNow(agent);
    this.emitState(agent);
    return cloneSnapshot(snapshot);
  }

  /** 解除（null）或设置并行协作组 id（design.md 4.27）：落盘并推 agent.state，不改 updatedAt */
  async setGroupId(agentId: string, groupId: string | null): Promise<void> {
    const agent = this.requireAgent(agentId);
    if (groupId === null) {
      delete agent.snapshot.groupId;
    } else {
      agent.snapshot.groupId = groupId;
    }
    await this.persistNow(agent);
    this.emitState(agent);
  }

  /**
   * 等会话当前回合结束（design.md 4.26 的 wait）：已经不在运行 / 启动 / 发送中则立即返回 true；
   * 超时返回 false。signal 触发（调用方断开）时返回 false 并停止监听。
   */
  waitForIdle(agentId: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const agent = this.requireAgent(agentId);
    const isIdle = () =>
      !agent.sending &&
      agent.snapshot.status !== "running" &&
      agent.snapshot.status !== "starting" &&
      !agent.snapshot.activeTurnId;
    if (isIdle()) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (idle: boolean) => {
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        resolve(idle);
      };
      const onAbort = () => finish(false);
      const unsubscribe = this.subscribe({
        onState: (snapshot) => {
          if (snapshot.id === agentId && isIdle()) {
            finish(true);
          }
        },
        onRemoved: (removedId) => {
          if (removedId === agentId) {
            finish(true);
          }
        },
      });
      timer = setTimeout(() => finish(false), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** agent.delete：若在运行先关闭，然后从磁盘与注册表删除，广播 agent.removed */
  async deleteAgent(agentId: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    await this.closeAgent(agent, "closed");
    // 先删磁盘：失败时 agent 留在注册表（已关闭），错误返回给调用方
    await this.store?.deleteAgent(agent.id);
    if (agent.removed) {
      return;
    }
    this.clearSubagents(agent);
    this.usageTrackers.delete(agent.id);
    void this.snapshots?.removeAgent(agent.id, agent.snapshot.cwd);
    agent.removed = true;
    this.agents.delete(agent.id);
    this.coalescer.flushAndDiscard(agent.id);
    this.logger.info("删除 agent %s", agent.id);
    for (const listener of this.listeners) {
      try {
        listener.onRemoved?.(agent.id);
      } catch (error) {
        this.logger.error("agent.removed 监听器出错：%s", String(error));
      }
    }
  }

  /**
   * design.md 4.19：全文搜索。会话按 updatedAt 倒序；已加载时间线的会话用内存条目，
   * 其余流式读取 timeline.jsonl（不为此加载整份时间线）。
   */
  search(query: string, limit: number, agentIds?: string[]): Promise<SearchResult> {
    const allowed = agentIds ? new Set(agentIds) : null;
    const sources = Array.from(this.agents.values())
      .filter((agent) => !allowed || allowed.has(agent.id))
      .sort((a, b) => b.snapshot.updatedAt - a.snapshot.updatedAt)
      .map((agent) => ({
        agentId: agent.id,
        entries: () => {
          const loaded = agent.entries;
          if (loaded) {
            return [...loaded];
          }
          return this.store ? this.store.streamTimeline(agent.id) : [];
        },
      }));
    return searchSources(sources, query, limit, (agentId, error) =>
      this.logger.warn("搜索 agent %s 的 timeline 失败：%s", agentId, errorMessage(error)),
    );
  }

  /**
   * 历史条目保留原 seq / epoch；返回的 epoch 为当前进程 epoch。
   * 给 `page` 时为向前分页（design.md 4.31），返回 `hasOlder`；调用方保证不与 `sinceSeq` 同时给出。
   */
  async timeline(
    agentId: string,
    sinceSeq?: number,
    page?: { beforeSeq?: number; limit: number },
  ): Promise<{ epoch: string; entries: AgentStreamEnvelope[]; hasOlder?: boolean }> {
    const agent = this.requireAgent(agentId);
    const entries = await this.loadEntries(agent);
    if (page) {
      return { epoch: this.epoch, ...pageTimeline(entries, page) };
    }
    const since = sinceSeq ?? 0;
    return {
      epoch: this.epoch,
      entries: entries.filter((entry) => entry.seq > since),
    };
  }

  /** design.md 4.11：该会话全部层级的 provider 子代理 */
  listSubagents(agentId: string): ProviderSubagentDescriptor[] {
    this.requireAgent(agentId);
    return this.subagents.list(agentId);
  }

  /** design.md 4.11：子代理时间线分页；子代理不存在返回空 */
  subagentTimeline(
    agentId: string,
    subagentId: string,
    query?: SubagentTimelineQuery,
  ): SubagentTimelinePage {
    this.requireAgent(agentId);
    return this.subagents.fetchTimeline(agentId, subagentId, query);
  }

  /**
   * 关闭全部会话并落盘（sidecar 退出前调用）。
   * 先落盘一次，防止关闭会话超时、进程被强制退出时丢数据；启用持久化时关闭后的状态记为 dormant。
   */
  async shutdown(): Promise<void> {
    if (this.idleReclaimTimer) {
      clearInterval(this.idleReclaimTimer);
      this.idleReclaimTimer = null;
    }
    await this.flush();
    const live = Array.from(this.agents.values()).filter(
      (agent) => agent.session !== null || agent.resuming !== null,
    );
    const finalStatus: AgentStatus = this.store ? "dormant" : "closed";
    await Promise.allSettled(live.map((agent) => this.closeAgent(agent, finalStatus)));
    this.coalescer.flushAll();
    await this.flush();
    await this.snapshots?.idle();
  }

  /** 强制落盘全部待写数据（未启用持久化时为空操作） */
  async flush(): Promise<void> {
    await this.store?.flushAll();
    await this.usage?.flush();
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /**
   * 切换模型后：新模型不支持当前思考强度（目录里该模型没有此档位）时回退为跟随 CLI（null）。
   * 目录取不到或目录里找不到该模型时不动。
   */
  private async reconcileThinkingForModel(
    agent: ManagedAgent,
    session: AgentSession,
    modelId: string | null,
  ): Promise<void> {
    const current = agent.snapshot.thinkingOptionId ?? null;
    if (current === null || !session.setThinking) {
      return;
    }
    let models = agent.models;
    if (!models && agent.client) {
      const catalog = await agent.client
        .fetchCatalog({ cwd: agent.snapshot.cwd })
        .catch((error: unknown) => {
          this.logger.warn("获取 %s 模型目录失败：%s", agent.snapshot.provider, errorMessage(error));
          return null;
        });
      models = catalog?.models ?? null;
      agent.models = models;
    }
    const model = models?.find((entry) =>
      modelId === null ? entry.isDefault === true : entry.id === modelId,
    );
    if (!model || model.thinkingOptions?.some((option) => option.id === current)) {
      return;
    }
    this.logger.info(
      "agent %s 的模型 %s 不支持思考强度 %s，回退为跟随 CLI 设置",
      agent.id,
      modelId ?? "默认",
      current,
    );
    try {
      await session.setThinking(null);
    } catch (error) {
      this.logger.warn("agent %s 回退思考强度失败：%s", agent.id, errorMessage(error));
      return;
    }
    this.enqueueEvent(agent, { type: "thinking_option_changed", thinkingOptionId: null });
    await agent.tail;
  }

  private closeAgent(agent: ManagedAgent, finalStatus: AgentStatus): Promise<void> {
    if (!agent.closing) {
      agent.closing = this.doCloseAgent(agent, finalStatus).finally(() => {
        agent.closing = null;
      });
    }
    return agent.closing;
  }

  private async doCloseAgent(agent: ManagedAgent, finalStatus: AgentStatus): Promise<void> {
    if (agent.resuming) {
      await agent.resuming.catch(() => undefined);
    }
    const session = agent.session;
    if (!session) {
      // 未加载的历史会话被显式关闭：只改状态
      if (finalStatus === "closed" && agent.snapshot.status !== "closed") {
        agent.snapshot.status = "closed";
        this.touch(agent);
        await this.persistNow(agent);
        this.emitState(agent);
      }
      return;
    }
    agent.closed = true;
    try {
      await withTimeout(session.close(), SESSION_CLOSE_TIMEOUT_MS, "关闭会话超时");
    } catch (error) {
      this.logger.warn("关闭 agent %s 出错：%s", agent.id, String(error));
    }
    await agent.tail;
    this.coalescer.flushAndDiscard(agent.id);
    this.clearSubagents(agent);
    agent.unsubscribe();
    agent.unsubscribe = () => undefined;
    agent.session = null;
    agent.snapshot.status = finalStatus;
    agent.snapshot.activeTurnId = null;
    agent.snapshot.pendingPermissions = [];
    this.denyHostPermissions(agent.id, "会话已关闭");
    delete agent.snapshot.backgroundActive;
    this.touch(agent);
    await this.persistNow(agent);
    this.logger.info("关闭 agent %s", agent.id);
    this.emitState(agent);
  }

  /**
   * 恢复前按 provider id 重新取 client：自定义 provider（4.7）可能已被替换为新配置或被删除。
   * 运行中的会话不经过这里，继续使用创建时的会话对象（旧配置）直到关闭。
   */
  private refreshClient(agent: ManagedAgent): void {
    const client = this.registry.get(agent.snapshot.provider);
    if (!client) {
      agent.client = undefined;
      if (agent.snapshot.persistence?.sessionId) {
        throw new AgentRpcError(
          "PROVIDER_NOT_FOUND",
          `provider 已被删除或停用：${agent.snapshot.provider}`,
        );
      }
      return;
    }
    const hadClient = agent.client !== undefined;
    agent.client = client;
    if (!hadClient) {
      // 启动时 provider 不存在、之后才出现（如自定义 provider 重新启用）：重新判断能否恢复
      this.refreshResumable(agent);
    }
  }

  /** 不可恢复时：dormant 返回 NOT_SUPPORTED（4.5），closed 返回 AGENT_CLOSED（4.4） */
  private assertResumable(agent: ManagedAgent): void {
    if (agent.pendingFork && agent.client?.forkSession) {
      return;
    }
    if (agent.snapshot.resumable && agent.snapshot.persistence && agent.client?.resumeSession) {
      return;
    }
    if (agent.snapshot.status === "dormant") {
      throw new AgentRpcError("NOT_SUPPORTED", RESUME_NOT_SUPPORTED_MESSAGE);
    }
    throw new AgentRpcError("AGENT_CLOSED", `agent 已关闭：${agent.id}`);
  }

  /**
   * 返回可用的会话：未加载（dormant / closed）且可恢复时先恢复（design.md 4.5），并发调用共用同一次恢复
   * （agent.resuming）；不可恢复按 assertResumable 报错，关闭中返回 AGENT_CLOSED。
   */
  private async ensureSession(agent: ManagedAgent): Promise<AgentSession> {
    if (agent.closing) {
      // 关闭 / 回收进行中：等它结束后按 dormant / closed 恢复（design.md 4.34）
      await agent.closing;
      if (agent.removed) {
        throw new AgentRpcError("AGENT_NOT_FOUND", `找不到 agent：${agent.id}`);
      }
    }
    if (agent.session === null && !agent.resuming) {
      this.refreshClient(agent);
      this.assertResumable(agent);
      agent.resuming = this.resumeAgent(agent).finally(() => {
        agent.resuming = null;
      });
    }
    if (agent.resuming) {
      await agent.resuming;
    }
    const session = agent.session as AgentSession | null;
    if (agent.closed || !session) {
      throw new AgentRpcError("AGENT_CLOSED", `agent 已关闭：${agent.id}`);
    }
    return session;
  }

  /** dormant / closed → starting → idle；失败时回到原状态并写 lastError */
  private async resumeAgent(agent: ManagedAgent): Promise<void> {
    const client = agent.client!;
    const persistence = agent.snapshot.persistence;
    const pendingFork = agent.pendingFork;
    const previousStatus = agent.snapshot.status;
    // 先读历史 timeline：seq 从磁盘与 meta 中较大者继续递增
    await this.loadEntries(agent);

    agent.snapshot.status = "starting";
    this.touch(agent);
    this.emitState(agent);

    let session: AgentSession;
    try {
      const availability = await client.isAvailable();
      if (!availability.available) {
        throw new Error(availability.reason ?? `provider ${agent.snapshot.provider} 当前不可用`);
      }
      // 会话进程每次拉起都重新注入当前端口与 token（design.md 4.26）
      const interop = this.interop?.endpointFor(agent.id);
      const computerUse = this.interop?.computerUseEndpointFor?.(agent.id);
      if (pendingFork && !persistence?.sessionId) {
        // 分叉会话在拿到自己的原生 id 前被关闭 / 重启：按原分叉参数重新派生（design.md 4.23）
        const { model, modeId, thinkingOptionId } = agent.snapshot;
        session = await client.forkSession!(structuredClone(pendingFork.handle), {
          cwd: agent.snapshot.cwd,
          ...(interop ? { interop } : {}),
          ...(computerUse ? { computerUse } : {}),
          ...(model != null ? { model } : {}),
          ...(modeId != null ? { modeId } : {}),
          ...(thinkingOptionId != null ? { thinkingOptionId } : {}),
          ...(pendingFork.nativeRef !== undefined ? { nativeRef: pendingFork.nativeRef } : {}),
        });
      } else {
        session = await client.resumeSession!(structuredClone(persistence!), {
          cwd: agent.snapshot.cwd,
          ...(interop ? { interop } : {}),
          ...(computerUse ? { computerUse } : {}),
        });
      }
    } catch (error) {
      const message = errorMessage(error);
      const notSupported = error instanceof AgentRpcError && error.code === "NOT_SUPPORTED";
      this.logger.warn("恢复 agent %s 失败：%s", agent.id, message);
      agent.snapshot.status = previousStatus;
      agent.snapshot.lastError = `恢复会话失败：${message}`;
      if (notSupported) {
        agent.snapshot.resumable = false;
      }
      this.touch(agent);
      await this.persistNow(agent);
      this.emitState(agent);
      if (notSupported) {
        throw new AgentRpcError("NOT_SUPPORTED", RESUME_NOT_SUPPORTED_MESSAGE);
      }
      throw new AgentRpcError("PROVIDER_UNAVAILABLE", `恢复会话失败：${message}`);
    }

    agent.session = session;
    agent.closed = false;
    agent.finishedTurnIds = new Set();
    agent.unsubscribe = session.subscribe((event) => this.enqueueEvent(agent, event));

    // 恢复后重新设置快照记录的模型 / 模式 / 思考强度（provider 发出的变化事件与快照相同，会被去重）
    const { model, modeId, thinkingOptionId } = agent.snapshot;
    if (model != null && session.setModel) {
      await session.setModel(model).catch((error: unknown) => {
        this.logger.warn("恢复 agent %s 后设置模型 %s 失败：%s", agent.id, model, errorMessage(error));
      });
    }
    if (modeId != null && session.setMode) {
      await session.setMode(modeId).catch((error: unknown) => {
        this.logger.warn(
          "恢复 agent %s 后设置模式 %s 失败：%s",
          agent.id,
          modeId,
          errorMessage(error),
        );
      });
    }
    if (thinkingOptionId != null && session.setThinking) {
      await session.setThinking(thinkingOptionId).catch((error: unknown) => {
        this.logger.warn(
          "恢复 agent %s 后设置思考强度 %s 失败：%s",
          agent.id,
          thinkingOptionId,
          errorMessage(error),
        );
      });
    }
    await agent.tail;

    agent.snapshot.persistence = session.describePersistence() ?? persistence;
    this.refreshResumable(agent);
    agent.snapshot.status = "idle";
    agent.lastActivityAt = this.now();
    this.touch(agent);
    this.logger.info("恢复 agent %s（provider=%s）", agent.id, agent.snapshot.provider);
    this.emitState(agent);
  }

  private loadEntries(agent: ManagedAgent): Promise<AgentStreamEnvelope[]> {
    if (agent.entries) {
      return Promise.resolve(agent.entries);
    }
    if (!agent.entriesLoading) {
      const empty = { entries: [] as AgentStreamEnvelope[], lastSeq: 0 };
      const load = this.store ? this.store.readTimeline(agent.id) : Promise.resolve(empty);
      agent.entriesLoading = load
        .catch((error: unknown) => {
          this.logger.warn("读取 agent %s 的 timeline 失败：%s", agent.id, errorMessage(error));
          return empty;
        })
        .then(({ entries, lastSeq }) => {
          agent.entries = entries;
          agent.toolCallIndex = buildToolCallIndex(entries);
          agent.snapshot.lastSeq = Math.max(agent.snapshot.lastSeq, lastSeq);
          agent.entriesLoading = null;
          return entries;
        });
    }
    return agent.entriesLoading;
  }

  private refreshResumable(agent: ManagedAgent): void {
    agent.snapshot.resumable =
      Boolean(agent.snapshot.persistence?.sessionId && agent.client?.resumeSession) ||
      Boolean(agent.pendingFork && agent.client?.forkSession);
  }

  private requireSession(agent: ManagedAgent): AgentSession {
    if (!agent.session) {
      throw new AgentRpcError("AGENT_CLOSED", `agent 已关闭：${agent.id}`);
    }
    return agent.session;
  }

  private requireAgent(agentId: string): ManagedAgent {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new AgentRpcError("AGENT_NOT_FOUND", `找不到 agent：${agentId}`);
    }
    return agent;
  }

  private requireOpenAgent(agentId: string): ManagedAgent {
    const agent = this.requireAgent(agentId);
    if (agent.closed) {
      throw new AgentRpcError(
        "AGENT_CLOSED",
        agent.snapshot.status === "dormant"
          ? `agent 尚未加载：${agentId}（发送消息时自动恢复）`
          : `agent 已关闭：${agentId}`,
      );
    }
    return agent;
  }

  private runInChain(agent: ManagedAgent, task: () => void | Promise<void>): void {
    agent.tail = agent.tail.then(task).catch((error: unknown) => {
      this.logger.error("处理 agent %s 事件出错：%s", agent.id, String(error));
    });
  }

  private enqueueEvent(agent: ManagedAgent, event: AgentSessionEvent): void {
    this.runInChain(agent, () => this.processEvent(agent, event));
  }

  private processEvent(agent: ManagedAgent, rawEvent: AgentSessionEvent): void {
    if (rawEvent.type === "provider_background_tasks") {
      // 后台任务整表快照：缓存并广播，不进主时间线、不占 seq、不落盘
      if (!agent.removed) {
        agent.backgroundTasks = rawEvent.tasks;
        this.emitTasks(agent.id, rawEvent.tasks);
        this.refreshBackgroundActive(agent);
      }
      return;
    }
    if (rawEvent.type === "provider_subagent") {
      // 子代理事件写入子代理 store，不进主时间线、不占 seq
      this.applySubagentEvent(agent, rawEvent.event);
      return;
    }
    if (rawEvent.type === "permission_requested" && this.autoAnswerComputerUse(agent, rawEvent.request)) {
      return;
    }
    if (rawEvent.type === "permission_resolved" && this.autoAnsweredPermissions.delete(rawEvent.requestId)) {
      return;
    }
    const event = this.tagKeepAliveTurn(
      agent,
      this.limitPermissionSize(agent, this.limitToolCallSize(this.attachTurnId(agent, rawEvent))),
    );
    const sentTurn = agent.sentTurn;
    if (sentTurn) {
      if (sentTurn.retracted && event.type === "timeline") {
        // 撤回后到中断生效前 provider 可能仍吐出内容：丢弃，避免出现在已隐藏的回合之外
        return;
      }
      if (
        !sentTurn.hasOutput &&
        !sentTurn.retracted &&
        ((event.type === "timeline" && event.item.type !== "user_message") ||
          event.type === "permission_requested")
      ) {
        sentTurn.hasOutput = true;
      }
    }
    if (this.isDuplicate(agent, event)) {
      return;
    }
    if (this.coalescer.handle(agent.id, event)) {
      return;
    }
    // 非合并事件：先把缓冲的文本冲出去，保证顺序
    this.coalescer.flushFor(agent.id);
    this.applyAndEmit(agent, event);
  }

  /**
   * 审批请求的 input / detail 里过长的字符串截断后再进入快照 / 广播 / 落盘（design.md 4.31），
   * 保证 permission_requested 不会因超过远程网关的帧上限而发不出去；provider 持有的原始 input 不受影响。
   */
  private limitPermissionSize(agent: ManagedAgent, event: AgentStreamEvent): AgentStreamEvent {
    if (event.type === "permission_resolved") {
      const response = limitPermissionResponse(event.response);
      return response === event.response ? event : { ...event, response };
    }
    if (event.type !== "permission_requested") {
      return event;
    }
    const { request, truncatedInput } = limitPermissionRequest(event.request);
    if (request === event.request) {
      return event;
    }
    this.logger.warn("agent %s 的审批请求 %s 内容过大，已截断后下发", agent.id, request.id);
    if (truncatedInput.length > 0) {
      // 只保留仍挂起的条目，避免无人应答的请求长期占用内存
      const pendingIds = new Set(agent.snapshot.pendingPermissions.map((item) => item.id));
      for (const id of agent.truncatedPermissions.keys()) {
        if (!pendingIds.has(id)) {
          agent.truncatedPermissions.delete(id);
        }
      }
      agent.truncatedPermissions.set(request.id, truncatedInput);
    }
    return { ...event, request };
  }

  /** 缓存保活发出的回合（design.md 4.36）：provider 发的 turn_started 标上 origin keepalive */
  private tagKeepAliveTurn(agent: ManagedAgent, event: AgentStreamEvent): AgentStreamEvent {
    const sentTurn = agent.sentTurn;
    if (
      event.type !== "turn_started" ||
      event.origin !== undefined ||
      !sentTurn?.keepAlive ||
      (sentTurn.turnId !== null && sentTurn.turnId !== event.turnId)
    ) {
      return event;
    }
    return { ...event, origin: "keepalive" };
  }

  /** 工具调用项统一限制大小（文本截断、图片占位），先于合并 / 快照 / 广播 / 落盘（design.md 5.3） */
  private limitToolCallSize(event: AgentStreamEvent): AgentStreamEvent {
    if (event.type !== "timeline" || event.item.type !== "tool_call") {
      return event;
    }
    const item = limitTimelineItem(event.item);
    return item === event.item ? event : { ...event, item };
  }

  /** 子代理时间线占用（内存采样用） */
  subagentStats(): { rows: number; bytes: number } {
    return this.subagents.stats();
  }

  /** timeline / permission_requested 没带 turnId 时补上当前 turn */
  private attachTurnId(agent: ManagedAgent, event: AgentStreamEvent): AgentStreamEvent {
    const activeTurnId = agent.snapshot.activeTurnId;
    if (!activeTurnId) {
      return event;
    }
    if (
      (event.type === "timeline" || event.type === "permission_requested") &&
      event.turnId === undefined &&
      !(event.type === "timeline" && event.item.type === "user_message")
    ) {
      return { ...event, turnId: activeTurnId };
    }
    return event;
  }

  private isDuplicate(agent: ManagedAgent, event: AgentStreamEvent): boolean {
    const snapshot = agent.snapshot;
    switch (event.type) {
      case "permission_resolved":
        return !snapshot.pendingPermissions.some((request) => request.id === event.requestId);
      case "model_changed":
        return (snapshot.model ?? null) === event.modelId;
      case "mode_changed":
        return snapshot.modeId === event.modeId;
      case "thinking_option_changed":
        return (snapshot.thinkingOptionId ?? null) === event.thinkingOptionId;
      default:
        return false;
    }
  }

  private applyAndEmit(agent: ManagedAgent, event: AgentStreamEvent): void {
    const stateChanged = this.applyToSnapshot(agent, event);
    this.touch(agent);
    this.emitEnvelope(agent, event);
    if (
      event.type === "turn_completed" ||
      event.type === "turn_failed" ||
      event.type === "turn_canceled"
    ) {
      void this.persistNow(agent);
    }
    if (stateChanged) {
      this.emitState(agent);
    }
  }

  /** 按事件更新快照，返回是否需要推送 agent.state */
  private applyToSnapshot(agent: ManagedAgent, event: AgentStreamEvent): boolean {
    const snapshot = agent.snapshot;
    switch (event.type) {
      case "thread_started":
        // 分叉会话拿到了自己的原生 id：不再需要分叉参数
        delete agent.pendingFork;
        snapshot.persistence = agent.session?.describePersistence() ?? {
          provider: snapshot.provider,
          sessionId: event.sessionId,
        };
        this.refreshResumable(agent);
        return true;
      case "turn_started":
        if (agent.closed || agent.finishedTurnIds.has(event.turnId)) {
          return false;
        }
        snapshot.status = "running";
        snapshot.activeTurnId = event.turnId;
        snapshot.lastError = null;
        agent.backgroundTurnId = event.origin === "background" ? event.turnId : null;
        return true;
      case "turn_completed": {
        if (event.usage) {
          snapshot.lastUsage = event.usage;
        }
        // 本轮用量累加进 totalUsage；重复的 turn_completed 不重复累加（design.md 4.4）
        const counted =
          !agent.finishedTurnIds.has(event.turnId) && addToTotalUsage(snapshot, event.usage);
        return this.finishTurn(agent, event.turnId) || counted;
      }
      case "turn_failed":
        snapshot.lastError = event.error;
        this.finishTurn(agent, event.turnId);
        return true;
      case "turn_canceled":
        return this.finishTurn(agent, event.turnId);
      case "user_message_retracted":
        return false;
      case "permission_requested":
        if (!snapshot.pendingPermissions.some((request) => request.id === event.request.id)) {
          snapshot.pendingPermissions = [...snapshot.pendingPermissions, event.request];
        }
        return true;
      case "permission_resolved":
        snapshot.pendingPermissions = snapshot.pendingPermissions.filter(
          (request) => request.id !== event.requestId,
        );
        return true;
      case "usage_updated":
        // 浅合并：回合中只带上下文字段的更新不能抹掉 token / 费用字段（design.md 4.3）
        snapshot.lastUsage = { ...snapshot.lastUsage, ...event.usage };
        return false;
      case "rate_limits_updated":
        // 账户额度（design.md 4.30）：只写快照并推 agent.state，不进 totalUsage / 用量账本
        snapshot.rateLimits = event.rateLimits;
        return true;
      case "model_changed":
        snapshot.model = event.modelId;
        return true;
      case "mode_changed":
        snapshot.modeId = event.modeId;
        return true;
      case "thinking_option_changed":
        snapshot.thinkingOptionId = event.thinkingOptionId;
        return true;
      case "timeline":
        if (event.item.type === "user_message" && snapshot.preview === undefined) {
          const preview = toPreview(event.item.text);
          if (preview) {
            snapshot.preview = preview;
            return true;
          }
        }
        return false;
    }
  }

  private finishTurn(agent: ManagedAgent, turnId: string): boolean {
    agent.finishedTurnIds.add(turnId);
    if (agent.sentTurn?.turnId === turnId) {
      agent.sentTurn = null;
    }
    if (agent.backgroundTurnId === turnId) {
      agent.backgroundTurnId = null;
    }
    const snapshot = agent.snapshot;
    if (snapshot.activeTurnId && snapshot.activeTurnId !== turnId) {
      this.logger.warn(
        "agent %s 收到非当前 turn 的结束事件（active=%s, got=%s）",
        agent.id,
        snapshot.activeTurnId,
        turnId,
      );
      return false;
    }
    snapshot.activeTurnId = null;
    snapshot.pendingPermissions = [];
    this.denyHostPermissions(agent.id, "回合已结束");
    if (!agent.closed) {
      snapshot.status = "idle";
    }
    return true;
  }

  /** 更新 updatedAt 并安排 meta 防抖落盘 */
  private touch(agent: ManagedAgent): void {
    agent.snapshot.updatedAt = this.now();
    if (!agent.removed) {
      this.store?.scheduleMeta(agent.id, () => toPersistedMeta(agent));
    }
  }

  /** 立即落盘 meta（写失败只记日志，不抛错） */
  private persistNow(agent: ManagedAgent): Promise<void> {
    if (!this.store || agent.removed) {
      return Promise.resolve();
    }
    return this.store.flushMeta(agent.id, () => toPersistedMeta(agent));
  }

  /** 内存时间线追加：同 callId 的 tool_call 只留首条与最新一条（design.md 4.5） */
  private pushEntry(agent: ManagedAgent, envelope: AgentStreamEnvelope): void {
    const entries = agent.entries;
    if (!entries) {
      return;
    }
    const callId = toolCallId(envelope);
    if (callId !== undefined && agent.toolCallIndex) {
      const slot = agent.toolCallIndex.get(callId);
      if (slot) {
        if (slot.last !== slot.first) {
          const at = entries.lastIndexOf(slot.last);
          if (at >= 0) {
            entries.splice(at, 1);
          }
        }
        slot.last = envelope;
      } else {
        agent.toolCallIndex.set(callId, { first: envelope, last: envelope });
      }
    }
    entries.push(envelope);
  }

  private emitEnvelope(agent: ManagedAgent, event: AgentStreamEvent): void {
    agent.lastActivityAt = this.now();
    agent.snapshot.lastSeq += 1;
    const envelope: AgentStreamEnvelope = {
      agentId: agent.id,
      seq: agent.snapshot.lastSeq,
      epoch: this.epoch,
      timestamp: this.now(),
      event,
    };
    this.pushEntry(agent, envelope);
    this.recordUsage(agent, envelope);
    this.recordSnapshot(agent, envelope);
    if (!agent.removed) {
      this.store?.appendEntry(agent.id, envelope);
    }
    for (const listener of this.listeners) {
      try {
        listener.onStream?.(envelope);
      } catch (error) {
        this.logger.error("agent.stream 监听器出错：%s", String(error));
      }
    }
  }

  /** design.md 4.24：turn_started / 回合结束时异步拍快照（不阻塞事件链，失败只记日志） */
  private recordSnapshot(agent: ManagedAgent, envelope: AgentStreamEnvelope): void {
    const snapshots = this.snapshots;
    if (!snapshots || agent.removed) {
      return;
    }
    const event = envelope.event;
    const info = { agentId: agent.id, cwd: agent.snapshot.cwd, turnId: "" };
    let task: Promise<void> | undefined;
    switch (event.type) {
      case "turn_started":
        task = snapshots.onTurnStarted({
          ...info,
          turnId: event.turnId,
          seq: envelope.seq,
          startedAt: envelope.timestamp,
        });
        break;
      case "turn_completed":
      case "turn_failed":
      case "turn_canceled":
        task = snapshots.onTurnEnded({ ...info, turnId: event.turnId });
        break;
      default:
        return;
    }
    task.catch((error: unknown) =>
      this.logger.warn("agent %s 的快照任务出错：%s", agent.id, errorMessage(error)),
    );
  }

  /** 同一工作目录上是否有任一会话正在跑回合（含 send / 恢复中），供快照回滚与清理判断 */
  isCwdBusy(cwd: string): boolean {
    const key = normalizeCwd(cwd);
    return Array.from(this.agents.values()).some(
      (agent) =>
        normalizeCwd(agent.snapshot.cwd) === key &&
        (agent.sending ||
          agent.resuming !== null ||
          agent.snapshot.status === "running" ||
          Boolean(agent.snapshot.activeTurnId)),
    );
  }

  /** design.md 4.20：回合结束时向账本追加一行（失败只记日志） */
  private recordUsage(agent: ManagedAgent, envelope: AgentStreamEnvelope): void {
    if (!this.usage) {
      return;
    }
    try {
      let tracker = this.usageTrackers.get(agent.id);
      if (!tracker) {
        tracker = new UsageTurnTracker(agent.id, agent.snapshot.provider);
        this.usageTrackers.set(agent.id, tracker);
      }
      const record = tracker.observe(envelope, agent.snapshot.model ?? null);
      if (record) {
        this.usage.record(record);
      }
    } catch (error) {
      this.logger.warn("记录 agent %s 的用量失败：%s", agent.id, errorMessage(error));
    }
  }

  private applySubagentEvent(agent: ManagedAgent, event: ProviderSubagentInputEvent): void {
    if (agent.removed) {
      return;
    }
    this.emitSubagentUpdate(this.subagents.apply(agent.id, agent.snapshot.provider, event));
    this.refreshBackgroundActive(agent);
  }

  /**
   * 重算快照的 backgroundActive（design.md 4.11 / 4.15）：有 running 子代理或 running 后台任务。
   * 值变化时推 agent.state；不 touch、不落盘（该字段不持久化）；缺省 = false。
   */
  private refreshBackgroundActive(agent: ManagedAgent): void {
    const active =
      !agent.closed &&
      (this.subagents.list(agent.id).some((subagent) => subagent.status === "running") ||
        agent.backgroundTasks.some((task) => task.status === "running"));
    if ((agent.snapshot.backgroundActive === true) === active) {
      return;
    }
    if (active) {
      agent.snapshot.backgroundActive = true;
    } else {
      delete agent.snapshot.backgroundActive;
    }
    this.emitState(agent);
  }

  /** 会话关闭 / 删除：清空该会话的子代理并逐个广播 remove */
  private clearSubagents(agent: ManagedAgent): void {
    for (const update of this.subagents.deleteParent(agent.id)) {
      this.emitSubagentUpdate(update);
    }
  }

  private emitTasks(agentId: string, tasks: AgentBackgroundTask[]): void {
    for (const listener of this.listeners) {
      try {
        listener.onTasks?.(agentId, tasks);
      } catch (error) {
        this.logger.error("agent.tasks.update 监听器出错：%s", String(error));
      }
    }
  }

  private emitSubagentUpdate(update: ProviderSubagentUpdate): void {
    for (const listener of this.listeners) {
      try {
        listener.onSubagent?.(update);
      } catch (error) {
        this.logger.error("agent.subagents.update 监听器出错：%s", String(error));
      }
    }
  }

  private emitUserAction(agentId: string, kind: "send" | "steer" | "cancel"): void {
    for (const listener of this.listeners) {
      try {
        listener.onUserAction?.(agentId, kind);
      } catch (error) {
        this.logger.error("用户操作监听器出错：%s", String(error));
      }
    }
  }

  private emitState(agent: ManagedAgent): void {
    if (agent.removed) {
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener.onState?.(cloneSnapshot(agent.snapshot));
      } catch (error) {
        this.logger.error("agent.state 监听器出错：%s", String(error));
      }
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** user_message 的文本：原文，翻译后的文本不同时另带 translatedText（design.md 4.35） */
function userMessageText(
  prompt: AgentPromptInput,
  sent: AgentPromptInput,
): { text: string; translatedText?: string } {
  const text = promptToText(prompt);
  const translatedText = promptToText(sent);
  return translatedText !== text ? { text, translatedText } : { text };
}

function promptToText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  return prompt
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function cloneSnapshot(snapshot: AgentSnapshot): AgentSnapshot {
  return structuredClone(snapshot);
}

function buildToolCallIndex(entries: AgentStreamEnvelope[]): Map<string, ToolCallSlot> {
  const index = new Map<string, ToolCallSlot>();
  for (const entry of entries) {
    const callId = toolCallId(entry);
    if (callId === undefined) {
      continue;
    }
    const slot = index.get(callId);
    if (slot) {
      slot.last = entry;
    } else {
      index.set(callId, { first: entry, last: entry });
    }
  }
  return index;
}

function newManagedAgent(
  id: string,
  client: AgentClient | undefined,
  snapshot: AgentSnapshot,
  now: number,
): ManagedAgent {
  return {
    id,
    client,
    session: null,
    snapshot,
    entries: null,
    entriesLoading: null,
    toolCallIndex: null,
    tail: Promise.resolve(),
    unsubscribe: () => undefined,
    sending: false,
    finishedTurnIds: new Set(),
    truncatedPermissions: new Map(),
    backgroundTurnId: null,
    sentTurn: null,
    closed: true,
    resuming: null,
    closing: null,
    removed: false,
    backgroundTasks: [],
    lastActivityAt: now,
    models: null,
  };
}

/** 自动回收候选（design.md 4.34）：已加载、空闲、无挂起审批与后台活动、可恢复、未置顶 */
function isIdleReclaimable(agent: ManagedAgent): boolean {
  const snapshot = agent.snapshot;
  return (
    agent.session !== null &&
    !agent.closed &&
    agent.closing === null &&
    agent.resuming === null &&
    !agent.sending &&
    !agent.removed &&
    (snapshot.status === "idle" || snapshot.status === "error") &&
    !snapshot.activeTurnId &&
    snapshot.pendingPermissions.length === 0 &&
    snapshot.backgroundActive !== true &&
    snapshot.resumable === true &&
    snapshot.pinned !== true
  );
}

/** 把本轮 token 累加进 totalUsage（缺失的一项按 0）；两项都不是有限数字时不动，返回是否累加 */
function addToTotalUsage(snapshot: AgentSnapshot, usage: AgentUsage | undefined): boolean {
  const input = finiteOrNull(usage?.inputTokens);
  const output = finiteOrNull(usage?.outputTokens);
  if (input === null && output === null) {
    return false;
  }
  const total = snapshot.totalUsage ?? { inputTokens: 0, outputTokens: 0 };
  snapshot.totalUsage = {
    inputTokens: total.inputTokens + (input ?? 0),
    outputTokens: total.outputTokens + (output ?? 0),
  };
  return true;
}

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** meta.json：快照中除 pendingPermissions / activeTurnId / backgroundActive 外的字段，加上分叉相关的待处理状态（不进快照） */
function toPersistedMeta(agent: ManagedAgent): PersistedAgentMeta {
  const {
    pendingPermissions: _pending,
    activeTurnId: _active,
    backgroundActive: _background,
    ...rest
  } = agent.snapshot;
  return structuredClone({
    ...rest,
    ...(agent.pendingForkContext !== undefined
      ? { pendingForkContext: agent.pendingForkContext }
      : {}),
    ...(agent.pendingFork !== undefined ? { pendingFork: agent.pendingFork } : {}),
  });
}

// ---------------------------------------------------------------------------
// 会话分叉（design.md 4.23）
// ---------------------------------------------------------------------------

interface ForkPlan {
  /** 保留的最后一条原时间线条目的 seq */
  endSeq: number;
  /** 保留整个会话（原生分叉无需截断） */
  whole: boolean;
  /** 截断点所在回合的原生锚点（turn_completed.nativeRef） */
  nativeRef?: string;
}

const TURN_END_TYPES = new Set(["turn_completed", "turn_failed", "turn_canceled"]);

/** 校验 throughSeq 并算出保留范围；非法抛 -32602，缺省 throughSeq 但原会话运行中抛 TURN_IN_PROGRESS */
function planFork(
  entries: AgentStreamEnvelope[],
  throughSeq: number | undefined,
  busy: boolean,
): ForkPlan {
  const lastSeq = entries.length > 0 ? entries[entries.length - 1]!.seq : 0;
  if (throughSeq === undefined) {
    if (busy) {
      throw new AgentRpcError("TURN_IN_PROGRESS", "该 agent 正在执行中，请等待当前回合结束后再分叉");
    }
    return { endSeq: lastSeq, whole: true };
  }
  if (!Number.isInteger(throughSeq) || throughSeq < 1 || throughSeq > lastSeq) {
    throw new AgentInvalidParamsError(`throughSeq 超出时间线范围：${throughSeq}`);
  }
  const end = entries.find((entry) => entry.seq >= throughSeq && TURN_END_TYPES.has(entry.event.type));
  if (!end) {
    throw new AgentInvalidParamsError("throughSeq 必须落在已结束的回合上");
  }
  const hasLaterTurn = entries.some(
    (entry) =>
      entry.seq > end.seq &&
      (entry.event.type === "turn_started" ||
        (entry.event.type === "timeline" && entry.event.item.type === "user_message")),
  );
  const nativeRef = end.event.type === "turn_completed" ? end.event.nativeRef : undefined;
  return {
    endSeq: end.seq,
    whole: !hasLaterTurn && !busy,
    ...(nativeRef ? { nativeRef } : {}),
  };
}

/**
 * 复制一条原时间线条目：换 agentId / seq / epoch。nativeRef 指向原会话的原生回合，对新会话无效，去掉
 * （之后在复制出来的历史上再截断分叉会退回 summary 方式）。
 */
function copyForkEntry(
  entry: AgentStreamEnvelope,
  agentId: string,
  seq: number,
  epoch: string,
): AgentStreamEnvelope {
  const copy = structuredClone(entry);
  if (copy.event.type === "turn_completed") {
    delete copy.event.nativeRef;
  }
  return { ...copy, agentId, seq, epoch };
}

function forkSourceTitle(snapshot: AgentSnapshot): string {
  if (snapshot.title) {
    return snapshot.title;
  }
  if (snapshot.preview) {
    return Array.from(snapshot.preview).slice(0, FORK_TITLE_SOURCE_MAX_CHARS).join("");
  }
  return "未命名会话";
}

function firstUserPreview(entries: AgentStreamEnvelope[]): string | undefined {
  const retracted = new Set<string>();
  for (const entry of entries) {
    if (entry.event.type === "user_message_retracted" && entry.event.clientMessageId) {
      retracted.add(entry.event.clientMessageId);
    }
  }
  for (const entry of entries) {
    const event = entry.event;
    if (event.type !== "timeline" || event.item.type !== "user_message") {
      continue;
    }
    if (event.item.clientMessageId && retracted.has(event.item.clientMessageId)) {
      continue;
    }
    const preview = toPreview(event.item.text);
    if (preview) {
      return preview;
    }
  }
  return undefined;
}

function toolCallSummary(item: Extract<AgentTimelineItem, { type: "tool_call" }>): string {
  const detail = item.detail;
  let target: string | undefined;
  switch (detail.type) {
    case "shell":
      target = detail.command;
      break;
    case "read":
    case "edit":
    case "write":
      target = detail.filePath;
      break;
    case "search":
      target = detail.query;
      break;
    case "fetch":
      target = detail.url;
      break;
    case "sub_agent":
      target = detail.description;
      break;
    default:
      break;
  }
  const oneLine = target?.replace(/\s*[\r\n]+\s*/g, " ").trim();
  const clipped = oneLine && oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
  return `[工具 ${item.name}${clipped ? `：${clipped}` : ""}]`;
}

/**
 * summary 方式的历史对话文本：用户 / 助手文本，工具调用一行摘要；超过 FORK_TRANSCRIPT_MAX_CHARS 时保留最后部分。
 * 已撤回的用户消息不计入；思考、待办、压缩、错误、系统提示等省略。
 */
export function buildForkTranscript(entries: AgentStreamEnvelope[]): string {
  type Part = { kind: "user" | "assistant" | "tool"; text: string; clientMessageId?: string };
  const parts: Part[] = [];
  const toolIndex = new Map<string, number>();
  for (const { event } of entries) {
    if (event.type === "user_message_retracted") {
      const index = event.clientMessageId
        ? parts.findIndex(
            (part) => part.kind === "user" && part.clientMessageId === event.clientMessageId,
          )
        : parts.map((part) => part.kind).lastIndexOf("user");
      if (index >= 0) {
        parts.splice(index, 1);
        toolIndex.clear();
      }
      continue;
    }
    if (event.type !== "timeline") {
      continue;
    }
    const item = event.item;
    if (item.type === "user_message") {
      parts.push({
        kind: "user",
        text: item.translatedText ?? item.text,
        ...(item.clientMessageId !== undefined ? { clientMessageId: item.clientMessageId } : {}),
      });
    } else if (item.type === "assistant_message") {
      const last = parts[parts.length - 1];
      if (last?.kind === "assistant") {
        last.text += item.text;
      } else {
        parts.push({ kind: "assistant", text: item.text });
      }
    } else if (item.type === "tool_call") {
      const text = toolCallSummary(item);
      const existing = toolIndex.get(item.callId);
      if (existing !== undefined && parts[existing]) {
        parts[existing]!.text = text;
      } else {
        toolIndex.set(item.callId, parts.length);
        parts.push({ kind: "tool", text });
      }
    }
  }
  const lines = parts
    .filter((part) => part.text.trim() !== "")
    .map((part) =>
      part.kind === "user"
        ? `用户：${part.text}`
        : part.kind === "assistant"
          ? `助手：${part.text}`
          : part.text,
    );
  const transcript = lines.join("\n\n");
  return transcript.length > FORK_TRANSCRIPT_MAX_CHARS
    ? transcript.slice(-FORK_TRANSCRIPT_MAX_CHARS)
    : transcript;
}

/** 在用户 prompt 前插入分叉历史上下文（design.md 4.23） */
function prependForkContext(prompt: AgentPromptInput, transcript: string): AgentPromptInput {
  const prefix = `以下是从另一个会话分叉过来的历史对话，仅供参考：\n<transcript>${transcript}</transcript>\n\n`;
  return typeof prompt === "string"
    ? prefix + prompt
    : [{ type: "text", text: prefix }, ...prompt];
}

/** 首条用户消息预览：去掉首尾空白、换行压成空格，取前 120 个字符（按码点） */
export function toPreview(text: string): string | undefined {
  const normalized = text.replace(/\s*[\r\n]+\s*/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return Array.from(normalized).slice(0, PREVIEW_MAX_CHARS).join("");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
