// Derived from paseo packages/protocol/src/tool-call-display.ts (Apache-2.0); modified for AgentDeck
// 改动：只保留 displayName / summary（子代理父卡片 log 用），去掉 cwd 前缀裁剪、paseo 工具名与 worktree_setup。
import type { ToolCallTimelineItem } from "@agentdeck/protocol";

export interface ToolCallDisplayModel {
  displayName: string;
  summary?: string;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function humanizeToolName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return name;
  }
  if (/[:./]/.test(trimmed) || trimmed.includes("__")) {
    return trimmed;
  }
  return trimmed
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter((segment) => segment.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/^./, (character) => character.toUpperCase());
}

function detailDisplay(
  detail: ToolCallTimelineItem["detail"],
): { displayName?: string; summary?: string } {
  switch (detail.type) {
    case "shell":
      return { displayName: "Shell", summary: detail.command };
    case "read":
      return { displayName: "Read", summary: detail.filePath };
    case "edit":
      return { displayName: "Edit", summary: detail.filePath };
    case "write":
      return { displayName: "Write", summary: detail.filePath };
    case "search":
      return { displayName: "Search", summary: detail.query };
    case "fetch":
      return { displayName: "Fetch", summary: detail.url };
    case "sub_agent":
      return {
        displayName: readString(detail.subAgentType) ?? "Task",
        summary: readString(detail.description),
      };
    case "plain_text":
      return { summary: detail.label };
    case "plan":
      return { displayName: "Plan" };
    case "unknown":
      return {};
  }
}

export function buildToolCallDisplayModel(
  item: Pick<ToolCallTimelineItem, "name" | "detail">,
): ToolCallDisplayModel {
  const display = detailDisplay(item.detail);
  const displayName = display.displayName ?? humanizeToolName(item.name);
  return { displayName, ...(display.summary ? { summary: display.summary } : {}) };
}
