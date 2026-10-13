// Derived from paseo packages/server/src/server/agent/providers/claude/sidechain-tracker.ts (Apache-2.0); modified for AgentDeck
// 改动：
// - 消息类型换成 AgentDeck 的 stream-json-types；输出改为 { events, parentCard } 结构，由会话负责发出与合并父卡片；
// - 只处理子代理的完整 assistant / user 消息，不处理子代理的 stream_event 增量与 tool_progress；
// - 工具结果按主时间线同样的规则取文本输出候选；动作摘要用 shared/tool-call-display。
import type { AgentTimelineItem, ToolCallTimelineItem } from "@agentdeck/protocol";

import type { ProviderSubagentInputEvent } from "../../agent/types.js";
import { buildToolCallDisplayModel } from "../shared/tool-call-display.js";
import type { ClaudeContentBlock, ClaudeOutputMessage } from "./stream-json-types.js";
import {
  buildOutputCandidates,
  mapClaudeCompletedToolCall,
  mapClaudeFailedToolCall,
  mapClaudeRunningToolCall,
  toolResultText,
} from "./tool-call-mapper.js";

interface SubAgentActionEntry {
  index: number;
  toolName: string;
  input: unknown;
  summary?: string;
}

interface SubAgentActivityState {
  name?: string;
  subAgentType?: string;
  description?: string;
  actions: SubAgentActionEntry[];
  actionKeys: string[];
  nextActionIndex: number;
  actionIndexByKey: Map<string, number>;
  completedActionKeys: Set<string>;
}

interface SubAgentActionCandidate {
  key: string;
  toolName: string;
  input: unknown;
}

export interface SidechainOutput {
  /** 写入子代理 store 的事件（timeline，以及 task 协议缺席时的描述 upsert） */
  events: ProviderSubagentInputEvent[];
  /** 父时间线中该子代理的卡片（sub_agent detail，含累积的 log）；不需要时为 null */
  parentCard: ToolCallTimelineItem | null;
}

export const MAX_SUB_AGENT_LOG_ENTRIES = 200;
export const MAX_SUB_AGENT_SUMMARY_CHARS = 160;
const DEFAULT_SUBAGENT_TITLE = "Claude 子代理";

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isToolUseBlock(block: ClaudeContentBlock | null | undefined): block is ClaudeContentBlock {
  return (
    !!block &&
    (block.type === "tool_use" || block.type === "mcp_tool_use" || block.type === "server_tool_use") &&
    typeof block.name === "string"
  );
}

export class ClaudeSidechainTracker {
  private readonly activeSidechains = new Map<string, SubAgentActivityState>();
  private readonly getToolInput: (toolUseId: string) => Record<string, unknown> | null | undefined;
  private readonly isDescriptorOwnedElsewhere: () => boolean;
  private readonly needsSyntheticParentToolCard: (toolUseId: string) => boolean;

  constructor(input: {
    getToolInput: (toolUseId: string) => Record<string, unknown> | null | undefined;
    /**
     * provider 已经以声明方式（task 协议）得知子代理身份与状态时，tracker 不再发描述 upsert，
     * 只把帧映射成时间线条目。两个来源写同一个描述会互相打架。
     */
    isDescriptorOwnedElsewhere?: () => boolean;
    needsSyntheticParentToolCard?: (toolUseId: string) => boolean;
  }) {
    this.getToolInput = input.getToolInput;
    this.isDescriptorOwnedElsewhere = input.isDescriptorOwnedElsewhere ?? (() => false);
    this.needsSyntheticParentToolCard = input.needsSyntheticParentToolCard ?? (() => true);
  }

  handleMessage(message: ClaudeOutputMessage, parentToolUseId: string): SidechainOutput {
    const state =
      this.activeSidechains.get(parentToolUseId) ??
      ({
        actions: [],
        actionKeys: [],
        nextActionIndex: 1,
        actionIndexByKey: new Map<string, number>(),
        completedActionKeys: new Set<string>(),
      } satisfies SubAgentActivityState);
    this.activeSidechains.set(parentToolUseId, state);

    const contextUpdated = this.updateSubAgentContextFromTaskInput(state, parentToolUseId);
    const actionCandidates = this.extractSubAgentActionCandidates(message);
    const childTimelineItems: AgentTimelineItem[] = [
      ...this.extractSubAgentTimelineItems(message),
      ...this.extractSubAgentToolResults(message, state),
    ];
    let actionUpdated = false;
    for (const action of actionCandidates) {
      if (state.completedActionKeys.has(action.key)) continue;
      if (this.appendSubAgentAction(state, action)) {
        actionUpdated = true;
        const toolCall = mapClaudeRunningToolCall({
          name: action.toolName,
          callId: action.key,
          input: action.input,
        });
        if (toolCall) {
          childTimelineItems.push(toolCall);
        }
      }
    }

    if (!contextUpdated && !actionUpdated && childTimelineItems.length === 0) {
      return { events: [], parentCard: null };
    }

    const descriptorEvents: ProviderSubagentInputEvent[] = this.isDescriptorOwnedElsewhere()
      ? []
      : [this.buildUpsert(parentToolUseId, state, "running")];

    return {
      events: [
        ...descriptorEvents,
        ...childTimelineItems.map(
          (item): ProviderSubagentInputEvent => ({ type: "timeline", id: parentToolUseId, item }),
        ),
      ],
      parentCard: this.needsSyntheticParentToolCard(parentToolUseId)
        ? this.buildParentCard(parentToolUseId, state)
        : null,
    };
  }

  /** 父消息出现该 Task 的 tool_result：结束 sidechain（task 协议缺席时补发终态 upsert） */
  finish(id: string, status: "completed" | "failed" | "canceled"): ProviderSubagentInputEvent[] {
    const state = this.activeSidechains.get(id);
    if (!state) return [];
    this.activeSidechains.delete(id);
    if (this.isDescriptorOwnedElsewhere()) return [];
    return [this.buildUpsert(id, state, status)];
  }

  finishAll(status: "completed" | "failed" | "canceled"): ProviderSubagentInputEvent[] {
    const events: ProviderSubagentInputEvent[] = [];
    if (!this.isDescriptorOwnedElsewhere()) {
      for (const [id, state] of this.activeSidechains) {
        events.push(this.buildUpsert(id, state, status));
      }
    }
    this.activeSidechains.clear();
    return events;
  }

  clear(): void {
    this.activeSidechains.clear();
  }

  private buildUpsert(
    id: string,
    state: SubAgentActivityState,
    status: "running" | "completed" | "failed" | "canceled",
  ): ProviderSubagentInputEvent {
    return {
      type: "upsert",
      id,
      title: state.name ?? state.subAgentType ?? DEFAULT_SUBAGENT_TITLE,
      description: state.description ?? null,
      status,
      toolCallId: id,
    };
  }

  private buildParentCard(id: string, state: SubAgentActivityState): ToolCallTimelineItem {
    return {
      type: "tool_call",
      callId: id,
      name: "Task",
      status: "running",
      error: null,
      detail: {
        type: "sub_agent",
        ...(state.subAgentType ? { subAgentType: state.subAgentType } : {}),
        ...(state.description ? { description: state.description } : {}),
        log: state.actions
          .map((action) =>
            action.summary ? `[${action.toolName}] ${action.summary}` : `[${action.toolName}]`,
          )
          .join("\n"),
        actions: [],
      },
    };
  }

  /** 子代理完整 assistant 消息：text → assistant_message，thinking → reasoning（空的跳过） */
  private extractSubAgentTimelineItems(message: ClaudeOutputMessage): AgentTimelineItem[] {
    if (message.type !== "assistant" || !Array.isArray(message.message?.content)) {
      return [];
    }
    const messageId = readTrimmedString(message.message.id);
    const items: AgentTimelineItem[] = [];
    for (const block of message.message.content) {
      if (!block || typeof block.type !== "string") continue;
      if (block.type === "text") {
        const text = readTrimmedString(block.text);
        if (text) {
          items.push({ type: "assistant_message", text, ...(messageId ? { messageId } : {}) });
        }
      } else if (block.type === "thinking") {
        const text = readTrimmedString(block.thinking);
        if (text) items.push({ type: "reasoning", text });
      }
    }
    return items;
  }

  /** 子代理 user 消息里的 tool_result → completed / failed tool_call */
  private extractSubAgentToolResults(
    message: ClaudeOutputMessage,
    state: SubAgentActivityState,
  ): AgentTimelineItem[] {
    if (message.type !== "user" && message.type !== "assistant") return [];
    const content = message.message?.content;
    if (!Array.isArray(content)) return [];

    const items: AgentTimelineItem[] = [];
    for (const raw of content) {
      const block = raw as ClaudeContentBlock | null;
      if (!block || typeof block.type !== "string" || !block.type.endsWith("tool_result")) continue;
      const callId = readTrimmedString(block.tool_use_id);
      if (!callId || state.completedActionKeys.has(callId)) continue;
      const actionIndex = state.actionIndexByKey.get(callId);
      const action = actionIndex === undefined ? undefined : state.actions[actionIndex];
      const toolName = action?.toolName ?? readTrimmedString(block.tool_name);
      if (!toolName) continue;
      const input = action?.input ?? null;
      const text = toolResultText(block.content);
      const toolCall =
        block.is_error === true
          ? mapClaudeFailedToolCall({
              name: toolName,
              callId,
              input,
              output: null,
              error: text || "工具调用失败",
            })
          : mapClaudeCompletedToolCall({
              name: toolName,
              callId,
              input,
              outputCandidates: buildOutputCandidates(toolName, text, undefined),
            });
      if (toolCall) {
        state.completedActionKeys.add(callId);
        items.push(toolCall);
      }
    }
    return items;
  }

  private updateSubAgentContextFromTaskInput(
    state: SubAgentActivityState,
    parentToolUseId: string,
  ): boolean {
    const taskInput = this.getToolInput(parentToolUseId);
    const nextName = this.normalizeSubAgentText(taskInput?.name);
    const nextSubAgentType = this.normalizeSubAgentText(taskInput?.subagent_type);
    const nextDescription = this.normalizeSubAgentText(taskInput?.description);

    let changed = false;
    if (nextName && nextName !== state.name) {
      state.name = nextName;
      changed = true;
    }
    if (nextSubAgentType && nextSubAgentType !== state.subAgentType) {
      state.subAgentType = nextSubAgentType;
      changed = true;
    }
    if (nextDescription && nextDescription !== state.description) {
      state.description = nextDescription;
      changed = true;
    }
    return changed;
  }

  private normalizeSubAgentText(value: unknown): string | undefined {
    const normalized = readTrimmedString(value)?.replace(/\s+/g, " ");
    if (!normalized) {
      return undefined;
    }
    if (normalized.length <= MAX_SUB_AGENT_SUMMARY_CHARS) {
      return normalized;
    }
    return `${normalized.slice(0, MAX_SUB_AGENT_SUMMARY_CHARS)}...`;
  }

  private extractSubAgentActionCandidates(message: ClaudeOutputMessage): SubAgentActionCandidate[] {
    if (message.type !== "assistant") {
      return [];
    }
    const content = message.message?.content;
    if (!Array.isArray(content)) {
      return [];
    }
    const actions: SubAgentActionCandidate[] = [];
    for (const block of content) {
      if (!isToolUseBlock(block)) continue;
      const name = block.name as string;
      const key = readTrimmedString(block.id) ?? `assistant:${name}:${actions.length}`;
      actions.push({ key, toolName: name, input: block.input ?? null });
    }
    return actions;
  }

  private appendSubAgentAction(
    state: SubAgentActivityState,
    candidate: SubAgentActionCandidate,
  ): boolean {
    const normalizedToolName = readTrimmedString(candidate.toolName);
    if (!normalizedToolName) {
      return false;
    }

    const summary = this.deriveSubAgentActionSummary(normalizedToolName, candidate.input);
    const existingIndex = state.actionIndexByKey.get(candidate.key);

    if (existingIndex !== undefined) {
      const existing = state.actions[existingIndex];
      if (!existing) {
        return false;
      }
      const nextSummary = existing.summary ?? summary;
      if (existing.toolName === normalizedToolName && existing.summary === nextSummary) {
        return false;
      }
      state.actions[existingIndex] = {
        ...existing,
        toolName: normalizedToolName,
        input: existing.input ?? candidate.input,
        ...(nextSummary ? { summary: nextSummary } : {}),
      };
      return true;
    }

    state.actions.push({
      index: state.nextActionIndex,
      toolName: normalizedToolName,
      input: candidate.input,
      ...(summary ? { summary } : {}),
    });
    state.nextActionIndex += 1;
    state.actionKeys.push(candidate.key);
    this.trimSubAgentTail(state);
    this.rebuildSubAgentActionIndex(state);
    return true;
  }

  private trimSubAgentTail(state: SubAgentActivityState): void {
    while (state.actions.length > MAX_SUB_AGENT_LOG_ENTRIES) {
      state.actions.shift();
      const removedKey = state.actionKeys.shift();
      if (removedKey) state.completedActionKeys.delete(removedKey);
    }
  }

  private rebuildSubAgentActionIndex(state: SubAgentActivityState): void {
    state.actionIndexByKey.clear();
    for (let index = 0; index < state.actionKeys.length; index += 1) {
      const key = state.actionKeys[index];
      if (key) {
        state.actionIndexByKey.set(key, index);
      }
    }
  }

  private deriveSubAgentActionSummary(toolName: string, input: unknown): string | undefined {
    const runningToolCall = mapClaudeRunningToolCall({
      name: toolName,
      callId: `sub-agent-summary-${toolName}`,
      input,
    });
    if (!runningToolCall) {
      return undefined;
    }
    return this.normalizeSubAgentText(buildToolCallDisplayModel(runningToolCall).summary);
  }
}
