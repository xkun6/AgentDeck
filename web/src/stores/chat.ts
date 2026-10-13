import { atom } from "jotai";
import type {
  AgentPermissionRequest,
  AgentStreamEnvelope,
  AgentTimelineItem,
  AgentUsage,
  HermesMessageMetadata,
  HermesMessagePart,
  HermesUIMessage,
  ToolCallTimelineItem,
} from "@agentdeck/protocol";
import { describePermissionCommand, describeToolCall } from "@/lib/agent-tool-detail";
import { imagePartFromSource } from "@/lib/message-images";
import { notifyFromAgentEvent } from "@/lib/notifications";
import { agentSnapshotsAtom, lastRemovedAgentAtom } from "@/stores/agents";
import { activeSessionIdAtom } from "@/stores/ui";

export interface ToolEntry {
  tool_id: string;
  name: string;
  context?: string;
  preview?: string;
  summary?: string;
  error?: string;
  status: "running" | "done" | "error";
  startedAt: number;
  completedAt?: number;
}

export interface ImageEntry {
  url?: string;
  alt?: string;
  title?: string;
  name?: string;
  mimeType?: string;
}

export type AssistantTurnBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "progress"; text: string }
  | { type: "image"; image: ImageEntry }
  | { type: "tool"; tool: ToolEntry }
  | { type: "moa_reference"; label: string; text: string; index?: number; count?: number };

export interface PendingApproval {
  requestId: string;
  sessionId: string;
  command: string;
  reason?: string;
  /** AgentDeck：sidecar 推来的完整权限请求（actions / detail 等）。 */
  permission?: AgentPermissionRequest;
}

export type StreamStatus = "idle" | "connecting" | "streaming" | "complete" | "error";

export interface ChatSessionRuntime {
  messages: HermesUIMessage[];
  streamStatus: StreamStatus;
  pendingApprovals: PendingApproval[];
  statusMessage: string;
  statusKind?: string;
  statusUpdatedAt?: number;
  updatedAt: number;
  /**
   * Wall-clock ms of the last *backend* event reduced for this session. Unlike
   * {@link updatedAt} (also bumped by local atom mutations like manual
   * interrupt / reset), this only advances when the sidecar actually sends
   * something, so the stall watchdog can tell a live turn apart from a wedged
   * one where the backend has gone completely silent. See `session-activity.ts`.
   */
  lastActivityAt?: number;
  turnStartedAt?: number;
  turnFirstTokenAt?: number;
  activeAssistantId?: string;
  interrupted?: boolean;
  /** AgentDeck：已归约的最后一个 sidecar 事件序号（按 seq 去重）。 */
  agentLastSeq?: number;
  /** AgentDeck：上述序号所属的 sidecar epoch。 */
  agentEpoch?: string;
  /** AgentDeck：进行中的 turnId。 */
  activeTurnId?: string;
  /** AgentDeck：最近一次 usage_updated。 */
  agentUsage?: AgentUsage;
  /** AgentDeck：Agent 最近一次上报的待办列表。 */
  agentTodos?: { text: string; completed: boolean }[];
  /** AgentDeck：最近一段 assistant_message 的 messageId（不同 messageId 分段拼接）。 */
  agentTextMessageId?: string;
}

export type ChatRuntimeBySession = Record<string, ChatSessionRuntime>;

type HermesToolPart = Extract<HermesMessagePart, { type: "tool" }>;

export const chatRuntimeBySessionAtom = atom<ChatRuntimeBySession>({});

export function createEmptyChatRuntime(now = Date.now()): ChatSessionRuntime {
  return {
    messages: [],
    streamStatus: "idle",
    pendingApprovals: [],
    statusMessage: "",
    updatedAt: now,
  };
}

function resetStream(runtime: ChatSessionRuntime, now: number): ChatSessionRuntime {
  return {
    ...runtime,
    statusMessage: "",
    statusKind: undefined,
    statusUpdatedAt: undefined,
    activeAssistantId: undefined,
    turnStartedAt: undefined,
    turnFirstTokenAt: undefined,
    updatedAt: now,
  };
}

function isStreamingStatus(status: StreamStatus): boolean {
  return status === "streaming" || status === "connecting";
}

function withoutProgressParts(parts: HermesMessagePart[]): HermesMessagePart[] {
  return parts.filter((part) => part.type !== "progress");
}

function terminateRunningTools(parts: HermesMessagePart[]): HermesMessagePart[] {
  let changed = false;
  const next = parts.map((part) => {
    if (part.type === "tool" && part.state === "running") {
      changed = true;
      return { ...part, state: "error" as const };
    }
    return part;
  });
  return changed ? next : parts;
}

function appendTextPart(parts: HermesMessagePart[], text: string): HermesMessagePart[] {
  if (!text) return parts;
  const next = withoutProgressParts(parts);
  const last = next[next.length - 1];
  if (last?.type === "text") {
    next[next.length - 1] = { ...last, text: last.text + text };
  } else {
    next.push({ type: "text", text });
  }
  return next;
}

function appendReasoningPart(parts: HermesMessagePart[], text: string): HermesMessagePart[] {
  if (!text) return parts;
  const next = withoutProgressParts(parts);
  const last = next[next.length - 1];
  if (last?.type === "reasoning") {
    next[next.length - 1] = { ...last, text: last.text + text };
  } else {
    next.push({ type: "reasoning", text });
  }
  return next;
}

function appendToolPart(parts: HermesMessagePart[], tool: HermesToolPart): HermesMessagePart[] {
  const progressIndex = parts.findIndex((part) => part.type === "progress");
  if (progressIndex === -1) return [...parts, tool];
  return [
    ...parts.slice(0, progressIndex),
    tool,
    ...parts.slice(progressIndex),
  ];
}

function updateMessage(
  runtime: ChatSessionRuntime,
  id: string,
  updater: (message: HermesUIMessage) => HermesUIMessage | null,
): ChatSessionRuntime {
  let changed = false;
  const messages = runtime.messages.flatMap((message) => {
    if (message.id !== id) return [message];
    changed = true;
    const next = updater(message);
    return next ? [next] : [];
  });
  return changed ? { ...runtime, messages } : runtime;
}

function ensureAssistantMessage(
  runtime: ChatSessionRuntime,
  sessionId: string,
  id: string,
  now: number,
): ChatSessionRuntime {
  if (runtime.messages.some((message) => message.id === id)) {
    return updateMessage(runtime, id, (message) => ({
      ...message,
      status: message.status === "error" ? "error" : "streaming",
    }));
  }

  const createdAt = runtime.turnStartedAt ?? now;
  return {
    ...runtime,
    messages: [
      ...runtime.messages,
      {
        id,
        sessionId,
        role: "assistant",
        createdAt,
        status: "streaming",
        parts: [],
      },
    ],
  };
}

function updateSessionRuntime(
  state: ChatRuntimeBySession,
  sessionId: string,
  updater: (runtime: ChatSessionRuntime) => ChatSessionRuntime,
): ChatRuntimeBySession {
  const current = state[sessionId] ?? createEmptyChatRuntime();
  return {
    ...state,
    [sessionId]: updater(current),
  };
}

export const ensureChatSessionAtom = atom(null, (_get, set, sessionId: string) => {
  set(chatRuntimeBySessionAtom, (state) =>
    state[sessionId] ? state : { ...state, [sessionId]: createEmptyChatRuntime() },
  );
});

// 可恢复的连接中断（休眠唤醒、sidecar 重连）：保留进行中的消息与 activeAssistantId，
// 只显示临时「重连中」状态；重连后由 reconcileAgentRuntimesAtom 恢复或收尾。
export const markStreamsReconnectingAtom = atom(null, (_get, set) => {
  const now = Date.now();
  set(chatRuntimeBySessionAtom, (state) => {
    let changed = false;
    const next: ChatRuntimeBySession = {};
    for (const [sessionId, rt] of Object.entries(state)) {
      if (rt.streamStatus === "streaming") {
        changed = true;
        next[sessionId] = {
          ...rt,
          // keep messages + activeAssistantId untouched so the turn can resume
          streamStatus: "connecting",
          statusMessage: "连接中断，正在重连…",
          statusKind: "info",
          statusUpdatedAt: now,
          updatedAt: now,
        };
      } else {
        next[sessionId] = rt;
      }
    }
    return changed ? next : state;
  });
});

export const removeApprovalAtom = atom(
  null,
  (_get, set, params: { sessionId: string; requestId: string }) => {
    set(chatRuntimeBySessionAtom, (state) =>
      updateSessionRuntime(state, params.sessionId, (runtime) => ({
        ...runtime,
        pendingApprovals: runtime.pendingApprovals.filter(
          (item) => item.requestId !== params.requestId,
        ),
      })),
    );
  },
);

// ── AgentDeck：sidecar 事件 → ChatSessionRuntime ─────────────────────────────
//
// 会话 id 直接使用 sidecar 的 agentId。sidecar-client 已保证事件按 seq 连续投递，
// 这里再按 seq 去重一次，timeline 回放与实时事件重叠时不会重复归约。
// sidecar 持久化会话后 seq 跨进程连续递增，历史条目保留原 epoch（design.md 4.5），
// 所以去重只看 seq，不能因为 epoch 不同而丢弃或重复归约历史条目。

const AGENT_PENDING_PROGRESS = "正在等待 Agent 响应…";
export const AGENT_RESUMING_PROGRESS = "正在恢复会话…";
const AGENT_RECONNECT_STATUS = "连接中断，正在重连…";

function agentAssistantMessageId(turnId: string | undefined, seq: number): string {
  return turnId ? `agent-turn-${turnId}` : `agent-assistant-${seq}`;
}

export function agentPendingAssistantId(clientMessageId: string): string {
  return `agent-pending-${clientMessageId}`;
}

function appendAgentNotice(
  runtime: ChatSessionRuntime,
  agentId: string,
  id: string,
  createdAt: number,
  text: string,
  level: "info" | "warning" | "error" | "system",
): ChatSessionRuntime {
  const trimmed = text.trim();
  if (!trimmed || runtime.messages.some((message) => message.id === id)) return runtime;
  return {
    ...runtime,
    messages: [
      ...runtime.messages,
      {
        id,
        sessionId: agentId,
        role: "system",
        createdAt,
        status: level === "error" ? "error" : "complete",
        parts: [{ type: "notice", level, text: trimmed }],
      },
    ],
  };
}

function withActiveAgentAssistant(
  runtime: ChatSessionRuntime,
  envelope: AgentStreamEnvelope,
  turnId: string | undefined,
  updater: (message: HermesUIMessage) => HermesUIMessage | null,
): ChatSessionRuntime {
  const id = runtime.activeAssistantId ?? agentAssistantMessageId(turnId ?? runtime.activeTurnId, envelope.seq);
  const reconnecting = runtime.statusMessage === AGENT_RECONNECT_STATUS;
  const ensured = ensureAssistantMessage(
    {
      ...runtime,
      ...(reconnecting ? { statusMessage: "", statusKind: undefined, statusUpdatedAt: undefined } : {}),
      activeAssistantId: id,
      streamStatus: isStreamingStatus(runtime.streamStatus) ? "streaming" : runtime.streamStatus,
      turnStartedAt: runtime.turnStartedAt ?? envelope.timestamp,
    },
    envelope.agentId,
    id,
    envelope.timestamp,
  );
  return updateMessage(ensured, id, updater);
}

function agentToolState(status: ToolCallTimelineItem["status"]): HermesToolPart["state"] {
  if (status === "running") return "running";
  if (status === "completed") return "done";
  return "error";
}

function upsertAgentToolPart(
  parts: HermesMessagePart[],
  item: ToolCallTimelineItem,
  timestamp: number,
): HermesMessagePart[] {
  const display = describeToolCall(item);
  const index = parts.findIndex((part) => part.type === "tool" && part.toolCallId === item.callId);
  const existing = index === -1 ? undefined : parts[index] as HermesToolPart;
  const state = agentToolState(item.status);
  const errorText = item.error
    ? item.error
    : item.status === "canceled"
      ? "已取消"
      : undefined;
  const subAgent = item.detail.type === "sub_agent"
    ? {
        ...(item.detail.subAgentType ? { subAgentType: item.detail.subAgentType } : {}),
        ...(item.detail.description ? { description: item.detail.description } : {}),
        log: item.detail.log,
      }
    : undefined;
  const tool: HermesToolPart = {
    type: "tool",
    toolCallId: item.callId,
    // 子代理卡片显示子代理类型（design.md 4.11），缺省 Task
    name: subAgent ? subAgent.subAgentType ?? "Task" : item.name,
    state,
    input: display.context,
    preview: display.preview,
    output: display.output,
    errorText,
    startedAt: existing?.startedAt ?? timestamp,
    completedAt: state === "running" ? undefined : existing?.completedAt ?? timestamp,
    ...(subAgent ? { subAgent } : {}),
  };
  if (!existing) return appendToolPart(withoutProgressParts(parts), tool);
  const next = [...parts];
  next[index] = tool;
  return next;
}

function agentUsageMetadata(usage: AgentUsage | undefined): HermesMessageMetadata["usage"] | undefined {
  if (!usage) return undefined;
  const next: NonNullable<HermesMessageMetadata["usage"]> = {};
  if (typeof usage.inputTokens === "number") next.tokensInput = usage.inputTokens;
  if (typeof usage.outputTokens === "number") next.tokensOutput = usage.outputTokens;
  if (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number") {
    next.tokensTotal = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  }
  if (typeof usage.cachedInputTokens === "number") next.cacheRead = usage.cachedInputTokens;
  if (typeof usage.contextWindowUsedTokens === "number") next.contextUsed = usage.contextWindowUsedTokens;
  if (typeof usage.contextWindowMaxTokens === "number") next.contextMax = usage.contextWindowMaxTokens;
  return Object.keys(next).length > 0 ? next : undefined;
}

function agentTurnMetadata(
  runtime: ChatSessionRuntime,
  completedAt: number,
  usage: AgentUsage | undefined,
): HermesMessageMetadata {
  const timing: NonNullable<HermesMessageMetadata["timing"]> = { completedAt };
  const startedAt = runtime.turnStartedAt;
  const firstTokenAt = runtime.turnFirstTokenAt;
  if (typeof startedAt === "number") {
    timing.startedAt = startedAt;
    if (completedAt >= startedAt) timing.durationMs = completedAt - startedAt;
  }
  if (typeof firstTokenAt === "number") {
    timing.firstTokenAt = firstTokenAt;
    if (typeof startedAt === "number" && firstTokenAt >= startedAt) timing.ttftMs = firstTokenAt - startedAt;
  }
  const metadata: HermesMessageMetadata = { timing };
  const usageMetadata = agentUsageMetadata(usage);
  if (usageMetadata) metadata.usage = usageMetadata;
  if (typeof usage?.totalCostUsd === "number") metadata.costUsd = usage.totalCostUsd;
  return metadata;
}

function finishAgentTurn(
  runtime: ChatSessionRuntime,
  completedAt: number,
  outcome: "complete" | "error" | "canceled",
  usage: AgentUsage | undefined,
): ChatSessionRuntime {
  const id = runtime.activeAssistantId;
  const metadata = agentTurnMetadata(runtime, completedAt, usage ?? runtime.agentUsage);
  const next = id
    ? updateMessage(runtime, id, (message) => {
        let parts = withoutProgressParts(message.parts);
        if (outcome !== "complete") parts = terminateRunningTools(parts);
        if (parts.length === 0) return null;
        return {
          ...message,
          status: outcome === "error" ? "error" : "complete",
          parts,
          metadata: { ...message.metadata, ...metadata },
        };
      })
    : runtime;
  return {
    ...next,
    streamStatus: outcome === "error" ? "error" : outcome === "canceled" ? "idle" : "complete",
    pendingApprovals: [],
    statusMessage: "",
    statusKind: undefined,
    statusUpdatedAt: undefined,
    activeAssistantId: undefined,
    activeTurnId: undefined,
    agentTextMessageId: undefined,
    turnStartedAt: undefined,
    turnFirstTokenAt: undefined,
    interrupted: undefined,
    agentUsage: usage ?? runtime.agentUsage,
  };
}

function todoStatusText(items: { text: string; completed: boolean }[]): string {
  if (items.length === 0) return "";
  const done = items.filter((item) => item.completed).length;
  const current = items.find((item) => !item.completed);
  return current
    ? `计划进度 ${done}/${items.length}：${current.text}`
    : `计划进度 ${done}/${items.length}：全部完成`;
}

/** 从后往前找含该 callId 工具卡片的消息 id。 */
function findToolOwnerMessageId(runtime: ChatSessionRuntime, callId: string): string | undefined {
  for (let index = runtime.messages.length - 1; index >= 0; index -= 1) {
    const message = runtime.messages[index]!;
    if (message.parts.some((part) => part.type === "tool" && part.toolCallId === callId)) {
      return message.id;
    }
  }
  return undefined;
}

function reduceAgentTimelineItem(
  runtime: ChatSessionRuntime,
  envelope: AgentStreamEnvelope,
  item: AgentTimelineItem,
  turnId: string | undefined,
): ChatSessionRuntime {
  const { agentId, timestamp, seq } = envelope;
  switch (item.type) {
    case "user_message": {
      const optimisticId = item.clientMessageId;
      if (optimisticId && runtime.messages.some((message) => message.id === optimisticId)) {
        // 本地乐观消息已在：只确认状态，不重复插入
        return updateMessage(runtime, optimisticId, (message) => ({ ...message, status: "complete" }));
      }
      return {
        ...runtime,
        // 新的一轮从这条用户消息开始；上一轮的助手消息不再承接后续输出
        activeAssistantId: undefined,
        messages: [
          ...runtime.messages,
          {
            id: optimisticId ?? item.messageId ?? `agent-user-${seq}`,
            sessionId: agentId,
            role: "user",
            createdAt: timestamp,
            status: "complete",
            parts: [{ type: "text", text: item.text }],
          },
        ],
      };
    }

    case "assistant_message": {
      if (!item.text) return runtime;
      // 一轮内可能有多条 assistant_message（不同 messageId）：换 messageId 时另起一个文本段
      const newSegment = Boolean(
        item.messageId && runtime.agentTextMessageId && item.messageId !== runtime.agentTextMessageId,
      );
      return withActiveAgentAssistant(
        {
          ...runtime,
          agentTextMessageId: item.messageId ?? runtime.agentTextMessageId,
          turnFirstTokenAt: runtime.turnFirstTokenAt ?? timestamp,
        },
        envelope,
        turnId,
        (message) => ({
          ...message,
          status: "streaming",
          parts: newSegment
            ? [...withoutProgressParts(message.parts), { type: "text", text: item.text }]
            : appendTextPart(message.parts, item.text),
        }),
      );
    }

    case "reasoning": {
      if (!item.text) return runtime;
      return withActiveAgentAssistant(
        { ...runtime, turnFirstTokenAt: runtime.turnFirstTokenAt ?? timestamp },
        envelope,
        turnId,
        (message) => ({ ...message, status: "streaming", parts: appendReasoningPart(message.parts, item.text) }),
      );
    }

    case "tool_call": {
      // 同 callId 的卡片可能在更早的消息里（子代理活动可能晚于回合结束，design.md 4.11）：原地更新
      const ownerId = findToolOwnerMessageId(runtime, item.callId);
      if (ownerId && ownerId !== runtime.activeAssistantId) {
        return updateMessage(runtime, ownerId, (message) => ({
          ...message,
          parts: upsertAgentToolPart(message.parts, item, timestamp),
        }));
      }
      return withActiveAgentAssistant(runtime, envelope, turnId, (message) => ({
        ...message,
        status: "streaming",
        parts: upsertAgentToolPart(message.parts, item, timestamp),
      }));
    }

    case "todo":
      return {
        ...runtime,
        agentTodos: item.items,
        statusMessage: todoStatusText(item.items),
        statusKind: "todo",
        statusUpdatedAt: timestamp,
      };

    case "error":
      return appendAgentNotice(runtime, agentId, `agent-notice-${seq}`, timestamp, item.message, "error");

    default:
      return runtime;
  }
}

function reduceAgentEventInner(
  runtime: ChatSessionRuntime,
  envelope: AgentStreamEnvelope,
): ChatSessionRuntime {
  const { event, agentId, timestamp, seq } = envelope;
  switch (event.type) {
    case "timeline":
      return reduceAgentTimelineItem(runtime, envelope, event.item, event.turnId);

    case "turn_started": {
      const active = runtime.activeAssistantId
        ? runtime.messages.find((message) => message.id === runtime.activeAssistantId)
        : undefined;
      // 复用发送时插入的乐观助手消息；否则（回放 / 其它客户端发起）按 turnId 新建
      const id = active && active.status === "streaming"
        ? active.id
        : agentAssistantMessageId(event.turnId, seq);
      return ensureAssistantMessage(
        {
          ...runtime,
          streamStatus: "streaming",
          activeAssistantId: id,
          activeTurnId: event.turnId,
          agentTextMessageId: undefined,
          turnStartedAt: active ? runtime.turnStartedAt ?? timestamp : timestamp,
          turnFirstTokenAt: undefined,
          statusMessage: "",
          statusKind: undefined,
          statusUpdatedAt: undefined,
          interrupted: undefined,
        },
        agentId,
        id,
        timestamp,
      );
    }

    case "turn_completed":
      return finishAgentTurn(runtime, timestamp, "complete", event.usage);

    case "turn_failed": {
      const finished = finishAgentTurn(runtime, timestamp, "error", undefined);
      const base = event.error || "Agent 执行失败";
      const text = event.code === "PROCESS_EXITED"
        ? `${base}（Agent 进程已退出，请新建会话继续）`
        : base;
      return appendAgentNotice(finished, agentId, `agent-notice-${seq}`, timestamp, text, "error");
    }

    case "turn_canceled": {
      const finished = finishAgentTurn(runtime, timestamp, "canceled", undefined);
      return appendAgentNotice(finished, agentId, `agent-notice-${seq}`, timestamp, "已中断本轮", "info");
    }

    case "permission_requested": {
      const request = event.request;
      const approval: PendingApproval = {
        requestId: request.id,
        sessionId: agentId,
        command: describePermissionCommand(request),
        reason: request.description,
        permission: request,
      };
      return {
        ...runtime,
        pendingApprovals: [
          ...runtime.pendingApprovals.filter((item) => item.requestId !== request.id),
          approval,
        ],
      };
    }

    case "permission_resolved":
      return {
        ...runtime,
        pendingApprovals: runtime.pendingApprovals.filter((item) => item.requestId !== event.requestId),
      };

    case "usage_updated":
      return { ...runtime, agentUsage: event.usage };

    default:
      // thread_started / model_changed / mode_changed：快照由 agent.state 更新，时间线无变化
      return runtime;
  }
}

/** 把一个 sidecar 事件归约进会话运行时；seq 不大于已归约序号的事件直接忽略（与 epoch 无关）。 */
export function reduceAgentEvent(
  runtime: ChatSessionRuntime,
  envelope: AgentStreamEnvelope,
  now = Date.now(),
): ChatSessionRuntime {
  if (runtime.agentLastSeq !== undefined && envelope.seq <= runtime.agentLastSeq) {
    return runtime;
  }
  const next = reduceAgentEventInner(runtime, envelope);
  return {
    ...next,
    agentLastSeq: envelope.seq,
    agentEpoch: envelope.epoch,
    lastActivityAt: now,
    updatedAt: now,
  };
}

export const applyAgentEventAtom = atom(null, (get, set, envelope: AgentStreamEnvelope, replay = false) => {
  // 通知旁路：用归约前的运行时判断是否「在场」的回合，避免回放重复通知；
  // timeline 补齐（打开历史会话、断线补齐）的事件一律不通知。
  if (!replay) {
    notifyFromAgentEvent(
      envelope,
      get(chatRuntimeBySessionAtom)[envelope.agentId],
      get(agentSnapshotsAtom)[envelope.agentId]?.title,
    );
  }
  set(chatRuntimeBySessionAtom, (state) =>
    updateSessionRuntime(state, envelope.agentId, (runtime) => reduceAgentEvent(runtime, envelope)),
  );
});

/** 发送前写入乐观的用户消息与占位助手消息（id = clientMessageId，事件到达后去重）。 */
export const startAgentPromptAtom = atom(
  null,
  (
    _get,
    set,
    params: {
      agentId: string;
      clientMessageId: string;
      text: string;
      images?: ImageEntry[];
      /** 占位助手消息的进度文案（恢复 dormant / closed 会话时为「正在恢复会话…」）。 */
      progressText?: string;
      now?: number;
    },
  ) => {
    const now = params.now ?? Date.now();
    const assistantId = agentPendingAssistantId(params.clientMessageId);
    const userParts: HermesMessagePart[] = [];
    if (params.text) userParts.push({ type: "text", text: params.text });
    for (const image of params.images ?? []) {
      const part = imagePartFromSource(image);
      if (part) userParts.push(part);
    }
    set(chatRuntimeBySessionAtom, (state) =>
      updateSessionRuntime(state, params.agentId, (runtime) => ({
        ...resetStream(runtime, now),
        interrupted: undefined,
        messages: [
          ...runtime.messages,
          {
            id: params.clientMessageId,
            sessionId: params.agentId,
            role: "user",
            createdAt: now,
            status: "streaming",
            parts: userParts.length ? userParts : [{ type: "text", text: params.text }],
          },
          {
            id: assistantId,
            sessionId: params.agentId,
            role: "assistant",
            createdAt: now,
            status: "streaming",
            parts: [{ type: "progress", text: params.progressText ?? AGENT_PENDING_PROGRESS }],
          },
        ],
        streamStatus: "streaming",
        pendingApprovals: [],
        turnStartedAt: now,
        turnFirstTokenAt: undefined,
        activeAssistantId: assistantId,
      })),
    );
  },
);

/** `agent.send` 失败：撤掉占位助手消息，用户消息保留，追加错误提示。 */
export const failAgentPromptAtom = atom(
  null,
  (_get, set, params: { agentId: string; clientMessageId: string; message: string; now?: number }) => {
    const now = params.now ?? Date.now();
    const assistantId = agentPendingAssistantId(params.clientMessageId);
    set(chatRuntimeBySessionAtom, (state) =>
      updateSessionRuntime(state, params.agentId, (runtime) => {
        let next = updateMessage(runtime, assistantId, (message) => {
          const parts = withoutProgressParts(message.parts);
          return parts.length ? { ...message, status: "error", parts } : null;
        });
        next = updateMessage(next, params.clientMessageId, (message) => ({ ...message, status: "complete" }));
        next = appendAgentNotice(next, params.agentId, `agent-send-error-${params.clientMessageId}`, now, `发送失败：${params.message}`, "error");
        const ownsTurn = runtime.activeAssistantId === assistantId;
        return {
          ...next,
          streamStatus: ownsTurn ? "error" : next.streamStatus,
          activeAssistantId: ownsTurn ? undefined : next.activeAssistantId,
          turnStartedAt: ownsTurn ? undefined : next.turnStartedAt,
          turnFirstTokenAt: ownsTurn ? undefined : next.turnFirstTokenAt,
          updatedAt: now,
        };
      }),
    );
  },
);

/**
 * 重连 / 拉到新的 agent 列表后对齐运行时：断线期间被标成「重连中」的会话，
 * 若 sidecar 说仍在运行则恢复为 streaming，否则收尾为空闲。
 */
export const reconcileAgentRuntimesAtom = atom(
  null,
  (_get, set, agents: { id: string; status: string }[]) => {
    const statusById = new Map(agents.map((agent) => [agent.id, agent.status]));
    const now = Date.now();
    set(chatRuntimeBySessionAtom, (state) => {
      let changed = false;
      const next: ChatRuntimeBySession = { ...state };
      for (const [agentId, runtime] of Object.entries(state)) {
        if (runtime.streamStatus !== "connecting" || runtime.statusMessage !== AGENT_RECONNECT_STATUS) continue;
        const status = statusById.get(agentId);
        if (status === undefined) continue;
        changed = true;
        next[agentId] = status === "running" || status === "starting"
          ? { ...runtime, streamStatus: "streaming", statusMessage: "", statusKind: undefined, statusUpdatedAt: undefined, updatedAt: now }
          : finishAgentTurn(runtime, now, "complete", undefined);
      }
      return changed ? next : state;
    });
  },
);

/**
 * sidecar 重启（epoch 变化）：进行中的回合以错误收尾，挂起的审批作废。
 * 已归约的 seq 保留：持久化会话的 seq 跨进程连续递增，之后的 timeline 回放按 seq 去重；
 * 未持久化时旧 agent 会从 agent.list 中消失，新 agent 的 id 不会与之冲突。
 */
export const resetAgentRuntimesForEpochAtom = atom(null, (_get, set) => {
  const now = Date.now();
  set(chatRuntimeBySessionAtom, (state) => {
    let changed = false;
    const next: ChatRuntimeBySession = { ...state };
    for (const [agentId, runtime] of Object.entries(state)) {
      if (!isStreamingStatus(runtime.streamStatus) && runtime.pendingApprovals.length === 0) continue;
      changed = true;
      let updated: ChatSessionRuntime = { ...runtime, pendingApprovals: [] };
      if (isStreamingStatus(runtime.streamStatus)) {
        updated = appendAgentNotice(
          finishAgentTurn(updated, now, "error", undefined),
          agentId,
          `agent-epoch-reset-${now}`,
          now,
          "Agent 服务已重启，本轮已中断",
          "error",
        );
      }
      next[agentId] = updated;
    }
    return changed ? next : state;
  });
});

/**
 * 打开 dormant / closed 会话并回放完 timeline 后调用：历史里若留有未收尾的回合
 * （sidecar 在回合中途退出，没写入结束事件），该回合已不可能继续，静默收尾并清掉挂起审批。
 */
export const settleInactiveAgentRuntimeAtom = atom(null, (get, set, agentId: string) => {
  const status = get(agentSnapshotsAtom)[agentId]?.status;
  if (status !== "dormant" && status !== "closed") return;
  const now = Date.now();
  set(chatRuntimeBySessionAtom, (state) => {
    const runtime = state[agentId];
    if (!runtime || (!runtime.activeTurnId && runtime.pendingApprovals.length === 0)) return state;
    const settled = runtime.activeTurnId
      ? finishAgentTurn(runtime, now, "canceled", undefined)
      : { ...runtime, pendingApprovals: [] };
    return { ...state, [agentId]: settled };
  });
});

/** agent.removed / agent.delete 成功：从快照与会话运行时中移除，清掉指向它的当前会话，并记录给正在查看它的页面。 */
export const removeAgentAtom = atom(null, (get, set, agentId: string) => {
  set(agentSnapshotsAtom, (state) => {
    if (!(agentId in state)) return state;
    const { [agentId]: _removed, ...rest } = state;
    return rest;
  });
  set(chatRuntimeBySessionAtom, (state) => {
    if (!(agentId in state)) return state;
    const { [agentId]: _removed, ...rest } = state;
    return rest;
  });
  if (get(activeSessionIdAtom) === agentId) set(activeSessionIdAtom, null);
  set(lastRemovedAgentAtom, { agentId, nonce: (get(lastRemovedAgentAtom)?.nonce ?? 0) + 1 });
});
