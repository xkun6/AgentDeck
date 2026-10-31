// 手机端的视觉小件：会话状态图标、环形进度、列表骨架屏、空状态、下拉刷新。
import { useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  Moon,
  Network,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import type { DispatchStatus, DispatchSummary } from "@/lib/dispatch";
import s from "./mobile.module.css";

export type StatusKind = DispatchStatus | "idle" | "dormant";

const STATUS_ICONS: Record<Exclude<StatusKind, "running" | "idle">, LucideIcon> = {
  approval: ShieldAlert,
  waiting: Network,
  failed: CircleAlert,
  canceled: CircleSlash,
  done: CircleCheck,
  ended: CircleCheck,
  notStarted: CircleDashed,
  dormant: Moon,
};

/** 行首状态图标：运行中是转动的圆环，空闲是小圆点（空心圆会被看成单选框），其余是状态图标；颜色只留给需要注意的状态 */
export function StatusTile({ kind }: { kind: StatusKind }) {
  const Icon = kind === "running" || kind === "idle" ? null : STATUS_ICONS[kind];
  return (
    <span className={s.tile} data-kind={kind} aria-hidden="true">
      {Icon ? <Icon /> : kind === "idle" ? <span className={s.dot} /> : <span className={s.tileSpinner} />}
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
  const stroke = size >= 40 ? 3 : 2;
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

/** 列表加载中的骨架：与会话行同形，内容到达时不跳动 */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <li className={s.skeleton} role="status" aria-label="加载中…">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={s.skeletonRow} aria-hidden="true">
          <span className={s.skeletonDot} />
          <span className={s.skeletonLines}>
            <span className={s.skeletonLine} style={{ width: `${72 - (index % 3) * 14}%` }} />
            <span className={s.skeletonLine} data-short="true" />
          </span>
        </div>
      ))}
    </li>
  );
}

/** 空状态：说明这里会有什么、怎么让它有内容 */
export function EmptyState({
  icon: Icon,
  title,
  children,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={s.hero}>
      <span className={s.heroIcon} aria-hidden="true">
        <Icon />
      </span>
      <div className={s.heroTitle}>{title}</div>
      <div className={s.heroText}>{children}</div>
      {actions ? <div className={s.heroActions}>{actions}</div> : null}
    </div>
  );
}

const PULL_TRIGGER_PX = 72;
const PULL_MAX_PX = 104;

/** 下拉刷新：手指跟随的圆形指示器，过阈值松手触发；返回要展开到滚动容器上的事件与指示器元素 */
export function usePullToRefresh(onRefresh: () => void, refreshing: boolean) {
  const [pull, setPull] = useState(0);
  const startY = useRef<number | null>(null);
  const handlers = {
    onTouchStart: (event: React.TouchEvent<HTMLElement>) => {
      startY.current = event.currentTarget.scrollTop <= 0 ? event.touches[0]!.clientY : null;
    },
    onTouchMove: (event: React.TouchEvent<HTMLElement>) => {
      if (startY.current === null) return;
      const dy = event.touches[0]!.clientY - startY.current;
      setPull(dy > 0 ? Math.min(dy * 0.6, PULL_MAX_PX) : 0);
    },
    onTouchEnd: () => {
      if (pull >= PULL_TRIGGER_PX) onRefresh();
      startY.current = null;
      setPull(0);
    },
  };
  const visible = pull > 0 || refreshing;
  const indicator = visible ? (
    <div
      className={s.pullIndicator}
      data-settling={pull === 0 ? "true" : undefined}
      style={pull > 0 ? { transform: `translate(-50%, ${pull - 44}px)`, opacity: Math.min(pull / PULL_TRIGGER_PX, 1) } : undefined}
      role={refreshing ? "status" : undefined}
      aria-label={refreshing ? "刷新中…" : undefined}
    >
      {refreshing ? (
        <span className={s.tileSpinner} data-tone="accent" />
      ) : (
        <ArrowDown
          aria-hidden="true"
          style={{ transform: pull >= PULL_TRIGGER_PX ? "rotate(180deg)" : undefined }}
        />
      )}
    </div>
  ) : null;
  return { handlers, indicator };
}
