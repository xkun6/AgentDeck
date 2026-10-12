// 前端与 Node sidecar 的动作层（design.md 第 6 节）。与 sidecar 通信只走这里与
// lib/sidecar-client.ts：
// - bindSidecarToStore：把连续去重后的事件流 / 快照 / 连接状态写进 jotai store；
// - useSidecarBridge：在应用根部挂一次，负责绑定与首次连接；
// - useAgentSession：会话动作（新建、发送、中断、审批、切模型/模式、列表、历史、删除）。
import { useEffect, useMemo } from "react";
import { useStore } from "jotai";
import type { createStore } from "jotai";
import type {
  AgentPermissionResponse,
  AgentPromptInput,
  AgentSnapshot,
  AgentModelDefinition,
  AgentMode,
  ProviderInfo,
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

type JotaiStore = ReturnType<typeof createStore>;

export interface CreateAgentSessionInput {
  provider: string;
  cwd: string;
  model?: string;
  modeId?: string;
  title?: string;
}

export interface SendAgentPromptOptions {
  /** 用于与 sidecar 回显的 user_message 去重；缺省自动生成。 */
  clientMessageId?: string;
  /** 乐观消息里展示的文本（缺省取 prompt 中的文本）。 */
  displayText?: string;
  /** 乐观消息里展示的图片。 */
  displayImages?: ImageEntry[];
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

/** 会话未加载（dormant）或已关闭（closed）：发送时 sidecar 会先尝试自动恢复。 */
export function isInactiveAgent(agent: Pick<AgentSnapshot, "status"> | null | undefined): boolean {
  return agent?.status === "dormant" || agent?.status === "closed";
}

export interface AgentSendErrorInfo {
  message: string;
  /** 会话已不可恢复：界面应禁用输入并提供「新建会话」入口 */
  unrecoverable: boolean;
}

/**
 * agent.send 错误 → 中文提示。`resuming` 表示发送时会话为 dormant / closed（会触发自动恢复），
 * `lastError` 取自最新快照（恢复失败时 sidecar 写入的原因）。
 */
export function describeAgentSendError(
  error: unknown,
  context: { resuming: boolean; lastError?: string | null },
): AgentSendErrorInfo {
  if (error instanceof SidecarRpcError) {
    switch (error.businessCode) {
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
  readonly original: unknown;

  constructor(info: AgentSendErrorInfo, cause: unknown) {
    super(info.message);
    this.name = "AgentSendError";
    this.unrecoverable = info.unrecoverable;
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
    client.onAgentRemoved((agentId) => store.set(removeAgentAtom, agentId)),
    client.onAgents((agents) => {
      store.set(replaceAgentSnapshotsAtom, agents);
      store.set(reconcileAgentRuntimesAtom, agents);
    }),
    client.onEpochChange(() => store.set(resetAgentRuntimesForEpochAtom)),
  ];
  return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}

/** 在应用根部调用一次：绑定 store 并发起首次连接。 */
export function useSidecarBridge(): void {
  const store = useStore();
  useEffect(() => {
    const client = getSidecarClient();
    const unbind = bindSidecarToStore(client, store);
    client.connect().catch(() => {});
    return unbind;
  }, [store]);
}

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

    async createSession(input: CreateAgentSessionInput): Promise<AgentSnapshot> {
      const { agent } = await client.request("agent.create", {
        provider: input.provider,
        cwd: input.cwd,
        ...(input.model ? { model: input.model } : {}),
        ...(input.modeId ? { modeId: input.modeId } : {}),
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
        });
        store.set(failAgentPromptAtom, { agentId, clientMessageId, message: info.message });
        throw new AgentSendError(info, error);
      }
    },

    async interrupt(agentId: string): Promise<void> {
      await client.request("agent.cancel", { agentId }, { timeoutMs: 15_000 });
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

    /** agent.delete：sidecar 关闭并删除会话（含磁盘目录），随后本地移除（agent.removed 也会触发同样处理）。 */
    async deleteSession(agentId: string): Promise<void> {
      await client.request("agent.delete", { agentId });
      store.set(removeAgentAtom, agentId);
    },
  };
}

export type AgentSessionActions = ReturnType<typeof createAgentSessionActions>;

export function useAgentSession(): AgentSessionActions {
  const store = useStore();
  return useMemo(() => createAgentSessionActions(getSidecarClient(), store), [store]);
}
