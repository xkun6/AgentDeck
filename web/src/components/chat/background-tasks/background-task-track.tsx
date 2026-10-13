// 输入框上方的「后台任务」药丸（design.md 4.15）：按会话列出 Claude 的后台命令 / 子代理 / workflow，
// 展开后可查看耗时与用量、打开输出对话框、单独停止。样式与交互参照子代理药丸（subagent-track）。
import { useEffect, useMemo, useState } from "react";
import { Bot, ChevronDown, ChevronUp, ListChecks, Terminal, Workflow } from "lucide-react";
import type { AgentBackgroundTask, AgentBackgroundTaskKind } from "@agentdeck/protocol";
import { Button } from "@agentdeck/shared-ui";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import {
  backgroundTaskDotStatus,
  backgroundTaskPillLabel,
  backgroundTaskStatusText,
  formatElapsed,
  taskElapsedMs,
  taskUsageText,
} from "./background-task-presentation";
import { BackgroundTaskOutputDialog } from "./background-task-output-dialog";
import s from "./background-task-track.module.css";

const KIND_ICON: Record<AgentBackgroundTaskKind, typeof Terminal> = {
  command: Terminal,
  agent: Bot,
  workflow: Workflow,
  other: ListChecks,
};

const KIND_LABEL: Record<AgentBackgroundTaskKind, string> = {
  command: "命令",
  agent: "子代理",
  workflow: "workflow",
  other: "任务",
};

export interface BackgroundTaskTrackProps {
  agentId: string;
  /** 该会话全部后台任务（已按登记顺序） */
  tasks: readonly AgentBackgroundTask[];
}

export function BackgroundTaskTrack({ agentId, tasks }: BackgroundTaskTrackProps) {
  const actions = useAgentSession();
  const [open, setOpen] = useState(false);
  // 「清除已结束」只在前端隐藏
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(new Set());
  const [stopping, setStopping] = useState<Record<string, boolean>>({});
  const [stopErrors, setStopErrors] = useState<Record<string, string>>({});
  const [outputTaskId, setOutputTaskId] = useState<string | null>(null);
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
  const tone = visible.some((task) => task.status === "running")
    ? "running"
    : visible.some((task) => task.status === "failed")
      ? "error"
      : "done";
  const outputTask = outputTaskId ? tasks.find((task) => task.taskId === outputTaskId) ?? null : null;

  const stop = async (taskId: string) => {
    setStopping((current) => ({ ...current, [taskId]: true }));
    setStopErrors(({ [taskId]: _removed, ...rest }) => rest);
    try {
      await actions.stopBackgroundTask(agentId, taskId);
    } catch (error) {
      setStopping(({ [taskId]: _removed, ...rest }) => rest);
      setStopErrors((current) => ({ ...current, [taskId]: humanizeSidecarError(error) }));
    }
  };

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
              const Icon = KIND_ICON[task.kind];
              const dot = backgroundTaskDotStatus(task.status);
              const usage = taskUsageText(task);
              const stopError = stopErrors[task.taskId];
              const isStopping = stopping[task.taskId] === true;
              const detail = stopError ?? (task.status !== "running" ? task.error : undefined);
              return (
                <li key={task.taskId} className={s.item} data-status={dot}>
                  <div className={s.row}>
                    <Icon size={12} className={s.kindIcon} aria-label={KIND_LABEL[task.kind]} />
                    <span className={s.label} title={task.description}>
                      {task.description || KIND_LABEL[task.kind]}
                    </span>
                    {usage ? <span className={s.usage}>{usage}</span> : null}
                    <span className={s.status}>
                      <span className={s.dot} data-status={dot} aria-hidden="true" />
                      {backgroundTaskStatusText(task.status)}
                    </span>
                    <span className={s.elapsed}>{formatElapsed(taskElapsedMs(task, now))}</span>
                    <span className={s.actions}>
                      {task.hasOutput ? (
                        <Button size="xs" variant="outline" onClick={() => setOutputTaskId(task.taskId)}>
                          输出
                        </Button>
                      ) : null}
                      {task.status === "running" ? (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={isStopping}
                          onClick={() => void stop(task.taskId)}
                        >
                          {isStopping ? "停止中…" : "停止"}
                        </Button>
                      ) : null}
                    </span>
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
      <BackgroundTaskOutputDialog
        open={outputTask !== null}
        agentId={agentId}
        task={outputTask}
        onClose={() => setOutputTaskId(null)}
      />
    </div>
  );
}
