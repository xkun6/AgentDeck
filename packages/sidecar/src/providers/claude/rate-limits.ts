// Claude stream-json `rate_limit_event` → AgentRateLimits（design.md 4.30）。AgentDeck 原创。
import type { AgentRateLimitWindow, AgentRateLimits } from "@agentdeck/protocol";
import type { ClaudeRateLimitEventMessage } from "./stream-json-types.js";

const WINDOW_LABELS: Record<string, string> = {
  five_hour: "5 小时",
  seven_day: "7 天",
};

function toPercent(utilization: unknown): number | null {
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) {
    return null;
  }
  // 乘 100 后去掉浮点噪声（0.07 * 100 = 7.000000000000001），保留两位小数
  return Math.min(100, Math.max(0, Math.round(utilization * 10000) / 100));
}

function toMillis(resetsAtSeconds: unknown): number | undefined {
  return typeof resetsAtSeconds === "number" && Number.isFinite(resetsAtSeconds) && resetsAtSeconds > 0
    ? Math.round(resetsAtSeconds * 1000)
    : undefined;
}

function toWindow(id: string, utilization: unknown, resetsAt: unknown): AgentRateLimitWindow | null {
  const usedPercent = toPercent(utilization);
  if (usedPercent === null) {
    return null;
  }
  const resets = toMillis(resetsAt);
  return {
    id,
    label: WINDOW_LABELS[id] ?? id,
    usedPercent,
    ...(resets !== undefined ? { resetsAt: resets } : {}),
  };
}

function toStatus(status: unknown): AgentRateLimits["status"] {
  switch (status) {
    case "allowed":
      return "allowed";
    case "allowed_warning":
      return "warning";
    case "rejected":
      return "rejected";
    default:
      return undefined;
  }
}

/** 没有任何可用窗口时返回 null（事件被忽略） */
export function mapClaudeRateLimitEvent(
  message: ClaudeRateLimitEventMessage,
  now: number,
): AgentRateLimits | null {
  const info = message.rate_limit_info;
  if (!info || typeof info !== "object") {
    return null;
  }
  const windows: AgentRateLimitWindow[] = [];
  const unified = info.unifiedWindows;
  if (unified && typeof unified === "object") {
    for (const [id, entry] of Object.entries(unified)) {
      const window = entry ? toWindow(id, entry.utilization, entry.resetsAt) : null;
      if (window) windows.push(window);
    }
  }
  if (windows.length === 0 && typeof info.rateLimitType === "string" && info.rateLimitType) {
    const window = toWindow(info.rateLimitType, info.utilization, info.resetsAt);
    if (window) windows.push(window);
  }
  if (windows.length === 0) {
    return null;
  }
  const status = toStatus(info.status);
  return { windows, ...(status ? { status } : {}), updatedAt: now };
}
