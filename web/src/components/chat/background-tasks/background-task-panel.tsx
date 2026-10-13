// 后台任务右侧面板（design.md 4.15）：与子代理面板同一区域、同一布局（拖宽把手 + 头部 + 主体）。
// 头部显示描述、状态 / 耗时 / 退出码，主体依次是完整命令（等宽、可选中复制）与输出区；
// 输出区读取 agent.tasks.output 的尾部：任务运行中每 2 秒刷新并保持滚动在底部（用户上滚时暂停），
// 任务结束后再拉一次最终输出便停止轮询，保留最后输出。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { AgentBackgroundTask, AgentBackgroundTaskOutput } from "@agentdeck/protocol";
import { Button } from "@agentdeck/shared-ui";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { PanelResizeHandle, usePanelWidth } from "../panel-resize";
import {
  backgroundTaskDotStatus,
  backgroundTaskStatusText,
  formatElapsed,
  taskDisplayLabel,
  taskElapsedMs,
} from "./background-task-presentation";
import { useStopBackgroundTask } from "./use-stop-background-task";
import s from "./background-task-panel.module.css";

export const OUTPUT_POLL_INTERVAL_MS = 2000;
const OUTPUT_MAX_BYTES = 64 * 1024;
/** 距底部不超过该像素视为「在底部」 */
const STICK_THRESHOLD_PX = 8;

export interface BackgroundTaskPanelProps {
  agentId: string;
  /** 要查看的任务（随 agent.tasks.update 实时变化）；找不到时不渲染 */
  task: AgentBackgroundTask | null;
  onClose: () => void;
}

export function BackgroundTaskPanel({ agentId, task, onClose }: BackgroundTaskPanelProps) {
  const { width, onResizeStart } = usePanelWidth(460, 360, 840);
  if (!task) return null;
  return (
    <aside className={s.panel} aria-label="后台任务面板" style={{ width, flexBasis: width }}>
      <PanelResizeHandle ariaLabel="调整后台任务面板宽度" onPointerDown={onResizeStart} />
      <BackgroundTaskPanelBody key={task.taskId} agentId={agentId} task={task} onClose={onClose} />
    </aside>
  );
}

function BackgroundTaskPanelBody({
  agentId,
  task,
  onClose,
}: {
  agentId: string;
  task: AgentBackgroundTask;
  onClose: () => void;
}) {
  const actions = useAgentSession();
  const { stopping, errors, stop } = useStopBackgroundTask(agentId);
  const [output, setOutput] = useState<AgentBackgroundTaskOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const bodyRef = useRef<HTMLPreElement | null>(null);
  const stickToBottomRef = useRef(true);
  // 卸载后丢弃过期的响应
  const aliveRef = useRef(true);

  const taskId = task.taskId;
  const running = task.status === "running";
  const dot = backgroundTaskDotStatus(task.status);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await actions.backgroundTaskOutput(agentId, taskId, OUTPUT_MAX_BYTES);
      if (!aliveRef.current) return;
      setOutput(next);
      setError(null);
    } catch (err) {
      if (aliveRef.current) setError(humanizeSidecarError(err));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [actions, agentId, taskId]);

  // 打开时拉一次；运行中每 2 秒轮询。任务结束时 running 变化会重新执行，再拉一次最终输出后不再轮询。
  useEffect(() => {
    void load();
    if (!running) return;
    const timer = setInterval(() => void load(), OUTPUT_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load, running]);

  // 运行中每秒刷新耗时
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  // 新输出到达后：在底部时保持滚动在底部
  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (element && stickToBottomRef.current) element.scrollTop = element.scrollHeight;
  }, [output]);

  const onScroll = () => {
    const element = bodyRef.current;
    if (!element) return;
    stickToBottomRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_THRESHOLD_PX;
  };

  const label = taskDisplayLabel(task);
  const stopError = errors[taskId];
  const isStopping = stopping[taskId] === true;
  const detail = stopError ?? (!running ? task.error : undefined);

  return (
    <>
      <header className={s.header}>
        <div className={s.heading}>
          <div className={s.titleRow}>
            <span className={s.dot} data-status={dot} aria-hidden="true" />
            <span className={s.title} title={label}>
              {label}
            </span>
          </div>
          <div className={s.meta} data-testid="background-task-meta">
            <span className={s.status} data-status={dot}>
              {backgroundTaskStatusText(task.status)}
            </span>
            <span className={s.elapsed}>{formatElapsed(taskElapsedMs(task, now))}</span>
            {task.exitCode !== undefined ? <span>退出码 {task.exitCode}</span> : null}
          </div>
        </div>
        {running ? (
          <Button size="xs" variant="outline" disabled={isStopping} onClick={() => void stop(taskId)}>
            {isStopping ? "停止中…" : "停止"}
          </Button>
        ) : null}
        <button type="button" className={s.iconButton} onClick={onClose} aria-label="关闭后台任务面板">
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      {detail ? (
        <p className={s.notice} data-tone={stopError ? "error" : undefined} role={stopError ? "alert" : undefined}>
          {detail}
        </p>
      ) : null}
      {task.command ? (
        <section className={s.commandBlock} aria-label="执行的命令">
          <div className={s.sectionTitle}>命令</div>
          <pre className={s.command}>{task.command}</pre>
        </section>
      ) : null}
      <div className={s.outputHead}>
        <span className={s.sectionTitle}>输出</span>
        {output?.truncated ? <span className={s.note}>已截断，仅显示最后 {OUTPUT_MAX_BYTES / 1024} KB</span> : null}
        <Button size="xs" variant="outline" onClick={() => void load()} disabled={loading}>
          刷新
        </Button>
      </div>
      {error ? (
        <p className={s.notice} data-tone="error" role="alert">
          {error}
        </p>
      ) : null}
      <pre ref={bodyRef} className={s.output} onScroll={onScroll} aria-label="命令输出">
        {output ? output.text || "（暂无输出）" : loading ? "读取中…" : ""}
      </pre>
    </>
  );
}
