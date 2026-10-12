import { randomBytes, randomUUID } from "node:crypto";

import type {
  AgentPermissionResponse,
  AgentPromptInput,
  AgentProviderId,
  AgentSnapshot,
  AgentStreamEnvelope,
  AgentStreamEvent,
} from "@agentdeck/protocol";

import { createSilentLogger, type Logger } from "../logger.js";
import { withTimeout } from "../utils/promise-timeout.js";
import { AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS, AgentStreamCoalescer } from "./coalescer.js";
import { AgentRpcError } from "./errors.js";
import type { AgentClient, AgentSession } from "./types.js";

const SESSION_CLOSE_TIMEOUT_MS = 5_000;

export interface AgentClientLookup {
  get(provider: AgentProviderId): AgentClient | undefined;
}

export interface AgentManagerListener {
  onStream?(envelope: AgentStreamEnvelope): void;
  onState?(agent: AgentSnapshot): void;
}

export interface AgentManagerOptions {
  registry: AgentClientLookup;
  logger?: Logger;
  /** 文本合并窗口，默认 60ms */
  coalesceWindowMs?: number;
  /** 进程级 epoch，默认随机生成 */
  epoch?: string;
  now?: () => number;
}

export interface CreateAgentParams {
  provider: AgentProviderId;
  cwd: string;
  model?: string;
  modeId?: string;
  title?: string;
}

interface ManagedAgent {
  id: string;
  client: AgentClient;
  session: AgentSession;
  snapshot: AgentSnapshot;
  seq: number;
  entries: AgentStreamEnvelope[];
  /** 事件尾链：保证同一 agent 的事件按到达顺序串行处理 */
  tail: Promise<void>;
  unsubscribe: () => void;
  /** agent.send 已受理、startTurn 尚未返回 */
  sending: boolean;
  finishedTurnIds: Set<string>;
  closed: boolean;
}

/**
 * 会话注册表：分配 agentId、维护 seq/epoch、串行处理事件、合并文本、权限中转、单 turn 约束。
 */
export class AgentManager {
  readonly epoch: string;

  private readonly agents = new Map<string, ManagedAgent>();
  private readonly listeners = new Set<AgentManagerListener>();
  private readonly registry: AgentClientLookup;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly coalescer: AgentStreamCoalescer;

  constructor(options: AgentManagerOptions) {
    this.registry = options.registry;
    this.logger = options.logger ?? createSilentLogger();
    this.now = options.now ?? Date.now;
    this.epoch = options.epoch ?? randomBytes(8).toString("hex");
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

    const session = await client.createSession({
      cwd: params.cwd,
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.modeId !== undefined ? { modeId: params.modeId } : {}),
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
      ...(catalog ? { availableModes: catalog.modes } : {}),
      status: "idle",
      activeTurnId: null,
      pendingPermissions: [],
      lastError: null,
      persistence: session.describePersistence(),
      createdAt: now,
      updatedAt: now,
    };
    const agent: ManagedAgent = {
      id,
      client,
      session,
      snapshot,
      seq: 0,
      entries: [],
      tail: Promise.resolve(),
      unsubscribe: () => undefined,
      sending: false,
      finishedTurnIds: new Set(),
      closed: false,
    };
    this.agents.set(id, agent);
    agent.unsubscribe = session.subscribe((event) => this.enqueueEvent(agent, event));
    this.logger.info("创建 agent %s（provider=%s, cwd=%s）", id, params.provider, params.cwd);
    this.emitState(agent);
    return cloneSnapshot(snapshot);
  }

  listAgents(): AgentSnapshot[] {
    return Array.from(this.agents.values(), (agent) => cloneSnapshot(agent.snapshot));
  }

  getAgent(agentId: string): AgentSnapshot {
    return cloneSnapshot(this.requireAgent(agentId).snapshot);
  }

  async sendPrompt(
    agentId: string,
    prompt: AgentPromptInput,
    clientMessageId?: string,
  ): Promise<{ turnId: string }> {
    const agent = this.requireOpenAgent(agentId);
    if (agent.sending || agent.snapshot.status === "running" || agent.snapshot.activeTurnId) {
      throw new AgentRpcError("TURN_IN_PROGRESS", "该 agent 正在执行中，请等待当前回合结束或先取消");
    }

    agent.sending = true;
    try {
      this.enqueueEvent(agent, {
        type: "timeline",
        item: {
          type: "user_message",
          text: promptToText(prompt),
          ...(clientMessageId !== undefined ? { clientMessageId } : {}),
        },
      });
      const { turnId } = await agent.session.startTurn(
        prompt,
        clientMessageId !== undefined ? { clientMessageId } : undefined,
      );
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
    await agent.session.interrupt();
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
    await agent.session.respondToPermission(requestId, response);
    // 兜底：session 未发 permission_resolved 时补发（已解决的会在处理时被去重丢弃）
    this.enqueueEvent(agent, { type: "permission_resolved", requestId, response });
    await agent.tail;
  }

  async setModel(agentId: string, modelId: string | null): Promise<AgentSnapshot> {
    const agent = this.requireOpenAgent(agentId);
    if (!agent.session.setModel) {
      throw new AgentRpcError("NOT_SUPPORTED", `provider ${agent.snapshot.provider} 不支持切换模型`);
    }
    await agent.session.setModel(modelId);
    this.enqueueEvent(agent, { type: "model_changed", modelId });
    await agent.tail;
    return cloneSnapshot(agent.snapshot);
  }

  async setMode(agentId: string, modeId: string): Promise<AgentSnapshot> {
    const agent = this.requireOpenAgent(agentId);
    if (!agent.session.setMode) {
      throw new AgentRpcError("NOT_SUPPORTED", `provider ${agent.snapshot.provider} 不支持切换模式`);
    }
    await agent.session.setMode(modeId);
    this.enqueueEvent(agent, { type: "mode_changed", modeId });
    await agent.tail;
    return cloneSnapshot(agent.snapshot);
  }

  async close(agentId: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    await this.closeAgent(agent);
  }

  timeline(agentId: string, sinceSeq?: number): { epoch: string; entries: AgentStreamEnvelope[] } {
    const agent = this.requireAgent(agentId);
    const since = sinceSeq ?? 0;
    return {
      epoch: this.epoch,
      entries: agent.entries.filter((entry) => entry.seq > since),
    };
  }

  /** 关闭全部会话（sidecar 退出前调用） */
  async shutdown(): Promise<void> {
    const open = Array.from(this.agents.values()).filter((agent) => !agent.closed);
    await Promise.allSettled(open.map((agent) => this.closeAgent(agent)));
    this.coalescer.flushAll();
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private async closeAgent(agent: ManagedAgent): Promise<void> {
    if (agent.closed) {
      return;
    }
    agent.closed = true;
    try {
      await withTimeout(agent.session.close(), SESSION_CLOSE_TIMEOUT_MS, "关闭会话超时");
    } catch (error) {
      this.logger.warn("关闭 agent %s 出错：%s", agent.id, String(error));
    }
    await agent.tail;
    this.coalescer.flushAndDiscard(agent.id);
    agent.unsubscribe();
    agent.snapshot.status = "closed";
    agent.snapshot.activeTurnId = null;
    agent.snapshot.pendingPermissions = [];
    this.touch(agent);
    this.logger.info("关闭 agent %s", agent.id);
    this.emitState(agent);
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
      throw new AgentRpcError("AGENT_CLOSED", `agent 已关闭：${agentId}`);
    }
    return agent;
  }

  private runInChain(agent: ManagedAgent, task: () => void | Promise<void>): void {
    agent.tail = agent.tail.then(task).catch((error: unknown) => {
      this.logger.error("处理 agent %s 事件出错：%s", agent.id, String(error));
    });
  }

  private enqueueEvent(agent: ManagedAgent, event: AgentStreamEvent): void {
    this.runInChain(agent, () => this.processEvent(agent, event));
  }

  private processEvent(agent: ManagedAgent, rawEvent: AgentStreamEvent): void {
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
      default:
        return false;
    }
  }

  private applyAndEmit(agent: ManagedAgent, event: AgentStreamEvent): void {
    const stateChanged = this.applyToSnapshot(agent, event);
    this.touch(agent);
    this.emitEnvelope(agent, event);
    if (stateChanged) {
      this.emitState(agent);
    }
  }

  /** 按事件更新快照，返回是否需要推送 agent.state */
  private applyToSnapshot(agent: ManagedAgent, event: AgentStreamEvent): boolean {
    const snapshot = agent.snapshot;
    switch (event.type) {
      case "thread_started":
        snapshot.persistence = agent.session.describePersistence() ?? {
          provider: snapshot.provider,
          sessionId: event.sessionId,
        };
        return true;
      case "turn_started":
        if (agent.closed || agent.finishedTurnIds.has(event.turnId)) {
          return false;
        }
        snapshot.status = "running";
        snapshot.activeTurnId = event.turnId;
        snapshot.lastError = null;
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
      case "timeline":
        return false;
    }
  }

  private finishTurn(agent: ManagedAgent, turnId: string): boolean {
    agent.finishedTurnIds.add(turnId);
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

  private touch(agent: ManagedAgent): void {
    agent.snapshot.updatedAt = this.now();
  }

  private emitEnvelope(agent: ManagedAgent, event: AgentStreamEvent): void {
    agent.seq += 1;
    const envelope: AgentStreamEnvelope = {
      agentId: agent.id,
      seq: agent.seq,
      epoch: this.epoch,
      timestamp: this.now(),
      event,
    };
    agent.entries.push(envelope);
    for (const listener of this.listeners) {
      try {
        listener.onStream?.(envelope);
      } catch (error) {
        this.logger.error("agent.stream 监听器出错：%s", String(error));
      }
    }
  }

  private emitState(agent: ManagedAgent): void {
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
