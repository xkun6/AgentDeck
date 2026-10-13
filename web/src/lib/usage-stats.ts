// 用量统计页（design.md 4.20）的纯函数：时间范围、按天补零、占比、tokens 合计。
import type { UsageSummary } from "@agentdeck/protocol";

export type UsageRangeId = "7d" | "30d" | "90d" | "all";

export const USAGE_RANGES: ReadonlyArray<{ id: UsageRangeId; label: string; days: number | null }> = [
  { id: "7d", label: "7 天", days: 7 },
  { id: "30d", label: "30 天", days: 30 },
  { id: "90d", label: "90 天", days: 90 },
  { id: "all", label: "全部", days: null },
];

/** usage.summary 的 sinceMs：最近 N 天从 N-1 天前的本地零点算起（含今天）；全部 = 0 */
export function usageSinceMs(range: UsageRangeId, now: number): number {
  const days = USAGE_RANGES.find((item) => item.id === range)?.days;
  if (!days) return 0;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start.getTime();
}

export function localDayKey(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export type UsageDay = UsageSummary["byDay"][number];

/**
 * 柱状图的日期轴：从起始日到今天逐日补零。有限范围从 sinceMs 起；
 * 「全部」（sinceMs 为 0）从第一条有数据的日期起，没有数据返回空数组。
 */
export function fillDays(byDay: readonly UsageDay[], sinceMs: number, now: number): UsageDay[] {
  const byKey = new Map(byDay.map((day) => [day.day, day]));
  let cursor: Date;
  if (sinceMs > 0) {
    cursor = new Date(sinceMs);
  } else if (byDay.length > 0) {
    const [year, month, date] = byDay[0]!.day.split("-").map(Number);
    cursor = new Date(year!, month! - 1, date!);
  } else {
    return [];
  }
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  const days: UsageDay[] = [];
  while (cursor.getTime() <= end.getTime()) {
    const key = localDayKey(cursor.getTime());
    days.push(
      byKey.get(key) ?? { day: key, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, turns: 0 },
    );
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

export function dayTotalTokens(day: Pick<UsageDay, "inputTokens" | "cachedInputTokens" | "outputTokens">): number {
  return day.inputTokens + day.cachedInputTokens + day.outputTokens;
}

/** 各项 输入+输出 tokens 占总和的百分比（0–100，保留一位小数）；总和为 0 时全部为 0 */
export function tokenShares<T extends { inputTokens: number; outputTokens: number }>(
  items: readonly T[],
): Array<T & { tokens: number; percent: number }> {
  const withTokens = items.map((item) => ({ ...item, tokens: item.inputTokens + item.outputTokens }));
  const total = withTokens.reduce((sum, item) => sum + item.tokens, 0);
  return withTokens.map((item) => ({
    ...item,
    percent: total > 0 ? Math.round((item.tokens / total) * 1000) / 10 : 0,
  }));
}

export function modelLabel(model: string | null): string {
  return model ?? "默认模型";
}

/** 搜索 snippet 按命中位置切成 前 / 命中 / 后 三段 */
export function splitSnippet(
  snippet: string,
  matchStart: number,
  matchLength: number,
): { before: string; match: string; after: string } {
  const start = Math.min(Math.max(0, matchStart), snippet.length);
  const end = Math.min(snippet.length, start + Math.max(0, matchLength));
  return { before: snippet.slice(0, start), match: snippet.slice(start, end), after: snippet.slice(end) };
}
