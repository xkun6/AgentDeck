// Derived from paseo packages/server/src/server/agent/activity-curator.ts (Apache-2.0); modified for AgentDeck
// 改动：只保留 curateAgentActivity（子代理父卡片 log 用）；输入已按条目累积（不再做时间线投影），
// 去掉外部工具输入 JSON、compaction 与 fork 上下文。
import type { AgentTimelineItem, ToolCallTimelineItem } from "@agentdeck/protocol";

import { buildToolCallDisplayModel } from "./tool-call-display.js";

const MAX_TOOL_SUMMARY_CHARS = 200;

export interface ActivityCuratorOptions {
  /** assistant 文本前加 `[Assistant]` */
  labelAssistantMessages?: boolean;
}

function appendText(buffer: string, text: string): string {
  const normalized = text.trim();
  if (!normalized) {
    return buffer;
  }
  return buffer ? `${buffer}\n${normalized}` : normalized;
}

function formatToolSummary(summary: string | undefined): string | null {
  if (typeof summary !== "string") {
    return null;
  }
  const normalized = summary.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= MAX_TOOL_SUMMARY_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_TOOL_SUMMARY_CHARS - 3)}...`;
}

function formatToolCallEntry(item: ToolCallTimelineItem): string {
  const display = buildToolCallDisplayModel(item);
  const summary = formatToolSummary(display.summary);
  return summary ? `[${display.displayName}] ${summary}` : `[${display.displayName}]`;
}

/** 把子代理时间线条目整理成简短的活动文本（每行一个条目）；没有条目时返回空串 */
export function curateAgentActivity(
  timeline: readonly AgentTimelineItem[],
  options?: ActivityCuratorOptions,
): string {
  const entries: string[] = [];
  const buffers = { message: "", thought: "" };
  const flush = () => {
    if (buffers.message.trim()) {
      const text = buffers.message.trim();
      entries.push(options?.labelAssistantMessages ? `[Assistant] ${text}` : text);
    }
    if (buffers.thought.trim()) {
      entries.push(`[Thought] ${buffers.thought.trim()}`);
    }
    buffers.message = "";
    buffers.thought = "";
  };

  for (const item of timeline) {
    switch (item.type) {
      case "user_message":
        flush();
        entries.push(`[User] ${item.text.trim()}`);
        break;
      case "assistant_message":
        buffers.message = appendText(buffers.message, item.text);
        break;
      case "reasoning":
        buffers.thought = appendText(buffers.thought, item.text);
        break;
      case "tool_call":
        flush();
        entries.push(formatToolCallEntry(item));
        if (item.detail.type === "sub_agent" && item.detail.log.trim()) {
          entries.push(item.detail.log.trim());
        }
        break;
      case "todo":
        flush();
        entries.push("[Tasks]");
        for (const entry of item.items) {
          entries.push(`- ${entry.completed ? "[x]" : "[ ]"} ${entry.text}`);
        }
        break;
      case "error":
        flush();
        entries.push(`[Error] ${item.message}`);
        break;
    }
  }
  flush();
  return entries.join("\n");
}
