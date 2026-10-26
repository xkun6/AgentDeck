// 子代理展示的纯函数（design.md 4.11）。
// - parseSubAgentLog：移植自 paseo packages/app/src/components/tool-call-details.tsx 的 parseSubAgentLog；
// - 药丸文案与层级筛选：参照 paseo packages/app/src/subagents/track-presentation.ts 与 select.ts（改写为中文文案）。
import type { ProviderSubagentDescriptor, ProviderSubagentStatus } from "@agentdeck/protocol";

export interface SubAgentActionRow {
  index: number;
  toolName: string;
  summary?: string;
}

export interface ParsedSubAgentLog {
  actions: SubAgentActionRow[];
  /** 不是 `[工具] 摘要` 形式的其余行 */
  remainingLog: string;
}

const ACTION_LINE = /^\[([^\]]+)\](?:\s+(.*))?$/;

/** 解析 sub_agent detail 的 log：`[Tool] summary` 行为动作，其余行原样保留。 */
export function parseSubAgentLog(log: string): ParsedSubAgentLog {
  const actions: SubAgentActionRow[] = [];
  const remaining: string[] = [];
  for (const line of log.replace(/^\n+/, "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(ACTION_LINE);
    const toolName = match?.[1]?.trim();
    if (match && toolName) {
      const summary = match[2]?.trim();
      actions.push({ index: actions.length + 1, toolName, ...(summary ? { summary } : {}) });
    } else {
      remaining.push(line);
    }
  }
  return { actions, remainingLog: remaining.join("\n").replace(/^\n+/, "") };
}

/** 只取当前层级：parentSubagentId 与给定值相同（父会话视图为 null），按 createdAt 升序。 */
export function selectSubagentsAtLevel(
  subagents: readonly ProviderSubagentDescriptor[],
  parentSubagentId: string | null,
): ProviderSubagentDescriptor[] {
  return subagents
    .filter((subagent) => (subagent.parentSubagentId ?? null) === parentSubagentId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * 药丸文案：有运行中 / 失败时按「N 运行中，M 失败」只列非零项；
 * 全部结束（只剩完成 / 取消）时显示总数「N 个子代理」。
 */
export function subagentPillLabel(rows: readonly Pick<ProviderSubagentDescriptor, "status">[]): string {
  const running = rows.filter((row) => row.status === "running").length;
  const failed = rows.filter((row) => row.status === "failed").length;
  const segments: string[] = [];
  if (running > 0) segments.push(`${running} 运行中`);
  if (failed > 0) segments.push(`${failed} 失败`);
  return segments.length > 0 ? segments.join("，") : `${rows.length} 个子代理`;
}

/** 行标签：description 优先，其次 title，再次「子代理」。 */
export function subagentRowLabel(subagent: Pick<ProviderSubagentDescriptor, "title" | "description">): string {
  return subagent.description?.trim() || subagent.title?.trim() || "子代理";
}

export function subagentStatusText(status: ProviderSubagentStatus): string {
  switch (status) {
    case "running":
      return "运行中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "canceled":
      return "已取消";
  }
}

/** 状态点用的通用状态（与工具卡片的 data-status 对齐）。 */
export function subagentDotStatus(status: ProviderSubagentStatus): "running" | "done" | "error" | "canceled" {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "done";
    case "failed":
      return "error";
    case "canceled":
      return "canceled";
  }
}
