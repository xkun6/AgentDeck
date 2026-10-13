// 输入框上方状态行的展示纯函数（design.md 4.29 / 4.30）：步骤计数、额度芯片文案与颜色、重置时间、输出速度。
import type { AgentRateLimits, AgentRateLimitWindow, AgentUsage } from "@agentdeck/protocol";

// ---------------------------------------------------------------------------
// 步骤（todo）
// ---------------------------------------------------------------------------

export interface TodoStep {
  text: string;
  completed: boolean;
}

export type TodoStepStatus = "completed" | "in_progress" | "pending";

export interface TodoProgress {
  done: number;
  total: number;
  allDone: boolean;
  /** 回合进行中且有未完成项时，第一条未完成项的下标；否则 -1 */
  currentIndex: number;
}

export function todoProgress(items: readonly TodoStep[], busy: boolean): TodoProgress {
  const done = items.filter((item) => item.completed).length;
  const firstPending = items.findIndex((item) => !item.completed);
  return {
    done,
    total: items.length,
    allDone: items.length > 0 && done === items.length,
    currentIndex: busy ? firstPending : -1,
  };
}

export function todoStepStatus(item: TodoStep, index: number, progress: TodoProgress): TodoStepStatus {
  if (item.completed) return "completed";
  return index === progress.currentIndex ? "in_progress" : "pending";
}

/** 「2/5」；全部完成「5/5 ✓」 */
export function todoChipLabel(progress: TodoProgress): string {
  const base = `${progress.done}/${progress.total}`;
  return progress.allDone ? `${base} ✓` : base;
}

// ---------------------------------------------------------------------------
// 额度
// ---------------------------------------------------------------------------

/** 窗口使用率达到该值用警告色 */
export const RATE_LIMIT_WARN_PERCENT = 80;

export function rateLimitWindowShortLabel(window: AgentRateLimitWindow): string {
  if (window.id === "five_hour") return "5h";
  if (window.id === "seven_day") return "7d";
  if (window.label === "5 小时") return "5h";
  if (window.label === "7 天" || window.label === "每周") return "7d";
  return window.label;
}

export function formatPercent(usedPercent: number): string {
  return `${Math.round(usedPercent)}%`;
}

/** 「5h 3% · 7d 96%」 */
export function rateLimitChipLabel(limits: AgentRateLimits): string {
  return limits.windows
    .map((window) => `${rateLimitWindowShortLabel(window)} ${formatPercent(window.usedPercent)}`)
    .join(" · ");
}

export type RateLimitTone = "normal" | "warn" | "err";

export function rateLimitTone(limits: AgentRateLimits): RateLimitTone {
  if (limits.status === "rejected") return "err";
  return limits.windows.some((window) => window.usedPercent >= RATE_LIMIT_WARN_PERCENT) ? "warn" : "normal";
}

export function rateLimitWindowTone(window: AgentRateLimitWindow): "normal" | "warn" {
  return window.usedPercent >= RATE_LIMIT_WARN_PERCENT ? "warn" : "normal";
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/** 本地时间 HH:mm */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 「HH:mm 重置」；不在今天则「M月D日 HH:mm 重置」 */
export function formatResetTime(resetsAt: number, now: number): string {
  const reset = new Date(resetsAt);
  const today = new Date(now);
  const sameDay =
    reset.getFullYear() === today.getFullYear() &&
    reset.getMonth() === today.getMonth() &&
    reset.getDate() === today.getDate();
  const clock = formatClock(resetsAt);
  return sameDay ? `${clock} 重置` : `${reset.getMonth() + 1}月${reset.getDate()}日 ${clock} 重置`;
}

// ---------------------------------------------------------------------------
// 输出速度
// ---------------------------------------------------------------------------

/** 保留 1 位小数，≥ 100 取整 */
export function formatTokensPerSecond(value: number): string {
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} tok/s`;
}

export interface SpeedChipState {
  text: string;
  /** 空闲：显示的是上一回合的最终值，文字弱化 */
  idle: boolean;
  title: string;
}

/** 没有值（缺失 / 非有限 / ≤ 0）时返回 null，芯片隐藏 */
export function speedChipState(usage: AgentUsage | undefined, busy: boolean): SpeedChipState | null {
  const value = usage?.outputTokensPerSecond;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return {
    text: formatTokensPerSecond(value),
    idle: !busy,
    title: busy ? "当前输出速度" : "上一回合平均输出速度",
  };
}
