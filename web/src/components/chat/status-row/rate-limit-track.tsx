// 输入框上方状态行的「额度」药丸（design.md 4.30）：各窗口简写与已用比例；点开看进度条、重置时间与更新时间。
// 额度不放进上下文窗口弹层。
import { useState } from "react";
import { ChevronDown, ChevronUp, Gauge } from "lucide-react";
import type { AgentRateLimits } from "@agentdeck/protocol";
import t from "../subagents/subagent-track.module.css";
import s from "./status-row.module.css";
import {
  formatClock,
  formatPercent,
  formatResetTime,
  rateLimitChipLabel,
  rateLimitTone,
  rateLimitWindowTone,
} from "./status-row-presentation";

export interface RateLimitTrackProps {
  rateLimits: AgentRateLimits | undefined;
  /** 仅测试注入：判断「是否在今天」的当前时间 */
  now?: number;
}

export function RateLimitTrack({ rateLimits, now }: RateLimitTrackProps) {
  const [open, setOpen] = useState(false);
  if (!rateLimits || rateLimits.windows.length === 0) return null;
  const tone = rateLimitTone(rateLimits);
  const rejected = rateLimits.status === "rejected";
  const current = now ?? Date.now();

  return (
    <div>
      <button
        type="button"
        className={`${t.pill} ${s.pill}`}
        data-tone={tone}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title="额度"
      >
        <Gauge size={12} aria-hidden="true" />
        {rejected ? (
          <span className={`${t.pillLabel} ${s.pillValue}`}>额度已用尽</span>
        ) : (
          <>
            <span className={t.pillTitle}>额度</span>
            <span className={`${t.pillLabel} ${s.pillValue}`}>{rateLimitChipLabel(rateLimits)}</span>
          </>
        )}
        {open ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
      </button>
      {open ? (
        <div className={s.panel} data-rejected={rejected ? "true" : undefined} aria-label="额度详情">
          {rateLimits.windows.map((window) => (
            <div key={window.id} className={s.limitRow} data-tone={rateLimitWindowTone(window)}>
              <span className={s.limitName}>{window.label}</span>
              <span className={s.bar} role="presentation">
                <span
                  className={s.barFill}
                  style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }}
                />
              </span>
              <span className={s.limitPercent}>已用 {formatPercent(window.usedPercent)}</span>
              <span className={s.limitReset}>
                {window.resetsAt !== undefined ? formatResetTime(window.resetsAt, current) : ""}
              </span>
            </div>
          ))}
          <div className={s.limitFoot}>更新于 {formatClock(rateLimits.updatedAt)}</div>
        </div>
      ) : null}
    </div>
  );
}
