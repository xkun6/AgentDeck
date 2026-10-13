// 输入框上方的「后台任务」药丸（design.md 4.15）：按会话列出 Claude 的后台 Shell 命令，
// 展开后每行是可选中的 button（点选在右侧面板查看命令与输出），运行中的行带「停止」小按钮。
// 样式与交互参照子代理药丸（subagent-track）。
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Terminal } from "lucide-react";
import type { AgentBackgroundTask } from "@agentdeck/protocol";
import { Button } from "@agentdeck/shared-ui";
import {
  backgroundTaskDotStatus,
  backgroundTaskPillLabel,
  backgroundTaskStatusText,
  formatElapsed,
  taskDisplayLabel,
  taskElapsedMs,
} from "./background-task-presentation";
import { useStopBackgroundTask } from "./use-stop-background-task";
import s from "./background-task-track.module.css";

export interface BackgroundTaskTrackProps {
  agentId: string;
  /** 该会话全部后台任务（已按登记顺序） */
  tasks: readonly AgentBackgroundTask[];
  /** 点选一行：在右侧面板打开该任务 */
  onOpen?: (taskId: string) => void;
  /** 当前在右侧面板中打开的任务（高亮） */
  activeTaskId?: string | null;
}

export function BackgroundTaskTrack({ agentId, tasks, onOpen, activeTaskId }: BackgroundTaskTrackProps) {
  const { stopping, errors: stopErrors, stop } = useStopBackgroundTask(agentId);
  const [open, setOpen] = useState(false);
  // 「清除已结束」只在前端隐藏
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());

  const visible = useMemo(
    () => tasks.filter((task) => task.status === "running" || !hiddenIds.has(task.taskId)),
    [hiddenIds, tasks],
  );
  const hasRunning = visible.some((task) => task.status === "running");
  const hasEnded = visible.some((task) => task.status !== "running");

  // 展开且有运行中任务时每秒刷新耗时
  useEffect(() => {
    if (!open || !hasRunning) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasRunning, open]);

  if (visible.length === 0) return null;
  const tone = hasRunning ? "running" : visible.some((task) => task.status === "failed") ? "error" : "done";

  const clearEnded = () => {
    setHiddenIds((current) => {
      const next = new Set(current);
      for (const task of tasks) if (task.status !== "running") next.add(task.taskId);
      return next;
    });
  };

  return (
    <div className={s.track}>
      <button
        type="button"
        className={s.pill}
        data-tone={tone}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title="后台任务"
      >
        <Terminal size={12} aria-hidden="true" />
        <span className={s.pillTitle}>后台任务</span>
        <span className={s.pillLabel}>{backgroundTaskPillLabel(visible)}</span>
        {open ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
      </button>
      {open ? (
        <div className={s.panel}>
          {hasEnded ? (
            <div className={s.panelHead}>
              <button type="button" className={s.clear} onClick={clearEnded}>
                清除已结束
              </button>
            </div>
          ) : null}
          <ul className={s.list} aria-label="后台任务列表">
            {visible.map((task) => {
              const dot = backgroundTaskDotStatus(task.status);
              const label = taskDisplayLabel(task);
              const stopError = stopErrors[task.taskId];
              const isStopping = stopping[task.taskId] === true;
              const detail = stopError ?? (task.status !== "running" ? task.error : undefined);
              return (
                <li key={task.taskId} className={s.item} data-status={dot}>
                  <div className={s.rowWrap}>
                    <button
                      type="button"
                      className={s.row}
                      data-status={dot}
                      data-active={task.taskId === activeTaskId ? "true" : undefined}
                      onClick={() => onOpen?.(task.taskId)}
                      title={task.command ?? label}
                    >
                      <Terminal size={12} className={s.kindIcon} aria-hidden="true" />
                      <span className={s.label}>{label}</span>
                      <span className={s.status}>
                        <span className={s.dot} data-status={dot} aria-hidden="true" />
                        {backgroundTaskStatusText(task.status)}
                      </span>
                      <span className={s.elapsed}>{formatElapsed(taskElapsedMs(task, now))}</span>
                    </button>
                    {task.status === "running" ? (
                      <Button
                        size="xs"
                        variant="outline"
                        className={s.stop}
                        disabled={isStopping}
                        onClick={() => void stop(task.taskId)}
                      >
                        {isStopping ? "停止中…" : "停止"}
                      </Button>
                    ) : null}
                  </div>
                  {detail ? (
                    <p className={s.detail} data-tone={stopError ? "error" : undefined} role={stopError ? "alert" : undefined}>
                      {detail}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
