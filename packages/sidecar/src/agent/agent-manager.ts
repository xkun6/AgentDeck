import { randomBytes, randomUUID } from "node:crypto";

import type {
  AgentModelDefinition,
  AgentPermissionResponse,
  AgentPromptInput,
  AgentProviderId,
  AgentSnapshot,
  AgentStatus,
  AgentStreamEnvelope,
  AgentStreamEvent,
  ProviderSubagentDescriptor,
  ProviderSubagentUpdate,
} from "@agentdeck/protocol";

import { createSilentLogger, type Logger } from "../logger.js";
import { withTimeout } from "../utils/promise-timeout.js";
import type { AgentStore, PersistedAgentMeta } from "./agent-store.js";
import { AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS, AgentStreamCoalescer } from "./coalescer.js";
import { AgentRpcError } from "./errors.js";
import {
  ProviderSubagentStore,
  type SubagentTimelinePage,
  type SubagentTimelineQuery,
} from "./provider-subagent-store.js";
import type {
  AgentClient,
  AgentSession,
  AgentSessionEvent,
  ProviderSubagentInputEvent,
} from "./types.js";

const SESSION_CLOSE_TIMEOUT_MS = 5_000;
const PREVIEW_MAX_CHARS = 120;
export const RESUME_NOT_SUPPORTED_MESSAGE = "该会话无法恢复，请新建会话";

export interface AgentClientLookup {
  get(provider: AgentProviderId): AgentClient | undefined;
}

export interface AgentManagerListener {
  onStream?(envelope: AgentStreamEnvelope): void;
  onState?(agent: AgentSnapshot): void;
  onRemoved?(agentId: string): void;
  /** provider 子代理变化（design.md 4.11） */
  onSubagent?(update: ProviderSubagentUpdate): void;
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
}

export interface CreateAgentParams {
  provider: AgentProviderId;
  cwd: string;
  model?: string;
  modeId?: string;
  /** null / 省略 = 跟随 CLI 自身设置（design.md 4.10） */
  thinkingOptionId?: string | null;
  title?: string;
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
  /** 事件尾链：保证同一 agent 的事件按到达顺序串行处理 */
  tail: Promise<void>;
  unsubscribe: () => void;
  /** agent.send 已受理（含恢复会话）、startTurn 尚未返回 */
  sending: boolean;
  finishedTurnIds: Set<string>;
  /** 当前进行中的 CLI 自发轮次（turn_started.origin 为 background，design.md 4.12）；agent.send 可接管 */
  backgroundTurnId: string | null;
  /** 没有可用会话（关闭中 / 已关闭 / dormant） */
  closed: boolean;
  /** 进行中的恢复 */
  resuming: Promise<void> | null;
  /** 进行中的关闭 */
  closing: Promise<void> | null;
  /** 已从注册表删除 */
  removed: boolean;
  /** 建会话时取到的模型目录（切换模型后校验思考强度用）；null 表示尚未取到 */
  models: AgentModelDefinition[] | null;
}

/**
 * 会话注册表：分配 agentId、维护 seq/epoch、串行处理事件、合并文本、权限中转、单 turn 约束，
 * 以及会话持久化与恢复（design.md 4.5）。
 */
export class AgentManager {
  readonly epoch: string;

  private readonly agents = new Map<string, ManagedAgent>();
  private readonly listeners = new Set<AgentManagerListener>();
  private readonly registry: AgentClientLookup;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly coalescer: AgentStreamCoalescer;
  private readonly store: AgentStore | undefined;
  /** provider 子代理（只在内存，会话关闭 / 删除时清空） */
  private readonly subagents: ProviderSubagentStore;

  constructor(options: AgentManagerOptions) {
    this.registry = options.registry;
    this.store = options.store;
    this.logger = options.logger ?? createSilentLogger();
    this.now = options.now ?? Date.now;
    this.epoch = options.epoch ?? randomBytes(8).toString("hex");
    this.subagents = new ProviderSubagentStore(this.now);
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
    const session = await client.createSession({
      cwd: params.cwd,
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.modeId !== undefined ? { modeId: params.modeId } : {}),
      ...(thinkingOptionId !== null ? { thinkingOptionId } : {}),
    });

    // ACP 等 provider 的模式要建会话后才可得：建会话前为空时再取一次（失败只记日志）。
    // modeId 不随目录变化，保持 null 表示使用 provider 默认值。
    if (!catalog || catalog.modes.length === 0) {
      catalog = (await fetchCatalog()) ?? catalog;
    }

    const now = this.now();
    const id = randomUUID();
    const snapshot: AgentSnapshot = {
      id,
      provider: params.provider,
      cwd: params.cwd,
      ...(params.title !== undefined ? { title: params.title } : {}),
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
      ...newManagedAgent(id, client, snapshot),
      session,
      entries: [],
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
    for (const meta of metas) {
      if (this.agents.has(meta.id)) {
        continue;
      }
      const snapshot: AgentSnapshot = {
        ...meta,
        status: meta.status === "closed" ? "closed" : "dormant",
        activeTurnId: null,
        pendingPermissions: [],
      };
      const agent = newManagedAgent(meta.id, this.registry.get(meta.provider), snapshot);
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

  async sendPrompt(
    agentId: string,
    prompt: AgentPromptInput,
    clientMessageId?: string,
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
    if (agent.session === null) {
      this.refreshClient(agent);
      this.assertResumable(agent);
    } else if (agent.closed) {
      throw new AgentRpcError("AGENT_CLOSED", `agent 已关闭：${agentId}`);
    }

    agent.sending = true;
    try {
      if (agent.session === null) {
        agent.resuming = this.resumeAgent(agent);
        try {
          await agent.resuming;
        } finally {
          agent.resuming = null;
        }
      }
      const session = agent.session as AgentSession | null;
      if (agent.closed || !session) {
        throw new AgentRpcError("AGENT_CLOSED", `agent 已关闭：${agentId}`);
      }
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
          text: promptToText(prompt),
          ...(clientMessageId !== undefined ? { clientMessageId } : {}),
        },
      };
      this.runInChain(agent, async () => {
        if (await userMessageSent) {
          this.processEvent(agent, userMessage);
        }
      });
      let turnId: string;
      try {
        ({ turnId } = await session.startTurn(
          prompt,
          clientMessageId !== undefined ? { clientMessageId } : undefined,
        ));
      } catch (error) {
        settleUserMessage(false);
        throw error;
      }
      settleUserMessage(true);
      // 放进尾链：session 在 startTurn 返回前发出的事件都已排在前面，
      // 若 turn 已结束（finishedTurnIds）则不再标记 running。
      this.runInChain(agent, () => {
        if (agent.closed || agent.finishedTurnIds.has(turnId)) {
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

  async cancel(agentId: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    if (agent.closed) {
      return;
    }
    if (!agent.snapshot.activeTurnId && agent.snapshot.status !== "running" && !agent.sending) {
      return;
    }
    await agent.session?.interrupt();
    await agent.tail;
  }

  async respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void> {
    const agent = this.requireOpenAgent(agentId);
    const pending = agent.snapshot.pendingPermissions.some((request) => request.id === requestId);
    if (!pending) {
      throw new AgentRpcError("PERMISSION_NOT_FOUND", `找不到待处理的权限请求：${requestId}`);
    }
    await this.requireSession(agent).respondToPermission(requestId, response);
    // 兜底：session 未发 permission_resolved 时补发（已解决的会在处理时被去重丢弃）
    this.enqueueEvent(agent, { type: "permission_resolved", requestId, response });
    await agent.tail;
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

  /** 历史条目保留原 seq / epoch；返回的 epoch 为当前进程 epoch */
  async timeline(
    agentId: string,
    sinceSeq?: number,
  ): Promise<{ epoch: string; entries: AgentStreamEnvelope[] }> {
    const agent = this.requireAgent(agentId);
    const entries = await this.loadEntries(agent);
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
    await this.flush();
    const live = Array.from(this.agents.values()).filter(
      (agent) => agent.session !== null || agent.resuming !== null,
    );
    const finalStatus: AgentStatus = this.store ? "dormant" : "closed";
    await Promise.allSettled(live.map((agent) => this.closeAgent(agent, finalStatus)));
    this.coalescer.flushAll();
    await this.flush();
  }

  /** 强制落盘全部待写数据（未启用持久化时为空操作） */
  async flush(): Promise<void> {
    await this.store?.flushAll();
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
    if (agent.snapshot.resumable && agent.snapshot.persistence && agent.client?.resumeSession) {
      return;
    }
    if (agent.snapshot.status === "dormant") {
      throw new AgentRpcError("NOT_SUPPORTED", RESUME_NOT_SUPPORTED_MESSAGE);
    }
    throw new AgentRpcError("AGENT_CLOSED", `agent 已关闭：${agent.id}`);
  }

  /** dormant / closed → starting → idle；失败时回到原状态并写 lastError */
  private async resumeAgent(agent: ManagedAgent): Promise<void> {
    const client = agent.client!;
    const persistence = agent.snapshot.persistence!;
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
      session = await client.resumeSession!(structuredClone(persistence), {
        cwd: agent.snapshot.cwd,
      });
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
          agent.snapshot.lastSeq = Math.max(agent.snapshot.lastSeq, lastSeq);
          agent.entriesLoading = null;
          return entries;
        });
    }
    return agent.entriesLoading;
  }

  private refreshResumable(agent: ManagedAgent): void {
    agent.snapshot.resumable = Boolean(
      agent.snapshot.persistence?.sessionId && agent.client?.resumeSession,
    );
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
    if (rawEvent.type === "provider_subagent") {
      // 子代理事件写入子代理 store，不进主时间线、不占 seq
      this.applySubagentEvent(agent, rawEvent.event);
      return;
    }
    const event = this.attachTurnId(agent, rawEvent);
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
      case "turn_completed":
        if (event.usage) {
          snapshot.lastUsage = event.usage;
        }
        return this.finishTurn(agent, event.turnId);
      case "turn_failed":
        snapshot.lastError = event.error;
        this.finishTurn(agent, event.turnId);
        return true;
      case "turn_canceled":
        return this.finishTurn(agent, event.turnId);
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
        snapshot.lastUsage = event.usage;
        return false;
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
    if (!agent.closed) {
      snapshot.status = "idle";
    }
    return true;
  }

  /** 更新 updatedAt 并安排 meta 防抖落盘 */
  private touch(agent: ManagedAgent): void {
    agent.snapshot.updatedAt = this.now();
    if (!agent.removed) {
      this.store?.scheduleMeta(agent.id, () => toPersistedMeta(agent.snapshot));
    }
  }

  /** 立即落盘 meta（写失败只记日志，不抛错） */
  private persistNow(agent: ManagedAgent): Promise<void> {
    if (!this.store || agent.removed) {
      return Promise.resolve();
    }
    return this.store.flushMeta(agent.id, () => toPersistedMeta(agent.snapshot));
  }

  private emitEnvelope(agent: ManagedAgent, event: AgentStreamEvent): void {
    agent.snapshot.lastSeq += 1;
    const envelope: AgentStreamEnvelope = {
      agentId: agent.id,
      seq: agent.snapshot.lastSeq,
      epoch: this.epoch,
      timestamp: this.now(),
      event,
    };
    agent.entries?.push(envelope);
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

  private applySubagentEvent(agent: ManagedAgent, event: ProviderSubagentInputEvent): void {
    if (agent.removed) {
      return;
    }
    this.emitSubagentUpdate(this.subagents.apply(agent.id, agent.snapshot.provider, event));
  }

  /** 会话关闭 / 删除：清空该会话的子代理并逐个广播 remove */
  private clearSubagents(agent: ManagedAgent): void {
    for (const update of this.subagents.deleteParent(agent.id)) {
      this.emitSubagentUpdate(update);
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

function newManagedAgent(
  id: string,
  client: AgentClient | undefined,
  snapshot: AgentSnapshot,
): ManagedAgent {
  return {
    id,
    client,
    session: null,
    snapshot,
    entries: null,
    entriesLoading: null,
    tail: Promise.resolve(),
    unsubscribe: () => undefined,
    sending: false,
    finishedTurnIds: new Set(),
    backgroundTurnId: null,
    closed: true,
    resuming: null,
    closing: null,
    removed: false,
    models: null,
  };
}

/** meta.json：快照中除 pendingPermissions / activeTurnId 外的字段 */
function toPersistedMeta(snapshot: AgentSnapshot): PersistedAgentMeta {
  const { pendingPermissions: _pending, activeTurnId: _active, ...rest } = snapshot;
  return structuredClone(rest);
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
