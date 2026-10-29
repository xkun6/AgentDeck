import { atom } from "jotai";
import type {
  AgentPermissionRequest,
  AgentSnapshot,
  AgentStreamEnvelope,
  AgentTimelineItem,
  AgentUsage,
  AgentMessageMetadata,
  AgentMessagePart,
  AgentUIMessage,
  ToolCallTimelineItem,
} from "@agentdeck/protocol";
import { describePermissionCommand, describeToolCall } from "@/lib/agent-tool-detail";
import { formatTokens } from "@/lib/format";
import { describeInteropCall } from "@/lib/interop-tools";
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
  | { type: "text"; text: string; source?: "command" }
  | { type: "reasoning"; text: string }
  | { type: "progress"; text: string }
  | { type: "image"; image: ImageEntry }
  | { type: "tool"; tool: ToolEntry }
  | { type: "steer"; text: string; translatedText?: string }
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
  messages: AgentUIMessage[];
  streamStatus: StreamStatus;
  pendingApprovals: PendingApproval[];
  /** 已处理（resolved / 本地已回应）的审批 id，最近 50 条；快照补齐时据此避免把过期快照里的旧审批补回来 */
  resolvedApprovalIds?: string[];
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
  /** AgentDeck：已撤回的 turnId；其 turn_canceled 不再追加「已中断」提示（design.md 4.16）。 */
  retractedTurnId?: string;
  /** AgentDeck：最近一段 assistant_message 的 messageId（不同 messageId 分段拼接）。 */
  agentTextMessageId?: string;
  /** AgentDeck：进行中的回合是 CLI 自发轮次（origin background，design.md 4.12），不提供重试（4.21）。 */
  activeTurnBackground?: boolean;
  /** AgentDeck：进行中的回合是缓存保活（origin keepalive，design.md 4.36），结束时不发桌面通知。 */
  activeTurnKeepAlive?: boolean;
}

export type ChatRuntimeBySession = Record<string, ChatSessionRuntime>;

type AgentToolPart = Extract<AgentMessagePart, { type: "tool" }>;

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

function withoutProgressParts(parts: AgentMessagePart[]): AgentMessagePart[] {
  return parts.filter((part) => part.type !== "progress");
}

function terminateRunningTools(parts: AgentMessagePart[]): AgentMessagePart[] {
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

function appendTextPart(
  parts: AgentMessagePart[],
  text: string,
  source?: "command",
): AgentMessagePart[] {
  if (!text) return parts;
  const next = withoutProgressParts(parts);
  const last = next[next.length - 1];
  if (last?.type === "text" && last.source === source) {
    next[next.length - 1] = { ...last, text: last.text + text };
  } else {
    next.push({ type: "text", text, ...(source ? { source } : {}) });
  }
  return next;
}

function appendReasoningPart(parts: AgentMessagePart[], text: string): AgentMessagePart[] {
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

function appendToolPart(parts: AgentMessagePart[], tool: AgentToolPart): AgentMessagePart[] {
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
  updater: (message: AgentUIMessage) => AgentUIMessage | null,
): ChatSessionRuntime {
  // 目标几乎总是最后几条：从尾部找，避免长时间线回放时每个事件都整表 flatMap（O(n²)）。
  let index = -1;
  for (let i = runtime.messages.length - 1; i >= 0; i -= 1) {
    if (runtime.messages[i]!.id === id) {
      index = i;
      break;
    }
  }
  if (index === -1) return runtime;
  const next = updater(runtime.messages[index]!);
  const messages = runtime.messages.slice();
  if (next) messages[index] = next;
  else messages.splice(index, 1);
  return { ...runtime, messages };
}

function ensureAssistantMessage(
  runtime: ChatSessionRuntime,
  sessionId: string,
  id: string,
  now: number,
  seq?: number,
): ChatSessionRuntime {
  if (runtime.messages.some((message) => message.id === id)) {
    return updateMessage(runtime, id, (message) => ({
      ...message,
      status: message.status === "error" ? "error" : "streaming",
      ...(message.firstSeq === undefined && seq !== undefined ? { firstSeq: seq } : {}),
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
        ...(seq !== undefined ? { firstSeq: seq } : {}),
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
      updateSessionRuntime(state, params.sessionId, (runtime) =>
        withoutApproval(runtime, params.requestId),
      ),
    );
  },
);

const RESOLVED_APPROVAL_LIMIT = 50;

/** 移除一条待审批并记入「已处理」名单 */
function withoutApproval(runtime: ChatSessionRuntime, requestId: string): ChatSessionRuntime {
  const resolved = runtime.resolvedApprovalIds ?? [];
  return {
    ...runtime,
    pendingApprovals: runtime.pendingApprovals.filter((item) => item.requestId !== requestId),
    resolvedApprovalIds: resolved.includes(requestId)
      ? resolved
      : [...resolved, requestId].slice(-RESOLVED_APPROVAL_LIMIT),
  };
}

function approvalFromRequest(agentId: string, request: AgentPermissionRequest): PendingApproval {
  return {
    requestId: request.id,
    sessionId: agentId,
    command: describePermissionCommand(request),
    reason: request.description,
    permission: request,
  };
}

/**
 * 用快照的 `pendingPermissions` 校准待审批（design.md 4.31）：手机首屏只拉最近一页时间线，
 * 审批卡片原本只来自时间线里的 `permission_requested`，被分页截断后会话列表显示待审批、进去却没有卡片。
 * - 快照有、运行时没有、且不在「已处理」名单里的，按 `permission_requested` 的格式补进去；
 * - 快照已不存在的审批（快照至少和已归约事件一样新时）移除；快照更旧时只补不删，避免误删刚到的事件。
 * dormant / closed 会话不处理（打开后由 settleInactiveAgentRuntimeAtom 收尾）。
 */
export function syncPendingApprovals(
  runtime: ChatSessionRuntime,
  snapshot: Pick<AgentSnapshot, "id" | "status" | "pendingPermissions" | "lastSeq">,
): ChatSessionRuntime {
  if (snapshot.status === "dormant" || snapshot.status === "closed") return runtime;
  const pending = snapshot.pendingPermissions ?? [];
  const snapshotIds = new Set(pending.map((request) => request.id));
  const resolved = new Set(runtime.resolvedApprovalIds ?? []);
  const snapshotIsFresh = snapshot.lastSeq >= (runtime.agentLastSeq ?? 0);
  const kept = snapshotIsFresh
    ? runtime.pendingApprovals.filter((item) => snapshotIds.has(item.requestId))
    : runtime.pendingApprovals;
  const known = new Set(kept.map((item) => item.requestId));
  const added = pending
    .filter((request) => !known.has(request.id) && !resolved.has(request.id))
    .map((request) => approvalFromRequest(snapshot.id, request));
  if (kept.length === runtime.pendingApprovals.length && added.length === 0) return runtime;
  return { ...runtime, pendingApprovals: [...kept, ...added] };
}

/** 按 agentId 取 store 里的快照校准该会话的待审批；没有对应运行时（会话未打开）则不处理 */
export const syncPendingApprovalsAtom = atom(null, (get, set, agentId: string) => {
  const snapshot = get(agentSnapshotsAtom)[agentId];
  if (!snapshot) return;
  set(chatRuntimeBySessionAtom, (state) => {
    const runtime = state[agentId];
    if (!runtime) return state;
    const next = syncPendingApprovals(runtime, snapshot);
    return next === runtime ? state : { ...state, [agentId]: next };
  });
});

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

type AgentNoticeLevel = "info" | "warning" | "error" | "system";

function agentNoticeMessage(
  agentId: string,
  id: string,
  createdAt: number,
  text: string,
  level: AgentNoticeLevel,
): AgentUIMessage {
  return {
    id,
    sessionId: agentId,
    role: "system",
    createdAt,
    status: level === "error" ? "error" : "complete",
    parts: [{ type: "notice", level, text }],
  };
}

function appendAgentNotice(
  runtime: ChatSessionRuntime,
  agentId: string,
  id: string,
  createdAt: number,
  text: string,
  level: AgentNoticeLevel,
): ChatSessionRuntime {
  const trimmed = text.trim();
  if (!trimmed || runtime.messages.some((message) => message.id === id)) return runtime;
  return {
    ...runtime,
    messages: [...runtime.messages, agentNoticeMessage(agentId, id, createdAt, trimmed, level)],
  };
}

/** 上下文压缩提示的消息 id 前缀（design.md 4.13）；时间线据此渲染成居中分隔线。 */
export const AGENT_COMPACTION_NOTICE_PREFIX = "agent-compaction-";
/** timeline `notice` 系统提示（如会话分叉，design.md 4.23）的消息 id 前缀；同样渲染成居中分隔线。 */
export const AGENT_TIMELINE_NOTICE_PREFIX = "agent-timeline-notice-";

type CompactionTimelineItem = Extract<AgentTimelineItem, { type: "compaction" }>;

export function compactionNoticeText(item: CompactionTimelineItem): string {
  if (item.status === "running") return "正在压缩上下文…";
  if (item.status === "failed") return item.error ? `上下文压缩失败：${item.error}` : "上下文压缩失败";
  const base = item.trigger === "manual"
    ? "上下文已手动压缩"
    : item.trigger === "auto"
      ? "上下文已自动压缩"
      : "上下文已压缩";
  return typeof item.preTokens === "number" && item.preTokens > 0
    ? `${base}（压缩前 约 ${formatTokens(item.preTokens)} tokens）`
    : base;
}

/**
 * 同 compactionId 的提示原地更新；新提示插在本轮还没有内容的助手消息之前
 * （压缩通常发生在回答之前，回答随后显示在提示之下），否则追加在末尾。
 * 回合中途压缩（助手消息已有内容）时，在提示处截断助手消息、提示下方另起一条承接后续输出，
 * 否则后续输出仍写进提示上方那条，提示会一直停在时间线底部。
 */
function upsertCompactionNotice(
  runtime: ChatSessionRuntime,
  agentId: string,
  item: CompactionTimelineItem,
  createdAt: number,
): ChatSessionRuntime {
  const id = `${AGENT_COMPACTION_NOTICE_PREFIX}${item.compactionId}`;
  const level: AgentNoticeLevel = item.status === "failed" ? "warning" : "system";
  const text = compactionNoticeText(item);
  if (runtime.messages.some((message) => message.id === id)) {
    return updateMessage(runtime, id, (message) => ({
      ...message,
      status: "complete",
      parts: [{ type: "notice", level, text }],
    }));
  }
  const notice = agentNoticeMessage(agentId, id, createdAt, text, level);
  const activeIndex = runtime.activeAssistantId
    ? runtime.messages.findIndex((message) => message.id === runtime.activeAssistantId)
    : -1;
  const active = activeIndex === -1 ? undefined : runtime.messages[activeIndex];
  if (active && withoutProgressParts(active.parts).length === 0) {
    return {
      ...runtime,
      messages: [...runtime.messages.slice(0, activeIndex), notice, ...runtime.messages.slice(activeIndex)],
    };
  }
  if (!active) return { ...runtime, messages: [...runtime.messages, notice] };
  const segmentId = `${active.id}-after-${id}`;
  const closed = updateMessage(runtime, active.id, (message) => ({
    ...message,
    status: message.status === "error" ? "error" : "complete",
    parts: withoutProgressParts(message.parts),
  }));
  return {
    ...closed,
    activeAssistantId: segmentId,
    messages: [
      ...closed.messages,
      notice,
      { id: segmentId, sessionId: agentId, role: "assistant", createdAt, status: "streaming", parts: [] },
    ],
  };
}

function withActiveAgentAssistant(
  runtime: ChatSessionRuntime,
  envelope: AgentStreamEnvelope,
  turnId: string | undefined,
  updater: (message: AgentUIMessage) => AgentUIMessage | null,
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
    envelope.seq,
  );
  return updateMessage(ensured, id, updater);
}

function agentToolState(status: ToolCallTimelineItem["status"]): AgentToolPart["state"] {
  if (status === "running") return "running";
  if (status === "completed") return "done";
  return "error";
}

function upsertAgentToolPart(
  parts: AgentMessagePart[],
  item: ToolCallTimelineItem,
  timestamp: number,
): AgentMessagePart[] {
  const display = describeToolCall(item);
  const index = parts.findIndex((part) => part.type === "tool" && part.toolCallId === item.callId);
  const existing = index === -1 ? undefined : parts[index] as AgentToolPart;
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
  // agentdeck MCP 互通工具（design.md 4.26）：时间线渲染为委派卡片
  const delegate = describeInteropCall(item);
  const tool: AgentToolPart = {
    type: "tool",
    toolCallId: item.callId,
    // 子代理卡片显示子代理类型（design.md 4.11），缺省 Task；Agent 提问显示为「提问」（4.13）
    name: subAgent ? subAgent.subAgentType ?? "Task" : item.detail.type === "question" ? "提问" : item.name,
    state,
    input: display.context,
    preview: display.preview,
    output: display.output,
    errorText,
    startedAt: existing?.startedAt ?? timestamp,
    completedAt: state === "running" ? undefined : existing?.completedAt ?? timestamp,
    ...(subAgent ? { subAgent } : {}),
    ...(delegate ? { delegate } : {}),
    // unknown（多为 MCP）的 output 文本里拼了输入，图片只从原始输出里找（design.md 5.3）
    ...(item.detail.type === "unknown" ? { imageSource: item.detail.output } : {}),
  };
  if (!existing) return appendToolPart(withoutProgressParts(parts), tool);
  const next = [...parts];
  next[index] = tool;
  return next;
}

function agentUsageMetadata(usage: AgentUsage | undefined): AgentMessageMetadata["usage"] | undefined {
  if (!usage) return undefined;
  const next: NonNullable<AgentMessageMetadata["usage"]> = {};
  if (typeof usage.inputTokens === "number") next.tokensInput = usage.inputTokens;
  if (typeof usage.outputTokens === "number") next.tokensOutput = usage.outputTokens;
  if (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number") {
    next.tokensTotal = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  }
  if (typeof usage.cachedInputTokens === "number") next.cacheRead = usage.cachedInputTokens;
  if (typeof usage.contextWindowUsedTokens === "number") next.contextUsed = usage.contextWindowUsedTokens;
  if (typeof usage.contextWindowMaxTokens === "number") next.contextMax = usage.contextWindowMaxTokens;
  if (typeof usage.outputTokensPerSecond === "number" && Number.isFinite(usage.outputTokensPerSecond) && usage.outputTokensPerSecond > 0) {
    next.outputTokensPerSecond = usage.outputTokensPerSecond;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function agentTurnMetadata(
  runtime: ChatSessionRuntime,
  completedAt: number,
  usage: AgentUsage | undefined,
): AgentMessageMetadata {
  const timing: NonNullable<AgentMessageMetadata["timing"]> = { completedAt };
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
  const metadata: AgentMessageMetadata = { timing };
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
  // 最终速度只取自 turn_completed.usage；失败 / 取消回退到 runtime.agentUsage 时可能是上一回合的残值，不写入
  if (!usage && metadata.usage) {
    const { outputTokensPerSecond: _speed, ...rest } = metadata.usage;
    if (Object.keys(rest).length > 0) metadata.usage = rest;
    else delete metadata.usage;
  }
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
      if (item.steer) {
        // 运行中插话（design.md 4.22）：不开新一轮，作为内联气泡并入当前助手消息流
        return withActiveAgentAssistant(runtime, envelope, turnId, (message) => ({
          ...message,
          status: "streaming",
          parts: [
            ...withoutProgressParts(message.parts),
            {
              type: "steer",
              text: item.text,
              ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}),
              ...(item.translatedText ? { translatedText: item.translatedText } : {}),
            },
          ],
        }));
      }
      const optimisticId = item.clientMessageId;
      if (optimisticId && runtime.messages.some((message) => message.id === optimisticId)) {
        // 本地乐观消息已在：只确认状态，不重复插入
        return updateMessage(runtime, optimisticId, (message) => ({
          ...message,
          status: "complete",
          ...(message.firstSeq === undefined ? { firstSeq: seq } : {}),
          ...(item.translatedText ? { translatedText: item.translatedText } : {}),
        }));
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
            // 由时间线重建：图片没有落盘，再次发送只能重发文字（design.md 4.21）
            restored: true,
            firstSeq: seq,
            ...(item.translatedText ? { translatedText: item.translatedText } : {}),
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
            ? [
                ...withoutProgressParts(message.parts),
                { type: "text", text: item.text, ...(item.source ? { source: item.source } : {}) },
              ]
            : appendTextPart(message.parts, item.text, item.source),
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

    case "notice":
      return appendAgentNotice(
        runtime,
        agentId,
        `${AGENT_TIMELINE_NOTICE_PREFIX}${seq}`,
        timestamp,
        item.text,
        "system",
      );

    case "compaction": {
      const next = upsertCompactionNotice(runtime, agentId, item, timestamp);
      // 压缩后不再显示压缩前的已用量，等下一次 usage 刷新
      if (item.status !== "completed" || next.agentUsage?.contextWindowUsedTokens === undefined) return next;
      const { contextWindowUsedTokens: _used, ...usage } = next.agentUsage;
      return { ...next, agentUsage: usage };
    }

    default:
      return runtime;
  }
}

/**
 * design.md 4.16：当前回合尚无任何输出（助手消息只有进度占位、无待审批）时，
 * 返回可撤回的最后一条用户消息 id；否则 undefined。
 */
export function retractableUserMessageId(runtime: ChatSessionRuntime | undefined): string | undefined {
  if (!runtime || runtime.streamStatus !== "streaming" || runtime.pendingApprovals.length > 0) {
    return undefined;
  }
  if (runtime.turnFirstTokenAt !== undefined || runtime.statusKind === "todo") return undefined;
  const { messages } = runtime;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user") return message.id;
    if (message.role === "assistant" && withoutProgressParts(message.parts).length > 0) return undefined;
    if (message.role === "system") return undefined;
  }
  return undefined;
}

/** design.md 4.16：移除被撤回的用户消息（按 clientMessageId，缺省取最近一条）与本轮空的助手占位。 */
function retractAgentUserMessage(
  runtime: ChatSessionRuntime,
  turnId: string,
  clientMessageId: string | undefined,
): ChatSessionRuntime {
  let userIndex = -1;
  if (clientMessageId) {
    userIndex = runtime.messages.findIndex(
      (message) => message.role === "user" && message.id === clientMessageId,
    );
  }
  if (userIndex < 0) {
    for (let index = runtime.messages.length - 1; index >= 0; index -= 1) {
      if (runtime.messages[index]!.role === "user") {
        userIndex = index;
        break;
      }
    }
  }
  const placeholderIds = new Set<string>([agentAssistantMessageId(turnId, 0)]);
  if (runtime.activeAssistantId) placeholderIds.add(runtime.activeAssistantId);
  if (clientMessageId) placeholderIds.add(agentPendingAssistantId(clientMessageId));
  const messages = runtime.messages.filter((message, index) => {
    if (index === userIndex) return false;
    if (message.role === "assistant" && placeholderIds.has(message.id)) {
      return withoutProgressParts(message.parts).length > 0;
    }
    return true;
  });
  const activeKept =
    runtime.activeAssistantId && messages.some((message) => message.id === runtime.activeAssistantId)
      ? runtime.activeAssistantId
      : undefined;
  return { ...runtime, messages, activeAssistantId: activeKept, retractedTurnId: turnId };
}

/** design.md 4.21：失败 / 中断的回合可重试，取该回合前最近一条用户消息；CLI 自发轮次不提供。 */
function retryUserMessageIdFor(runtime: ChatSessionRuntime): string | undefined {
  if (runtime.activeTurnBackground) return undefined;
  for (let index = runtime.messages.length - 1; index >= 0; index -= 1) {
    const message = runtime.messages[index]!;
    if (message.role === "user") return message.id;
  }
  return undefined;
}

/** 给回合末尾的提示消息打上「可重试」标记（retryFor = 用户消息 id）。 */
function withRetryMark(
  runtime: ChatSessionRuntime,
  noticeId: string,
  userMessageId: string | undefined,
): ChatSessionRuntime {
  if (!userMessageId) return runtime;
  return updateMessage(runtime, noticeId, (message) => ({ ...message, retryFor: userMessageId }));
}

/**
 * design.md 4.21：空闲时，最后一条用户消息之后若有以 turn_failed / turn_canceled 结束该回合留下的提示，
 * 返回提示消息 id 与对应用户消息 id（用于在回合末尾显示「重试」）。
 */
export function retryableTurn(
  runtime: ChatSessionRuntime | undefined,
): { noticeId: string; userMessageId: string } | undefined {
  if (!runtime || isStreamingStatus(runtime.streamStatus)) return undefined;
  const { messages } = runtime;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user") return undefined;
    if (typeof message.retryFor === "string") return { noticeId: message.id, userMessageId: message.retryFor };
  }
  return undefined;
}

/** design.md 4.21：空闲时的最后一条用户消息（悬停提供「再次发送」）。 */
export function resendableUserMessage(runtime: ChatSessionRuntime | undefined): AgentUIMessage | undefined {
  if (!runtime || isStreamingStatus(runtime.streamStatus)) return undefined;
  for (let index = runtime.messages.length - 1; index >= 0; index -= 1) {
    const message = runtime.messages[index]!;
    if (message.role === "user") return message;
  }
  return undefined;
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
          activeTurnBackground: event.origin === "background",
          activeTurnKeepAlive: event.origin === "keepalive",
          statusMessage: "",
          statusKind: undefined,
          statusUpdatedAt: undefined,
          interrupted: undefined,
        },
        agentId,
        id,
        timestamp,
        seq,
      );
    }

    case "turn_completed":
      return finishAgentTurn(runtime, timestamp, "complete", event.usage);

    case "turn_failed": {
      const retryUserId = retryUserMessageIdFor(runtime);
      const finished = finishAgentTurn(runtime, timestamp, "error", undefined);
      const base = event.error || "Agent 执行失败";
      const text = event.code === "PROCESS_EXITED"
        ? `${base}（Agent 进程已退出，请新建会话继续）`
        : base;
      return withRetryMark(
        appendAgentNotice(finished, agentId, `agent-notice-${seq}`, timestamp, text, "error"),
        `agent-notice-${seq}`,
        retryUserId,
      );
    }

    case "user_message_retracted":
      return retractAgentUserMessage(runtime, event.turnId, event.clientMessageId);

    case "turn_canceled": {
      const retryUserId = retryUserMessageIdFor(runtime);
      const finished = finishAgentTurn(runtime, timestamp, "canceled", undefined);
      if (runtime.retractedTurnId === event.turnId) {
        return { ...finished, retractedTurnId: undefined };
      }
      return withRetryMark(
        appendAgentNotice(finished, agentId, `agent-notice-${seq}`, timestamp, "已中断本轮", "info"),
        `agent-notice-${seq}`,
        retryUserId,
      );
    }

    case "permission_requested": {
      const request = event.request;
      const approval = approvalFromRequest(agentId, request);
      return {
        ...runtime,
        pendingApprovals: [
          ...runtime.pendingApprovals.filter((item) => item.requestId !== request.id),
          approval,
        ],
      };
    }

    case "permission_resolved":
      return withoutApproval(runtime, event.requestId);

    case "usage_updated":
      // 浅合并：回合中只带上下文字段的更新不抹掉 token / 费用字段（design.md 4.3）
      return { ...runtime, agentUsage: { ...runtime.agentUsage, ...event.usage } };

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

/** `parts` 是否以 `prefix` 开头（最后一段文本允许在 `parts` 里被后续文本接长） */
function startsWithParts(parts: AgentMessagePart[], prefix: AgentMessagePart[]): boolean {
  if (parts.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    const a = parts[index]!;
    const b = prefix[index]!;
    if (index === prefix.length - 1 && a.type === "text" && b.type === "text") {
      return a.source === b.source && a.text.startsWith(b.text);
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) return false;
  }
  return true;
}

/** 把 older 页里被页边界截开的回合的前半段 parts 接到已有消息的 parts 前面（相邻同来源文本拼成一段，与整段回放一致） */
function joinSplitTurnParts(older: AgentMessagePart[], known: AgentMessagePart[]): AgentMessagePart[] {
  const last = older[older.length - 1];
  const first = known[0];
  if (last?.type === "text" && first?.type === "text" && last.source === first.source) {
    return [...older.slice(0, -1), { ...last, text: last.text + first.text }, ...known.slice(1)];
  }
  return [...older, ...known];
}

/**
 * 向前分页（design.md 4.31）：把更早的一页条目归约成消息并**前插**到现有消息之前。
 * 页首通常是回合起点、页尾紧接现有时间线首个回合之前，所以每页单独从空运行时归约即可得到完整回合；
 * 消息 id 由 seq / turnId / clientMessageId 决定，已存在的 id 直接跳过。
 *
 * 例外：sidecar 为控制页大小会在回合中间截断（条数 / 字节上限），此时同一回合的助手消息（id 为 `agent-turn-<turnId>`）
 * 同时出现在 older 页末尾与现有首个回合里：older 里的前半段并到已有消息之前（已完整包含的重复页则跳过）。
 */
export function prependAgentHistory(
  runtime: ChatSessionRuntime,
  entries: readonly AgentStreamEnvelope[],
  now = Date.now(),
): ChatSessionRuntime {
  let older = createEmptyChatRuntime(now);
  for (const envelope of entries) older = reduceAgentEvent(older, envelope, now);
  const known = new Map(runtime.messages.map((message) => [message.id, message]));
  const prepend: AgentUIMessage[] = [];
  const merged = new Map<string, AgentUIMessage>();
  for (const message of older.messages) {
    const existing = known.get(message.id);
    if (!existing) {
      prepend.push(message);
      continue;
    }
    if (message.role !== "assistant" || message.parts.length === 0) continue;
    if (startsWithParts(existing.parts, message.parts)) continue; // 同一页重复前插（已并入过）
    merged.set(message.id, {
      ...existing,
      createdAt: Math.min(existing.createdAt, message.createdAt),
      parts: joinSplitTurnParts(message.parts, existing.parts),
    });
  }
  if (prepend.length === 0 && merged.size === 0) return runtime;
  const messages = merged.size > 0 ? runtime.messages.map((message) => merged.get(message.id) ?? message) : runtime.messages;
  return { ...runtime, messages: [...prepend, ...messages], updatedAt: now };
}

export const prependAgentHistoryAtom = atom(
  null,
  (_get, set, input: { agentId: string; entries: readonly AgentStreamEnvelope[] }) => {
    set(chatRuntimeBySessionAtom, (state) =>
      updateSessionRuntime(state, input.agentId, (runtime) => prependAgentHistory(runtime, input.entries)),
    );
  },
);

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
    const userParts: AgentMessagePart[] = [];
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
        activeTurnBackground: false,
        activeTurnKeepAlive: false,
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
