// Derived from paseo packages/server/src/server/agent/providers/codex-app-server-agent.ts (Apache-2.0); modified for AgentDeck
// 子线程（provider 子代理）路由，对应 paseo 的 resolveCodexThreadRoute / bufferPendingSubAgentNotification /
// registerSubAgentToolCall / handleRegisteredSubAgentActivity / emitSubAgentActivityUpdate 等（design.md 4.11）。
// 改动：
// - 抽成独立类，由 CodexAgentSession 在通知入口与主线程工具项处调用；只处理 app-server v2 的 item/* 与 turn/* 通知
//   （AgentDeck 不消费 codex/event/* 旧事件与 exec 输出增量）；
// - 子线程文本增量只写子代理时间线、累积到子条目，不逐条重推父卡片（父卡片在条目开始 / 完成与回合变化时重推），
//   避免父时间线（会落盘）被大量增量更新淹没；
// - 不做恢复会话时的子线程历史回放。
import type {
  AgentTimelineItem,
  ProviderSubagentStatus,
  ToolCallTimelineItem,
} from "@agentdeck/protocol";

import type { ProviderSubagentInputEvent } from "../../agent/types.js";
import { curateAgentActivity } from "../shared/activity-curator.js";
import { mapCodexToolCallFromThreadItem } from "./tool-call-mapper.js";

/** 未登记子线程最多缓冲的线程数与每线程通知数（超出丢最旧） */
export const MAX_PENDING_SUB_AGENT_THREADS = 32;
export const MAX_PENDING_SUB_AGENT_NOTIFICATIONS_PER_THREAD = 128;

type JsonRecord = Record<string, unknown>;

interface SubAgentActivity {
  id: string | null;
  agentThreadId: string;
  /** started / interacted / interrupted / completed（0.162.1 实测子线程回合结束时发 completed） */
  kind: string;
}

interface SubAgentCallState {
  callId: string;
  toolCall: ToolCallTimelineItem;
  /** 嵌套：派出本卡片的上级子代理卡片 */
  parentCallId: string | null;
  parentSubagentId: string | null;
  activityItemIds: Set<string>;
  childItemOrder: string[];
  childItems: Map<string, AgentTimelineItem>;
  childThreadIds: Set<string>;
}

interface PendingNotification {
  method: string;
  params: JsonRecord | null;
}

export interface CodexSubagentRouterDeps {
  cwd: string;
  /** 父会话自己的线程：子线程发给父线程的 subAgentActivity（agentPath 为 /root）不能把它登记成子代理 */
  rootThreadId: () => string | null;
  /** 写入子代理 store */
  emitSubagent: (event: ProviderSubagentInputEvent) => void;
  /** 父会话时间线中的子代理卡片（同 callId 覆盖） */
  emitParentCard: (item: ToolCallTimelineItem) => void;
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isTerminal(status: ToolCallTimelineItem["status"]): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

function readSubAgentActivity(item: unknown): SubAgentActivity | null {
  const record = asRecord(item);
  if (
    !record ||
    record.type !== "subAgentActivity" ||
    typeof record.agentThreadId !== "string" ||
    typeof record.kind !== "string"
  ) {
    return null;
  }
  return { id: str(record.id) ?? null, agentThreadId: record.agentThreadId, kind: record.kind };
}

function userMessageText(item: JsonRecord): string {
  const content = Array.isArray(item.content) ? item.content : [];
  return content
    .map((part) => {
      const record = asRecord(part);
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

export class CodexSubagentRouter {
  private readonly calls = new Map<string, SubAgentCallState>();
  private readonly callIdByThreadId = new Map<string, string>();
  private readonly pending = new Map<string, PendingNotification[]>();
  /** 子线程 itemId → 已流式发出的 assistant 文本 */
  private readonly streamedText = new Map<string, string>();
  /** 子线程 itemId → 已流式发出的 reasoning 文本与来源 */
  private readonly streamedReasoning = new Map<string, { text: string; source: "summary" | "raw" }>();

  constructor(private readonly deps: CodexSubagentRouterDeps) {}

  /** 已登记的子线程 → 父卡片 callId */
  callIdForThread(threadId: string): string | undefined {
    return this.callIdByThreadId.get(threadId);
  }

  /** 非主线程的通知：已登记的路由到子代理，未登记的先缓冲 */
  routeNotification(method: string, params: JsonRecord | null, threadId: string): void {
    const callId = this.callIdByThreadId.get(threadId);
    if (callId) {
      this.dispatch(method, params, threadId, callId);
      return;
    }
    let queue = this.pending.get(threadId);
    if (!queue) {
      if (this.pending.size >= MAX_PENDING_SUB_AGENT_THREADS) {
        const oldest = this.pending.keys().next().value;
        if (typeof oldest === "string") this.pending.delete(oldest);
      }
      queue = [];
      this.pending.set(threadId, queue);
    }
    if (queue.length >= MAX_PENDING_SUB_AGENT_NOTIFICATIONS_PER_THREAD) {
      queue.shift();
    }
    queue.push({ method, params });
  }

  /**
   * 主线程的工具项（item/started、item/completed）：
   * - 已登记子线程的 subAgentActivity → 更新对应卡片，返回 "handled"；
   * - sub_agent 卡片 → 登记子线程，返回合并后的卡片（保留已累积的 log）与回放函数：
   *   调用方先发出卡片，再调用 replay 回放该卡片子线程的缓冲通知；
   * - 其它 → 返回 null（调用方按原逻辑处理）。
   */
  handleRootItem(
    rawItem: JsonRecord,
    tool: ToolCallTimelineItem,
  ): { card: ToolCallTimelineItem; replay: () => void } | "handled" | null {
    if (this.handleRegisteredActivity(rawItem)) {
      return "handled";
    }
    if (tool.detail.type !== "sub_agent") {
      return null;
    }
    const registered = this.register(tool, rawItem, null, null);
    const card = this.calls.get(tool.callId)?.toolCall ?? tool;
    return { card, replay: () => this.replayPending(registered) };
  }

  /** app-server 意外退出：仍在运行的子代理全部失败 */
  failRunning(): void {
    for (const state of this.calls.values()) {
      if (state.parentCallId === null && !isTerminal(state.toolCall.status)) {
        this.emitActivityUpdate(state.callId, "failed");
      }
    }
  }

  reset(): void {
    this.calls.clear();
    this.callIdByThreadId.clear();
    this.pending.clear();
    this.streamedText.clear();
    this.streamedReasoning.clear();
  }

  // -------------------------------------------------------------------------

  private dispatch(method: string, params: JsonRecord | null, threadId: string, callId: string): void {
    switch (method) {
      case "thread/started":
      case "turn/started":
        this.emitActivityUpdate(callId, "running", { reopen: true });
        return;
      case "turn/completed": {
        const status = String(asRecord(params?.turn)?.status ?? "completed");
        this.emitActivityUpdate(
          callId,
          status === "failed" ? "failed" : status === "interrupted" ? "canceled" : "completed",
        );
        return;
      }
      case "item/agentMessage/delta":
        this.handleTextDelta(params, threadId, callId);
        return;
      case "item/reasoning/summaryTextDelta":
        this.handleReasoningDelta(params, threadId, callId, "summary");
        return;
      case "item/reasoning/textDelta":
        this.handleReasoningDelta(params, threadId, callId, "raw");
        return;
      case "item/started":
        this.handleChildItem(params, threadId, callId, "started");
        return;
      case "item/completed":
        this.handleChildItem(params, threadId, callId, "completed");
        return;
      default:
        // 其它子线程遥测（tokenUsage、diff、plan 等）不进父时间线
        return;
    }
  }

  private handleTextDelta(params: JsonRecord | null, threadId: string, callId: string): void {
    const itemId = str(params?.itemId) ?? str(params?.item_id) ?? `${threadId}:agent-message`;
    const delta = typeof params?.delta === "string" ? params.delta : "";
    if (!delta) return;
    const text = (this.streamedText.get(itemId) ?? "") + delta;
    this.streamedText.set(itemId, text);
    this.deps.emitSubagent({
      type: "timeline",
      id: threadId,
      item: { type: "assistant_message", text: delta, messageId: itemId },
    });
    this.upsertChildItem(callId, itemId, { type: "assistant_message", text, messageId: itemId });
  }

  private handleReasoningDelta(
    params: JsonRecord | null,
    threadId: string,
    callId: string,
    source: "summary" | "raw",
  ): void {
    const itemId = str(params?.itemId) ?? str(params?.item_id) ?? `${threadId}:reasoning`;
    const delta = typeof params?.delta === "string" ? params.delta : "";
    if (!delta) return;
    const state = this.streamedReasoning.get(itemId);
    if (state && state.source !== source) return; // 同一推理项只取一种来源
    const text = (state?.text ?? "") + delta;
    this.streamedReasoning.set(itemId, { text, source });
    this.deps.emitSubagent({ type: "timeline", id: threadId, item: { type: "reasoning", text: delta } });
    this.upsertChildItem(callId, itemId, { type: "reasoning", text });
  }

  private handleChildItem(
    params: JsonRecord | null,
    threadId: string,
    callId: string,
    phase: "started" | "completed",
  ): void {
    const item = asRecord(params?.item);
    if (!item) return;
    const type = str(item.type);
    const itemId = str(item.id);

    if (type === "userMessage") {
      if (phase !== "completed") return;
      const text = userMessageText(item);
      if (text) {
        const timelineItem: AgentTimelineItem = { type: "user_message", text };
        this.deps.emitSubagent({ type: "timeline", id: threadId, item: timelineItem });
        if (itemId) this.upsertChildItem(callId, itemId, timelineItem);
        this.emitActivityUpdate(callId);
      }
      return;
    }

    if (type === "agentMessage") {
      if (phase !== "completed") return;
      const text = typeof item.text === "string" ? item.text : "";
      const streamed = itemId ? this.streamedText.get(itemId) : undefined;
      const missing =
        streamed === undefined ? text : text.startsWith(streamed) ? text.slice(streamed.length) : "";
      if (missing) {
        this.deps.emitSubagent({
          type: "timeline",
          id: threadId,
          item: { type: "assistant_message", text: missing, ...(itemId ? { messageId: itemId } : {}) },
        });
      }
      if (itemId) {
        this.upsertChildItem(callId, itemId, { type: "assistant_message", text, messageId: itemId });
        this.streamedText.delete(itemId);
      }
      this.emitActivityUpdate(callId);
      return;
    }

    if (type === "reasoning") {
      if (phase !== "completed") return;
      const streamed = itemId ? this.streamedReasoning.get(itemId) : undefined;
      if (itemId) this.streamedReasoning.delete(itemId);
      if (streamed && streamed.text.length > 0) {
        this.emitActivityUpdate(callId);
        return;
      }
      const summary = Array.isArray(item.summary) ? item.summary.filter((s) => typeof s === "string") : [];
      const content = Array.isArray(item.content) ? item.content.filter((s) => typeof s === "string") : [];
      const text = (summary.length > 0 ? summary : content).join("\n\n").trim();
      if (text) {
        this.deps.emitSubagent({ type: "timeline", id: threadId, item: { type: "reasoning", text } });
        if (itemId) this.upsertChildItem(callId, itemId, { type: "reasoning", text });
        this.emitActivityUpdate(callId);
      }
      return;
    }

    if (this.handleRegisteredActivity(item)) {
      return;
    }
    const tool = mapCodexToolCallFromThreadItem(item, { cwd: this.deps.cwd });
    if (!tool) return;
    // 子代理再派出的子代理（孙代理）：卡片挂在当前子代理的时间线里
    const registered =
      tool.detail.type === "sub_agent" ? this.register(tool, item, callId, threadId) : [];
    const emitted = this.calls.get(tool.callId)?.toolCall ?? tool;
    this.deps.emitSubagent({ type: "timeline", id: threadId, item: emitted });
    this.upsertChildItem(callId, emitted.callId, emitted);
    this.emitActivityUpdate(callId, phase === "started" ? "running" : undefined);
    this.replayPending(registered);
  }

  /** 登记 sub_agent 卡片的子线程（receiverThreadIds 与 agentThreadId；先登记者为准），返回本次登记的线程 */
  private register(
    tool: ToolCallTimelineItem,
    rawItem: JsonRecord,
    parentCallId: string | null,
    parentSubagentId: string | null,
  ): string[] {
    if (tool.detail.type !== "sub_agent") return [];
    const existing = this.calls.get(tool.callId);
    const state: SubAgentCallState = existing ?? {
      callId: tool.callId,
      toolCall: tool,
      parentCallId,
      parentSubagentId,
      activityItemIds: new Set(),
      childItemOrder: [],
      childItems: new Map(),
      childThreadIds: new Set(),
    };
    const previous = state.toolCall;
    const previousLog = previous.detail.type === "sub_agent" ? previous.detail.log : "";
    // 子线程已报告终态时，父线程迟到的 running 卡片不回退状态
    const keepStatus = existing !== undefined && isTerminal(previous.status) && tool.status === "running";
    state.toolCall = {
      ...tool,
      status: keepStatus ? previous.status : tool.status,
      error: keepStatus ? previous.error : tool.error,
      detail: { ...tool.detail, log: tool.detail.log || previousLog },
    };
    state.parentCallId ??= parentCallId;
    state.parentSubagentId ??= parentSubagentId;
    const activity = readSubAgentActivity(rawItem);
    if (activity?.id) state.activityItemIds.add(activity.id);
    this.calls.set(tool.callId, state);

    const receiverThreadIds = Array.isArray(rawItem.receiverThreadIds)
      ? rawItem.receiverThreadIds.filter((value): value is string => typeof value === "string")
      : [];
    const agentThreadId = str(rawItem.agentThreadId);
    const childThreadIds = [...new Set(agentThreadId ? [...receiverThreadIds, agentThreadId] : receiverThreadIds)];
    const registered: string[] = [];
    const rootThreadId = this.deps.rootThreadId();
    for (const threadId of childThreadIds) {
      if (threadId === rootThreadId) continue;
      const owner = this.callIdByThreadId.get(threadId);
      if (owner && owner !== tool.callId) continue;
      this.callIdByThreadId.set(threadId, tool.callId);
      state.childThreadIds.add(threadId);
      registered.push(threadId);
      this.emitUpsert(threadId, state, state.toolCall.status);
    }
    return registered;
  }

  /** 已登记子线程的 subAgentActivity：更新对应卡片的类型与状态 */
  private handleRegisteredActivity(rawItem: JsonRecord): boolean {
    const activity = readSubAgentActivity(rawItem);
    if (!activity) return false;
    const callId = this.callIdByThreadId.get(activity.agentThreadId);
    const state = callId ? this.calls.get(callId) : undefined;
    if (!callId || !state) return false;
    if (activity.id && state.activityItemIds.has(activity.id)) return true;
    if (activity.id) state.activityItemIds.add(activity.id);
    const activityTool = mapCodexToolCallFromThreadItem(rawItem, { cwd: this.deps.cwd });
    if (activityTool?.detail.type === "sub_agent" && state.toolCall.detail.type === "sub_agent") {
      state.toolCall = {
        ...state.toolCall,
        detail: {
          ...state.toolCall.detail,
          ...(activityTool.detail.subAgentType ? { subAgentType: activityTool.detail.subAgentType } : {}),
        },
      };
    }
    let nextStatus: ToolCallTimelineItem["status"] | undefined = "running";
    if (activity.kind === "interrupted") nextStatus = "canceled";
    else if (activity.kind === "completed") nextStatus = "completed";
    else if (isTerminal(state.toolCall.status)) nextStatus = undefined;
    this.emitActivityUpdate(callId, nextStatus);
    return true;
  }

  private replayPending(threadIds: readonly string[]): void {
    for (const threadId of threadIds) {
      const queue = this.pending.get(threadId);
      if (!queue) continue;
      this.pending.delete(threadId);
      const callId = this.callIdByThreadId.get(threadId);
      if (!callId) continue;
      for (const notification of queue) {
        this.dispatch(notification.method, notification.params, threadId, callId);
      }
    }
  }

  private upsertChildItem(callId: string, itemId: string, item: AgentTimelineItem): void {
    const state = this.calls.get(callId);
    if (!state) return;
    if (!state.childItems.has(itemId)) state.childItemOrder.push(itemId);
    state.childItems.set(itemId, item);
  }

  /**
   * 按子线程条目重算父卡片 log 并重推；嵌套卡片冒泡到上级子代理。
   * status 为 running 时不会覆盖终态，除非 reopen（子线程重新开始回合）。
   */
  private emitActivityUpdate(
    callId: string,
    status?: ToolCallTimelineItem["status"],
    options?: { reopen?: boolean },
  ): void {
    const state = this.calls.get(callId);
    if (!state || state.toolCall.detail.type !== "sub_agent") return;
    const childTimeline = state.childItemOrder
      .map((itemId) => state.childItems.get(itemId))
      .filter((item): item is AgentTimelineItem => Boolean(item));
    const log = childTimeline.length > 0 ? curateAgentActivity(childTimeline, { labelAssistantMessages: true }) : "";
    let resolved = status ?? state.toolCall.status;
    if (status === "running" && !options?.reopen && isTerminal(state.toolCall.status)) {
      resolved = state.toolCall.status;
    }
    for (const threadId of state.childThreadIds) {
      this.emitUpsert(threadId, state, resolved);
    }
    const next: ToolCallTimelineItem = {
      ...state.toolCall,
      status: resolved,
      error: resolved === "failed" ? (state.toolCall.error ?? "子 Agent 失败") : null,
      detail: { ...state.toolCall.detail, log },
    };
    state.toolCall = next;
    if (state.parentCallId && state.parentCallId !== callId) {
      this.upsertChildItem(state.parentCallId, state.callId, next);
      this.emitActivityUpdate(state.parentCallId);
      return;
    }
    this.deps.emitParentCard(next);
  }

  private emitUpsert(
    threadId: string,
    state: SubAgentCallState,
    status: ToolCallTimelineItem["status"],
  ): void {
    const detail = state.toolCall.detail;
    if (detail.type !== "sub_agent") return;
    const providerStatus: ProviderSubagentStatus = status;
    this.deps.emitSubagent({
      type: "upsert",
      id: threadId,
      title: detail.subAgentType ?? "Codex 子代理",
      description: detail.description ?? null,
      status: providerStatus,
      toolCallId: state.callId,
      parentSubagentId: state.parentSubagentId,
      cwd: this.deps.cwd,
    });
  }
}
