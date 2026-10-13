// 输入框里的上下文窗口用量圆环（design.md 4.13）：>= 80% 警告色，>= 95% 危险色；
// 悬停 / 聚焦显示「已用百分比 · 已用 / 上限 tokens · 自动压缩说明」，可选「立即压缩上下文」按钮。
// 没有已用或上限时不渲染。
import { useId } from "react";
import type { AgentUsage } from "@agentdeck/protocol";
import { formatTokens } from "@/lib/format";
import s from "./context-usage-indicator.module.css";

export type ContextUsageLevel = "normal" | "warning" | "danger";

export interface ContextUsageSummary {
  used: number;
  max: number;
  /** 0–100 的整数 */
  percent: number;
  level: ContextUsageLevel;
}

export function summarizeContextUsage(usage: AgentUsage | undefined): ContextUsageSummary | null {
  const used = usage?.contextWindowUsedTokens;
  const max = usage?.contextWindowMaxTokens;
  if (typeof used !== "number" || typeof max !== "number" || !(used > 0) || !(max > 0)) return null;
  const percent = Math.min(100, Math.round((used / max) * 100));
  const level: ContextUsageLevel = percent >= 95 ? "danger" : percent >= 80 ? "warning" : "normal";
  return { used, max, percent, level };
}

const RADIUS = 8;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export interface ContextUsageIndicatorProps {
  usage: AgentUsage | undefined;
  /** 传入时弹层底部显示「立即压缩上下文」按钮 */
  onCompact?: () => void;
  compactDisabled?: boolean;
  /** 按钮禁用时的原因（title 显示） */
  compactDisabledReason?: string;
}

export function ContextUsageIndicator({
  usage,
  onCompact,
  compactDisabled = false,
  compactDisabledReason,
}: ContextUsageIndicatorProps) {
  const detailId = useId();
  const summary = summarizeContextUsage(usage);
  if (!summary) return null;
  const title = `上下文窗口：已用 ${summary.percent}%`;
  const detail = `${formatTokens(summary.used)} / ${formatTokens(summary.max)} tokens`;
  const hint = onCompact
    ? "接近上限时 Agent 会自动压缩，也可以手动压缩"
    : "接近上限时 Agent 会自动压缩上下文";
  const offset = CIRCUMFERENCE * (1 - summary.percent / 100);
  const compact = () => {
    onCompact?.();
    // 失焦以关闭弹层（:focus-within）
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  };
  return (
    <span className={s.root} data-level={summary.level}>
      <span
        className={s.ringButton}
        tabIndex={0}
        role="img"
        aria-label={`${title}，${detail}`}
        aria-describedby={detailId}
      >
        <svg className={s.ring} width={20} height={20} viewBox="0 0 20 20" aria-hidden="true">
          <circle className={s.track} cx="10" cy="10" r={RADIUS} />
          <circle
            className={s.value}
            cx="10"
            cy="10"
            r={RADIUS}
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={offset}
            transform="rotate(-90 10 10)"
          />
        </svg>
      </span>
      <span className={s.popover}>
        <span className={s.popoverText} id={detailId}>
          <span className={s.popoverTitle}>{title}</span>
          <span>{detail}</span>
          <span className={s.popoverHint}>{hint}</span>
        </span>
        {onCompact ? (
          <button
            type="button"
            className={s.compactButton}
            onClick={compact}
            disabled={compactDisabled}
            title={compactDisabled ? compactDisabledReason : undefined}
          >
            立即压缩上下文
          </button>
        ) : null}
      </span>
    </span>
  );
}
