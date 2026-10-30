// 手机端的视觉小件：会话状态图标块、环形进度。
import {
  Check,
  CircleDashed,
  CircleSlash,
  MessageSquare,
  Moon,
  Network,
  ShieldAlert,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { DispatchStatus, DispatchSummary } from "@/lib/dispatch";
import s from "./mobile.module.css";

export type StatusKind = DispatchStatus | "idle" | "dormant";

const STATUS_ICONS: Record<Exclude<StatusKind, "running">, LucideIcon> = {
  approval: ShieldAlert,
  waiting: Network,
  failed: TriangleAlert,
  canceled: CircleSlash,
  done: Check,
  ended: Check,
  notStarted: CircleDashed,
  idle: MessageSquare,
  dormant: Moon,
};

/** 行首状态块：运行中是转动的圆环，其余是状态图标 */
export function StatusTile({ kind }: { kind: StatusKind }) {
  const Icon = kind === "running" ? null : STATUS_ICONS[kind];
  return (
    <span className={s.tile} data-kind={kind} aria-hidden="true">
      {Icon ? <Icon /> : <span className={s.tileSpinner} />}
    </span>
  );
}

/** 环形进度：已完成占比；有需要处理的子会话时标红，全部完成时为绿色 */
export function ProgressRing({
  summary,
  size = 16,
  label = false,
}: {
  summary: DispatchSummary;
  size?: number;
  /** 圆环中间显示 x/y */
  label?: boolean;
}) {
  const stroke = size >= 40 ? 4 : 2;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = summary.total > 0 ? summary.done / summary.total : 0;
  const state = summary.attention > 0 ? "attention" : ratio === 1 ? "done" : "working";
  return (
    <span className={s.ring} data-state={state} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox={`0 0 ${size} ${size}`}>
        <circle className={s.ringTrack} cx={size / 2} cy={size / 2} r={radius} strokeWidth={stroke} />
        <circle
          className={s.ringFill}
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
        />
      </svg>
      {label ? (
        <span className={s.ringLabel}>
          {summary.done}/{summary.total}
        </span>
      ) : null}
    </span>
  );
}
