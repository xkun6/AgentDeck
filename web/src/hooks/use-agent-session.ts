// 前端与 Node sidecar 的动作层（design.md 第 6 节）。与 sidecar 通信只走这里与
// lib/sidecar-client.ts：
// - bindSidecarToStore：把连续去重后的事件流 / 快照 / 连接状态写进 jotai store；
// - useSidecarBridge：在应用根部挂一次，负责绑定与首次连接；
// - useAgentSession：会话动作（新建、发送、中断、审批、切模型/模式/思考强度、列表、历史、删除、
//   斜杠命令、MCP 状态与重连、重命名 / 置顶 / 归档、运行中插话）。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue, useStore } from "jotai";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { createStore } from "jotai";
import type {
  AgentPermissionResponse,
  AgentPromptInput,
  AgentSearchHit,
  AgentSnapshot,
  AgentStreamEnvelope,
  AgentBackgroundTask,
  AgentBackgroundTaskOutput,
  AgentMcpStatusResult,
  AgentStatusSection,
  AgentModelDefinition,
  AgentMode,
  AgentSlashCommand,
  ProviderInfo,
  ProviderProfile,
  ProviderSubagentDescriptor,
  ProviderSubagentTimelineRow,
  ProviderTestResult,
  RemoteStatus,
  SidecarSettings,
  SidecarSettingsPatch,
  SnapshotTurn,
  Board,
  BoardSettingsPatch,
  BoardTask,
  BoardTaskDraft,
  BoardTaskStatus,
  AgentGroup,
  GroupCreateParams,
  Schedule,
  ScheduleDraft,
  ScheduleRun,
  UsageSummary,
} from "@agentdeck/protocol";
import {
  getSidecarClient,
  SidecarRpcError,
  type SidecarClient,
} from "@/lib/sidecar-client";
import {
  AGENT_RESUMING_PROGRESS,
  applyAgentEventAtom,
  ensureChatSessionAtom,
  failAgentPromptAtom,
  markStreamsReconnectingAtom,
  reconcileAgentRuntimesAtom,
  removeAgentAtom,
  removeApprovalAtom,
  resetAgentRuntimesForEpochAtom,
  settleInactiveAgentRuntimeAtom,
  startAgentPromptAtom,
  type ImageEntry,
} from "@/stores/chat";
import {
  agentSnapshotsAtom,
  replaceAgentSnapshotsAtom,
  sidecarConnectionAtom,
  upsertAgentSnapshotAtom,
} from "@/stores/agents";
import {
  backgroundTasksByAgentAtom,
  removeAgentBackgroundTasksAtom,
  replaceBackgroundTasksAtom,
} from "@/stores/background-tasks";
import {
  applySubagentUpdateAtom,
  removeAgentSubagentsAtom,
  replaceSubagentsAtom,
  storeSubagentTimelineAtom,
  subagentTimelineKey,
  subagentTimelinesAtom,
  subagentsByAgentAtom,
  type SubagentTimelineCache,
} from "@/stores/subagents";
import { AGENT_QUERY_KEYS, invalidateProviderQueries } from "@/lib/agent-query-keys";
import { notifyFromSchedule } from "@/lib/notifications";
import { replaceBoardAtom } from "@/stores/boards";
import { replaceSchedulesAtom } from "@/stores/schedules";
import { removeGroupAtom, replaceGroupsAtom, upsertGroupAtom } from "@/stores/groups";

type JotaiStore = ReturnType<typeof createStore>;

export interface CreateAgentSessionInput {
  provider: string;
  cwd: string;
  model?: string;
  modeId?: string;
  /** 思考强度；省略 = 跟随 CLI 设置 */
  thinkingOptionId?: string;
  title?: string;
}

export interface SendAgentPromptOptions {
  /** 用于与 sidecar 回显的 user_message 去重；缺省自动生成。 */
  clientMessageId?: string;
  /** 乐观消息里展示的文本（缺省取 prompt 中的文本）。 */
  displayText?: string;
  /** 乐观消息里展示的图片。 */
  displayImages?: ImageEntry[];
  /** 会话所用中转当前处于停用状态（PROVIDER_NOT_FOUND 时提示启用而不是「已删除」）。 */
  providerDisabled?: boolean;
}

/** 把 sidecar 错误转成给用户看的中文。 */
export function humanizeSidecarError(error: unknown): string {
  if (error instanceof SidecarRpcError) {
    switch (error.businessCode) {
      case "TURN_IN_PROGRESS":
        return "Agent 正在执行上一轮，请等待结束或先中断";
      case "AGENT_CLOSED":
        return "该会话已关闭，请新建会话";
      case "AGENT_NOT_FOUND":
        return "会话不存在（Agent 服务可能已重启）";
      case "PROVIDER_NOT_FOUND":
        return "未找到该 Agent";
      case "PROVIDER_UNAVAILABLE":
        return `${error.message || "该 Agent 当前不可用"}（若 Agent 进程已退出，请新建会话）`;
      case "NOT_SUPPORTED":
        return error.message || "该 Agent 不支持此操作";
      case "PERMISSION_NOT_FOUND":
        return "该审批请求已失效";
      default:
        break;
    }
    if (error.code === -32602) return `参数错误：${error.message}`;
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export const SESSION_UNRECOVERABLE_MESSAGE = "该会话无法恢复，请新建会话";
export const SESSION_RESUME_BUSY_MESSAGE = "会话正在恢复或运行中";
export const SESSION_PROVIDER_DELETED_MESSAGE = "该会话使用的中转已被删除，请新建会话";
export const SESSION_PROVIDER_DISABLED_MESSAGE = "该会话使用的中转已停用，请在「Agent 与中转」中启用后重试，或新建会话";

/** 会话未加载（dormant）或已关闭（closed）：发送时 sidecar 会先尝试自动恢复。 */
export function isInactiveAgent(agent: Pick<AgentSnapshot, "status"> | null | undefined): boolean {
  return agent?.status === "dormant" || agent?.status === "closed";
}

export interface AgentSendErrorInfo {
  message: string;
  /** 会话已不可恢复：界面应禁用输入并提供「新建会话」入口 */
  unrecoverable: boolean;
  /** 会话的 provider 已不存在（PROVIDER_NOT_FOUND）：新建会话时不能沿用原 Agent */
  providerMissing?: boolean;
}

/**
 * agent.send 错误 → 中文提示。`resuming` 表示发送时会话为 dormant / closed（会触发自动恢复），
 * `lastError` 取自最新快照（恢复失败时 sidecar 写入的原因）。
 */
export function describeAgentSendError(
  error: unknown,
  context: { resuming: boolean; lastError?: string | null; providerDisabled?: boolean },
): AgentSendErrorInfo {
  if (error instanceof SidecarRpcError) {
    switch (error.businessCode) {
      case "PROVIDER_NOT_FOUND":
        // 中转被删除 / 停用后，dormant / closed 会话恢复时返回（design.md 4.7）
        return context.providerDisabled
          ? { message: SESSION_PROVIDER_DISABLED_MESSAGE, unrecoverable: false, providerMissing: true }
          : { message: SESSION_PROVIDER_DELETED_MESSAGE, unrecoverable: true, providerMissing: true };
      case "NOT_SUPPORTED":
      case "AGENT_CLOSED":
        return { message: SESSION_UNRECOVERABLE_MESSAGE, unrecoverable: true };
      case "TURN_IN_PROGRESS":
        if (context.resuming) return { message: SESSION_RESUME_BUSY_MESSAGE, unrecoverable: false };
        break;
      case "PROVIDER_UNAVAILABLE":
        if (context.resuming) {
          return {
            message: context.lastError?.trim() || error.message || "恢复会话失败",
            unrecoverable: false,
          };
        }
        break;
      default:
        break;
    }
  }
  return { message: humanizeSidecarError(error), unrecoverable: false };
}

/** sendPrompt 抛出的错误：`message` 已是中文提示，`original` 为原始错误。 */
export class AgentSendError extends Error {
  readonly unrecoverable: boolean;
  readonly providerMissing: boolean;
  readonly original: unknown;

  constructor(info: AgentSendErrorInfo, cause: unknown) {
    super(info.message);
    this.name = "AgentSendError";
    this.unrecoverable = info.unrecoverable;
    this.providerMissing = info.providerMissing === true;
    this.original = cause;
  }
}

export function newClientMessageId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `cm-${crypto.randomUUID()}`;
    }
  } catch {}
  return `cm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function promptDisplayText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") return prompt;
  return prompt
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** 把 sidecar 客户端的事件 / 快照 / 连接状态写入 store，返回解绑函数。 */
export function bindSidecarToStore(client: SidecarClient, store: JotaiStore): () => void {
  let wasOpen = false;
  const unsubscribers = [
    client.onState((state) => {
      store.set(sidecarConnectionAtom, state);
      if (state === "open") {
        wasOpen = true;
      } else if (wasOpen && (state === "closed" || state === "error")) {
        store.set(markStreamsReconnectingAtom);
      }
    }),
    client.onStream((envelope, meta) => store.set(applyAgentEventAtom, envelope, meta.replay)),
    client.onAgentState((agent) => store.set(upsertAgentSnapshotAtom, agent)),
    client.onAgentRemoved((agentId) => {
      store.set(removeAgentAtom, agentId);
      store.set(removeAgentSubagentsAtom, agentId);
      store.set(removeAgentBackgroundTasksAtom, agentId);
    }),
    client.onSubagentUpdate((update) => store.set(applySubagentUpdateAtom, update)),
    client.onTasksUpdate((update) => store.set(replaceBackgroundTasksAtom, update)),
    client.onAgents((agents) => {
      store.set(replaceAgentSnapshotsAtom, agents);
      store.set(reconcileAgentRuntimesAtom, agents);
    }),
    client.onEpochChange(() => store.set(resetAgentRuntimesForEpochAtom)),
  ];
  return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}

/** `provider.changed` → provider.list / 模型目录 / 中转配置的查询缓存失效并重新拉取。 */
export function bindProviderChangesToQueries(
  client: Pick<SidecarClient, "onProviderChanged">,
  queryClient: Pick<QueryClient, "invalidateQueries">,
): () => void {
  return client.onProviderChanged(() => {
    void invalidateProviderQueries(queryClient);
  });
}

/**
 * 调度器（design.md 4.25）：每次（重）连成功后拉一次 schedule.list，之后由 schedule.changed 整表替换；
 * schedule.notice（目标循环结束 / 定时任务失败）转成系统通知。
 */
export function bindSchedulesToStore(client: SidecarClient, store: JotaiStore): () => void {
  const unsubscribers = [
    client.onScheduleChanged((value) => store.set(replaceSchedulesAtom, value)),
    client.onScheduleNotice((notice) => notifyFromSchedule(notice)),
    client.onAgents(() => {
      client
        .request("schedule.list")
        .then((value) => store.set(replaceSchedulesAtom, value))
        .catch(() => {});
    }),
  ];
  return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}

/**
 * 看板（design.md 4.28）：board.changed 把整张看板写入 store（按规范化项目路径索引）。
 * 看板只在项目详情页打开时按需 board.get，不在连接时批量拉取。
 */
export function bindBoardsToStore(client: SidecarClient, store: JotaiStore): () => void {
  return client.onBoardChanged((value) => store.set(replaceBoardAtom, value.board));
}

/**
 * 并行协作组（design.md 4.27）：每次（重）连成功后拉一次 group.list，之后由 group.changed / group.removed 增量更新。
 */
export function bindGroupsToStore(client: SidecarClient, store: JotaiStore): () => void {
  const unsubscribers = [
    client.onGroupChanged((group) => store.set(upsertGroupAtom, group)),
    client.onGroupRemoved((groupId) => store.set(removeGroupAtom, groupId)),
    client.onAgents(() => {
      client
        .request("group.list")
        .then(({ groups }) => store.set(replaceGroupsAtom, groups))
        .catch(() => {});
    }),
  ];
  return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}

/** `remote.changed` → remote.status 查询缓存（design.md 4.31），「手机连接」设置页据此实时刷新。 */
export function bindRemoteToQueries(
  client: Pick<SidecarClient, "onRemoteChanged">,
  queryClient: Pick<QueryClient, "setQueryData">,
): () => void {
  return client.onRemoteChanged((status) => {
    queryClient.setQueryData<RemoteStatus>(AGENT_QUERY_KEYS.remoteStatus, status);
  });
}

/** client.presence 心跳间隔（design.md 4.31：可见期间每 30 秒一次） */
export const PRESENCE_HEARTBEAT_MS = 30_000;

type PresenceClient = Pick<SidecarClient, "onState" | "request">;
type PresenceDocument = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;

/**
 * 桌面端在线状态（design.md 4.31）：连接成功、窗口可见性变化时上报 `client.presence { kind: "desktop", visible }`，
 * 可见期间每 30 秒再报一次作为心跳。sidecar 据此判断「用户在电脑前」，决定要不要给手机发通知。
 */
export function bindDesktopPresence(
  client: PresenceClient,
  doc: PresenceDocument = document,
  heartbeatMs = PRESENCE_HEARTBEAT_MS,
): () => void {
  let open = false;
  const report = () => {
    if (!open) return;
    client
      .request("client.presence", { kind: "desktop", visible: doc.visibilityState === "visible" })
      .catch(() => {});
  };
  const unsubscribe = client.onState((state) => {
    const wasOpen = open;
    open = state === "open";
    if (open && !wasOpen) report();
  });
  doc.addEventListener("visibilitychange", report);
  const timer = setInterval(() => {
    if (doc.visibilityState === "visible") report();
  }, heartbeatMs);
  return () => {
    unsubscribe();
    doc.removeEventListener("visibilitychange", report);
    clearInterval(timer);
  };
}

/** 在应用根部调用一次：绑定 store / 查询缓存并发起首次连接。 */
export function useSidecarBridge(): void {
  const store = useStore();
  const queryClient = useQueryClient();
  useEffect(() => {
    const client = getSidecarClient();
    const unbind = bindSidecarToStore(client, store);
    const unbindSchedules = bindSchedulesToStore(client, store);
    const unbindBoards = bindBoardsToStore(client, store);
    const unbindGroups = bindGroupsToStore(client, store);
    const unbindProviders = bindProviderChangesToQueries(client, queryClient);
    const unbindRemote = bindRemoteToQueries(client, queryClient);
    const unbindPresence = bindDesktopPresence(client);
    client.connect().catch(() => {});
    return () => {
      unbind();
      unbindSchedules();
      unbindBoards();
      unbindGroups();
      unbindProviders();
      unbindRemote();
      unbindPresence();
    };
  }, [queryClient, store]);
}

const SUBAGENT_TIMELINE_PAGE = 200;
const EMPTY_SUBAGENTS: Record<string, ProviderSubagentDescriptor> = {};
const EMPTY_ROWS: ProviderSubagentTimelineRow[] = [];
const EMPTY_TASKS: AgentBackgroundTask[] = [];

export function createAgentSessionActions(client: SidecarClient, store: JotaiStore) {
  return {
    async listProviders(): Promise<ProviderInfo[]> {
      return client.request("provider.list");
    },

    async listModels(
      provider: string,
      cwd?: string,
    ): Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }> {
      return client.request("provider.listModels", cwd ? { provider, cwd } : { provider });
    },

    /** provider.config.get：含明文 apiKey，界面负责遮挡显示，不得打日志。 */
    async getProviderConfig(): Promise<{ providers: ProviderProfile[]; path: string | null }> {
      return client.request("provider.config.get");
    },

    /** provider.config.set：整表替换，返回最新 provider.list（含内置项）。 */
    async setProviderConfig(providers: ProviderProfile[]): Promise<ProviderInfo[]> {
      const result = await client.request("provider.config.set", { providers });
      return result.providers;
    },

    /** provider.test：测未保存的表单（只请求 /v1/models，不发起对话）。 */
    async testProvider(profile: ProviderProfile): Promise<ProviderTestResult> {
      return client.request("provider.test", { profile }, { timeoutMs: 20_000 });
    },

    async createSession(input: CreateAgentSessionInput): Promise<AgentSnapshot> {
      const { agent } = await client.request("agent.create", {
        provider: input.provider,
        cwd: input.cwd,
        ...(input.model ? { model: input.model } : {}),
        ...(input.modeId ? { modeId: input.modeId } : {}),
        ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
        ...(input.title ? { title: input.title } : {}),
      });
      store.set(upsertAgentSnapshotAtom, agent);
      store.set(ensureChatSessionAtom, agent.id);
      return agent;
    },

    async sendPrompt(
      agentId: string,
      prompt: AgentPromptInput,
      options: SendAgentPromptOptions = {},
    ): Promise<{ turnId: string; clientMessageId: string }> {
      const clientMessageId = options.clientMessageId ?? newClientMessageId();
      // dormant / closed 会话：sidecar 先自动恢复（starting → idle → running）再开始本轮
      const resuming = isInactiveAgent(store.get(agentSnapshotsAtom)[agentId]);
      store.set(startAgentPromptAtom, {
        agentId,
        clientMessageId,
        text: options.displayText ?? promptDisplayText(prompt),
        images: options.displayImages,
        ...(resuming ? { progressText: AGENT_RESUMING_PROGRESS } : {}),
      });
      try {
        const { turnId } = await client.request("agent.send", { agentId, prompt, clientMessageId });
        return { turnId, clientMessageId };
      } catch (error) {
        const info = describeAgentSendError(error, {
          resuming,
          lastError: store.get(agentSnapshotsAtom)[agentId]?.lastError,
          providerDisabled: options.providerDisabled,
        });
        store.set(failAgentPromptAtom, { agentId, clientMessageId, message: info.message });
        throw new AgentSendError(info, error);
      }
    },

    async interrupt(agentId: string): Promise<void> {
      await client.request("agent.cancel", { agentId }, { timeoutMs: 15_000 });
    },

    /**
     * 运行中插话（design.md 4.22）：把消息投递给进行中的回合。用户消息由 sidecar 写入时间线（带 steer 标记），
     * 随 agent.stream 回到前端，这里不做乐观插入；失败时抛出带中文提示的 Error。
     */
    async steerPrompt(
      agentId: string,
      prompt: AgentPromptInput,
      options: { clientMessageId?: string } = {},
    ): Promise<{ clientMessageId: string }> {
      const clientMessageId = options.clientMessageId ?? newClientMessageId();
      try {
        await client.request("agent.steer", { agentId, prompt, clientMessageId });
      } catch (error) {
        throw new Error(humanizeSidecarError(error));
      }
      return { clientMessageId };
    },

    /** 首次响应前撤回本轮消息（design.md 4.16）；返回原始 prompt 供回填输入框。 */
    async retract(agentId: string): Promise<{ prompt: AgentPromptInput; clientMessageId?: string }> {
      return client.request("agent.retract", { agentId }, { timeoutMs: 15_000 });
    },

    async closeSession(agentId: string): Promise<void> {
      await client.request("agent.close", { agentId });
    },

    async respondPermission(
      agentId: string,
      requestId: string,
      response: AgentPermissionResponse,
    ): Promise<void> {
      await client.request("agent.permission.respond", { agentId, requestId, response });
      store.set(removeApprovalAtom, { sessionId: agentId, requestId });
    },

    async setModel(agentId: string, modelId: string | null): Promise<AgentSnapshot> {
      const { agent } = await client.request("agent.setModel", { agentId, modelId });
      store.set(upsertAgentSnapshotAtom, agent);
      return agent;
    },

    async setMode(agentId: string, modeId: string): Promise<AgentSnapshot> {
      const { agent } = await client.request("agent.setMode", { agentId, modeId });
      store.set(upsertAgentSnapshotAtom, agent);
      return agent;
    },

    /** agent.setThinking：下一轮生效；运行中切换时 notice 为中文提示（design.md 4.10）。 */
    async setThinking(
      agentId: string,
      thinkingOptionId: string | null,
    ): Promise<{ agent: AgentSnapshot; notice?: string }> {
      const result = await client.request("agent.setThinking", { agentId, thinkingOptionId });
      store.set(upsertAgentSnapshotAtom, result.agent);
      return result;
    },

    /** agent.list：刷新快照并返回。 */
    async listSessions(): Promise<AgentSnapshot[]> {
      return client.refreshAgents();
    },

    /**
     * 用 agent.timeline 补齐该 agent 的全部历史（已归约的部分按 seq 去重，历史条目跨 epoch 保留）。
     * dormant / closed 会话回放后收尾历史里未结束的回合。
     */
    async loadTimeline(agentId: string): Promise<void> {
      store.set(ensureChatSessionAtom, agentId);
      await client.syncAgent(agentId);
      store.set(settleInactiveAgentRuntimeAtom, agentId);
    },

    /** agent.subagents.list：该会话全部层级的 provider 子代理，写入 store 并返回（design.md 4.11）。 */
    async listSubagents(agentId: string): Promise<ProviderSubagentDescriptor[]> {
      const { subagents } = await client.request("agent.subagents.list", { agentId });
      store.set(replaceSubagentsAtom, { agentId, subagents });
      return subagents;
    },

    /** agent.subagents.timeline：tail（缺省）或 before cursorSeq 的一页，结果合并进时间线缓存。 */
    async subagentTimeline(
      agentId: string,
      subagentId: string,
      options: { before?: number; limit?: number } = {},
    ): Promise<{ rows: ProviderSubagentTimelineRow[]; hasOlder: boolean }> {
      const before = options.before;
      const result = await client.request("agent.subagents.timeline", {
        agentId,
        subagentId,
        limit: options.limit ?? SUBAGENT_TIMELINE_PAGE,
        ...(before !== undefined ? { direction: "before" as const, cursorSeq: before } : {}),
      });
      store.set(storeSubagentTimelineAtom, {
        agentId,
        subagentId,
        rows: result.rows,
        hasOlder: result.hasOlder,
        mode: before !== undefined ? "before" : "tail",
      });
      return result;
    },

    /** agent.commands：会话可用的斜杠命令（name 不带前导 /；休眠会话走目录兜底，design.md 4.14）。 */
    async listCommands(agentId: string): Promise<AgentSlashCommand[]> {
      const { commands } = await client.request("agent.commands", { agentId });
      return commands;
    },

    /** agent.mcp.status：MCP 服务器状态（休眠会话会先自动恢复；不支持时 NOT_SUPPORTED）。 */
    async mcpStatus(agentId: string): Promise<AgentMcpStatusResult> {
      return client.request("agent.mcp.status", { agentId });
    },

    /** agent.status：AgentDeck 本地 /status 的分组内容（休眠会话会先自动恢复；不支持时 NOT_SUPPORTED）。 */
    async status(agentId: string): Promise<AgentStatusSection[]> {
      const { sections } = await client.request("agent.status", { agentId });
      return sections;
    },

    /** agent.mcp.reconnect：重连后返回最新状态；Codex 忽略 serverName 整体重新加载。可能耗时数十秒。 */
    async mcpReconnect(agentId: string, serverName?: string): Promise<AgentMcpStatusResult> {
      return client.request("agent.mcp.reconnect", serverName ? { agentId, serverName } : { agentId });
    },

    /** agent.tasks.list：该会话的后台任务（design.md 4.15），写入 store 并返回；非 Claude 会话恒为空。 */
    async listBackgroundTasks(agentId: string): Promise<AgentBackgroundTask[]> {
      const { tasks } = await client.request("agent.tasks.list", { agentId });
      store.set(replaceBackgroundTasksAtom, { agentId, tasks });
      return tasks;
    },

    /** agent.tasks.stop：请求停止单个后台任务；终态由 agent.tasks.update 带回。 */
    async stopBackgroundTask(agentId: string, taskId: string): Promise<void> {
      await client.request("agent.tasks.stop", { agentId, taskId });
    },

    /** agent.tasks.output：后台命令输出文件的尾部。 */
    async backgroundTaskOutput(
      agentId: string,
      taskId: string,
      maxBytes?: number,
    ): Promise<AgentBackgroundTaskOutput> {
      return client.request(
        "agent.tasks.output",
        maxBytes === undefined ? { agentId, taskId } : { agentId, taskId, maxBytes },
      );
    },

    /**
     * agent.update：重命名 / 置顶 / 归档（design.md 4.17）。只改元数据、不改 updatedAt、不恢复会话；
     * title 为 null 或空串 = 恢复自动标题。结果写入快照，agent.state 推送同样会刷新列表。
     */
    async updateSession(
      agentId: string,
      patch: { title?: string | null; pinned?: boolean; archived?: boolean; interopTarget?: boolean },
    ): Promise<AgentSnapshot> {
      const { agent } = await client.request("agent.update", { agentId, ...patch });
      store.set(upsertAgentSnapshotAtom, agent);
      return agent;
    },

    /** agent.search：会话全文搜索（design.md 4.19）；每个会话最多 5 条命中，达到 limit 时 truncated。 */
    async searchSessions(
      query: string,
      options?: { limit?: number },
    ): Promise<{ hits: AgentSearchHit[]; truncated: boolean }> {
      return client.request(
        "agent.search",
        options?.limit === undefined ? { query } : { query, limit: options.limit },
        { timeoutMs: 60_000 },
      );
    },

    /** usage.summary：跨会话用量统计（design.md 4.20）；sinceMs 缺省为最近 30 天，0 表示全部。 */
    async usageSummary(range?: { sinceMs?: number; untilMs?: number }): Promise<UsageSummary> {
      return client.request("usage.summary", range ?? {}, { timeoutMs: 60_000 });
    },

    /** settings.get / settings.set：sidecar 设置（design.md 4.24）。 */
    async getSidecarSettings(): Promise<SidecarSettings> {
      return client.request("settings.get", {});
    },
    async setSidecarSettings(patch: SidecarSettingsPatch): Promise<SidecarSettings> {
      return client.request("settings.set", { patch });
    },

    /** remote.status / remote.pairing.create / remote.devices.revoke：远程网关（design.md 4.31）。 */
    async getRemoteStatus(): Promise<RemoteStatus> {
      return client.request("remote.status", {});
    },
    async createRemotePairing(): Promise<{ offerUrl: string; expiresAt: number }> {
      return client.request("remote.pairing.create", {});
    },
    async revokeRemoteDevice(deviceId: string): Promise<void> {
      await client.request("remote.devices.revoke", { deviceId });
    },

    /** snapshot.list：按回合的文件快照索引（design.md 4.24）。 */
    async listSnapshots(agentId: string): Promise<SnapshotTurn[]> {
      const { turns } = await client.request("snapshot.list", { agentId }, { timeoutMs: 60_000 });
      return turns;
    },
    /** snapshot.diff：回合前与回合后（缺省）或当前工作区的 unified diff，上限 512 KB。 */
    async snapshotDiff(
      agentId: string,
      turnId: string,
      options: { path?: string; against?: "after" | "current" } = {},
    ): Promise<{ diff: string; truncated: boolean }> {
      return client.request("snapshot.diff", { agentId, turnId, ...options }, { timeoutMs: 60_000 });
    },
    /** snapshot.restore：把文件恢复到该回合开始前；同工作目录有进行中的回合时 TURN_IN_PROGRESS。 */
    async restoreSnapshot(
      agentId: string,
      turnId: string,
      paths?: string[],
    ): Promise<{ restored: string[]; deleted: string[]; backupCommit: string }> {
      return client.request(
        "snapshot.restore",
        { agentId, turnId, ...(paths ? { paths } : {}) },
        { timeoutMs: 120_000 },
      );
    },
    async snapshotStorage(): Promise<Array<{ cwd: string; bytes: number }>> {
      const { repos } = await client.request("snapshot.storage", {}, { timeoutMs: 60_000 });
      return repos;
    },
    async pruneSnapshots(cwd: string): Promise<void> {
      await client.request("snapshot.prune", { cwd }, { timeoutMs: 120_000 });
    },

    /**
     * agent.fork：基于原会话新建分叉会话（design.md 4.23）。throughSeq 缺省 = 整个会话；
     * 给出时只保留到所在回合结束。结果写入快照并预建聊天运行时，返回新会话。
     */
    async forkSession(
      agentId: string,
      options: { throughSeq?: number; title?: string } = {},
    ): Promise<AgentSnapshot> {
      const { agent } = await client.request(
        "agent.fork",
        {
          agentId,
          ...(options.throughSeq !== undefined ? { throughSeq: options.throughSeq } : {}),
          ...(options.title ? { title: options.title } : {}),
        },
        { timeoutMs: 60_000 },
      );
      store.set(upsertAgentSnapshotAtom, agent);
      store.set(ensureChatSessionAtom, agent.id);
      return agent;
    },

    /** schedule.list：调度表与全局暂停状态，写入 store 并返回（design.md 4.25）。 */
    async listSchedules(): Promise<{ schedules: Schedule[]; paused: boolean }> {
      const value = await client.request("schedule.list");
      store.set(replaceSchedulesAtom, value);
      return value;
    },

    /** schedule.upsert：无 id 为新建；cron 非法 / 参数非法为 -32602，目标会话不存在为 AGENT_NOT_FOUND。 */
    async upsertSchedule(schedule: ScheduleDraft): Promise<Schedule> {
      const result = await client.request("schedule.upsert", { schedule });
      return result.schedule;
    },

    async deleteSchedule(id: string): Promise<void> {
      await client.request("schedule.delete", { id });
    },

    /** schedule.runNow：cron / heartbeat 立即发送一次；goal 继续循环。结果见运行记录。 */
    async runScheduleNow(id: string): Promise<void> {
      await client.request("schedule.runNow", { id });
    },

    /** schedule.runs：运行记录，按时间倒序（缺省 100 条）。 */
    async listScheduleRuns(id?: string, limit?: number): Promise<ScheduleRun[]> {
      const { runs } = await client.request("schedule.runs", {
        ...(id ? { id } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return runs;
    },

    async setSchedulesPaused(paused: boolean): Promise<boolean> {
      const result = await client.request("schedule.setPaused", { paused });
      return result.paused;
    },

    /** board.get：项目看板（不存在返回默认空看板），写入 store 并返回（design.md 4.28）。 */
    async getBoard(projectPath: string): Promise<Board> {
      const { board } = await client.request("board.get", { projectPath });
      store.set(replaceBoardAtom, board);
      return board;
    },

    async updateBoardSettings(projectPath: string, settings: BoardSettingsPatch): Promise<Board> {
      const { board } = await client.request("board.updateSettings", { projectPath, settings });
      store.set(replaceBoardAtom, board);
      return board;
    },

    /** board.upsertTask：无 id 新建；依赖不存在 / 成环为 -32602。 */
    async upsertBoardTask(projectPath: string, task: BoardTaskDraft): Promise<BoardTask> {
      const result = await client.request("board.upsertTask", { projectPath, task });
      store.set(replaceBoardAtom, result.board);
      return result.task;
    },

    async deleteBoardTask(
      projectPath: string,
      taskId: string,
      removeWorktree?: boolean,
    ): Promise<{ warning?: string }> {
      const result = await client.request("board.deleteTask", {
        projectPath,
        taskId,
        ...(removeWorktree !== undefined ? { removeWorktree } : {}),
      });
      store.set(replaceBoardAtom, result.board);
      return result.warning ? { warning: result.warning } : {};
    },

    /** board.moveTask：拖拽移动 / 列内排序（order 为排序键）；拖到 running 会派发。 */
    async moveBoardTask(
      projectPath: string,
      taskId: string,
      status: BoardTaskStatus,
      order?: number,
    ): Promise<Board> {
      const { board } = await client.request("board.moveTask", {
        projectPath,
        taskId,
        status,
        ...(order !== undefined ? { order } : {}),
      });
      store.set(replaceBoardAtom, board);
      return board;
    },

    /** board.merge：冲突时 ok=false 并带冲突文件；其它失败（如工作区有未提交改动）为业务错误。 */
    async mergeBoardTask(
      projectPath: string,
      taskId: string,
      removeWorktree: boolean,
    ): Promise<{ ok: boolean; conflicts?: string[]; warning?: string }> {
      const result = await client.request("board.merge", { projectPath, taskId, removeWorktree });
      store.set(replaceBoardAtom, result.board);
      return {
        ok: result.ok,
        ...(result.conflicts ? { conflicts: result.conflicts } : {}),
        ...(result.warning ? { warning: result.warning } : {}),
      };
    },

    /** group.create：并行协作（design.md 4.27）。成员数 / 非 git 仓库的 per-member 为 -32602；结果同时写入 store。 */
    async createGroup(params: GroupCreateParams): Promise<AgentGroup> {
      const { group } = await client.request("group.create", params, { timeoutMs: 120_000 });
      store.set(upsertGroupAtom, group);
      return group;
    },

    /** group.delete：成员会话保留；removeWorktrees 时同时删除 worktree 与分支，失败项放在 warnings。 */
    async deleteGroup(id: string, removeWorktrees: boolean): Promise<string[]> {
      const result = await client.request("group.delete", { id, removeWorktrees }, { timeoutMs: 60_000 });
      store.set(removeGroupAtom, id);
      return result.warnings ?? [];
    },

    /** agent.timeline：取会话全部时间线条目（dormant / closed 也可取，不恢复会话），供导出使用。 */
    async fetchAllTimelineEntries(agentId: string): Promise<AgentStreamEnvelope[]> {
      const { entries } = await client.request("agent.timeline", { agentId }, { timeoutMs: 60_000 });
      return entries;
    },

    /** agent.delete：sidecar 关闭并删除会话（含磁盘目录），随后本地移除（agent.removed 也会触发同样处理）。 */
    async deleteSession(agentId: string): Promise<void> {
      await client.request("agent.delete", { agentId });
      store.set(removeAgentAtom, agentId);
      store.set(removeAgentSubagentsAtom, agentId);
      store.set(removeAgentBackgroundTasksAtom, agentId);
    },
  };
}

export type AgentSessionActions = ReturnType<typeof createAgentSessionActions>;

export function useAgentSession(): AgentSessionActions {
  const store = useStore();
  return useMemo(() => createAgentSessionActions(getSidecarClient(), store), [store]);
}

/**
 * 某会话的 provider 子代理（design.md 4.11）：进入会话与每次重连成功后拉一次 agent.subagents.list，
 * 之后由 agent.subagents.update 增量维护。返回按 createdAt 升序的全部层级描述。
 */
export function useProviderSubagents(agentId: string | null | undefined): ProviderSubagentDescriptor[] {
  const actions = useAgentSession();
  const connection = useAtomValue(sidecarConnectionAtom);
  const byAgent = useAtomValue(subagentsByAgentAtom);
  useEffect(() => {
    if (!agentId || connection !== "open") return;
    actions.listSubagents(agentId).catch(() => {});
  }, [actions, agentId, connection]);
  const map = agentId ? byAgent[agentId] ?? EMPTY_SUBAGENTS : EMPTY_SUBAGENTS;
  return useMemo(
    () => Object.values(map).sort((a, b) => a.createdAt - b.createdAt),
    [map],
  );
}

/**
 * 某会话的后台任务（design.md 4.15）：进入会话与每次重连成功后拉一次 agent.tasks.list，
 * 之后由 agent.tasks.update 整表替换。
 */
export function useBackgroundTasks(agentId: string | null | undefined): AgentBackgroundTask[] {
  const actions = useAgentSession();
  const connection = useAtomValue(sidecarConnectionAtom);
  const byAgent = useAtomValue(backgroundTasksByAgentAtom);
  useEffect(() => {
    if (!agentId || connection !== "open") return;
    actions.listBackgroundTasks(agentId).catch(() => {});
  }, [actions, agentId, connection]);
  return agentId ? byAgent[agentId] ?? EMPTY_TASKS : EMPTY_TASKS;
}

export interface SubagentTimelineState extends SubagentTimelineCache {
  loading: boolean;
  error: string | null;
  loadOlder: () => Promise<void>;
}

/** 子代理时间线：打开（及重连成功）时拉 tail，loadOlder 按最小 seq 向前翻页。 */
export function useSubagentTimeline(agentId: string, subagentId: string): SubagentTimelineState {
  const actions = useAgentSession();
  const connection = useAtomValue(sidecarConnectionAtom);
  const cache = useAtomValue(subagentTimelinesAtom)[subagentTimelineKey(agentId, subagentId)];
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (connection !== "open") return;
    let canceled = false;
    setLoading(true);
    setError(null);
    actions
      .subagentTimeline(agentId, subagentId)
      .catch((err: unknown) => {
        if (!canceled) setError(humanizeSidecarError(err));
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [actions, agentId, connection, subagentId]);

  const firstSeq = cache?.rows[0]?.seq;
  const loadOlder = useCallback(async () => {
    if (firstSeq === undefined) return;
    setLoading(true);
    try {
      await actions.subagentTimeline(agentId, subagentId, { before: firstSeq });
      setError(null);
    } catch (err) {
      setError(humanizeSidecarError(err));
    } finally {
      setLoading(false);
    }
  }, [actions, agentId, firstSeq, subagentId]);

  return {
    rows: cache?.rows ?? EMPTY_ROWS,
    hasOlder: cache?.hasOlder ?? false,
    loaded: cache?.loaded ?? false,
    loading,
    error,
    loadOlder,
  };
}
