// 前端与 Node sidecar 的动作层（design.md 第 6 节）。与 sidecar 通信只走这里与
// lib/sidecar-client.ts：
// - bindSidecarToStore：把连续去重后的事件流 / 快照 / 连接状态写进 jotai store；
// - useSidecarBridge：在应用根部挂一次，负责绑定与首次连接；
// - useAgentSession：会话动作（新建、发送、中断、审批、切模型/模式、列表、历史）。
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
  applyAgentEventAtom,
  ensureChatSessionAtom,
  failAgentPromptAtom,
  markStreamsReconnectingAtom,
  reconcileAgentRuntimesAtom,
  removeApprovalAtom,
  resetAgentRuntimesForEpochAtom,
  startAgentPromptAtom,
  type ImageEntry,
} from "@/stores/chat";
import {
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
    client.onStream((envelope) => store.set(applyAgentEventAtom, envelope)),
    client.onAgentState((agent) => store.set(upsertAgentSnapshotAtom, agent)),
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
      store.set(startAgentPromptAtom, {
        agentId,
        clientMessageId,
        text: options.displayText ?? promptDisplayText(prompt),
        images: options.displayImages,
      });
      try {
        const { turnId } = await client.request("agent.send", { agentId, prompt, clientMessageId });
        return { turnId, clientMessageId };
      } catch (error) {
        store.set(failAgentPromptAtom, { agentId, clientMessageId, message: humanizeSidecarError(error) });
        throw error;
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

    /** 用 agent.timeline 补齐该 agent 的全部历史（已归约的部分按 seq 去重）。 */
    async loadTimeline(agentId: string): Promise<void> {
      store.set(ensureChatSessionAtom, agentId);
      await client.syncAgent(agentId);
    },
  };
}

export type AgentSessionActions = ReturnType<typeof createAgentSessionActions>;

export function useAgentSession(): AgentSessionActions {
  const store = useStore();
  return useMemo(() => createAgentSessionActions(getSidecarClient(), store), [store]);
}
