// 后台命令输出对话框（design.md 4.15）：等宽字体显示输出文件尾部；任务运行中每 2 秒自动刷新并保持滚动在底部
// （用户上滚时暂停自动滚动），任务结束后再拉一次最终输出便停止轮询。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { AgentBackgroundTask, AgentBackgroundTaskOutput } from "@agentdeck/protocol";
import { Button, Dialog, IconButton } from "@agentdeck/shared-ui";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import s from "./background-task-output-dialog.module.css";

export const OUTPUT_POLL_INTERVAL_MS = 2000;
const OUTPUT_MAX_BYTES = 64 * 1024;
/** 距底部不超过该像素视为「在底部」 */
const STICK_THRESHOLD_PX = 8;

export interface BackgroundTaskOutputDialogProps {
  open: boolean;
  agentId: string;
  /** 要查看输出的任务（随 agent.tasks.update 实时变化）；为 null 时对话框关闭 */
  task: AgentBackgroundTask | null;
  onClose: () => void;
}

export function BackgroundTaskOutputDialog({ open, agentId, task, onClose }: BackgroundTaskOutputDialogProps) {
  const actions = useAgentSession();
  const [output, setOutput] = useState<AgentBackgroundTaskOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const bodyRef = useRef<HTMLPreElement | null>(null);
  const stickToBottomRef = useRef(true);
  // 换任务 / 关闭后丢弃过期的响应
  const generationRef = useRef(0);

  const taskId = task?.taskId ?? null;
  const running = task?.status === "running";

  const load = useCallback(async () => {
    if (!taskId) return;
    const generation = generationRef.current;
    setLoading(true);
    try {
      const next = await actions.backgroundTaskOutput(agentId, taskId, OUTPUT_MAX_BYTES);
      if (generation !== generationRef.current) return;
      setOutput(next);
      setError(null);
    } catch (err) {
      if (generation === generationRef.current) setError(humanizeSidecarError(err));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [actions, agentId, taskId]);

  // 打开 / 换任务：清空并重置滚动跟随
  useEffect(() => {
    generationRef.current += 1;
    setOutput(null);
    setError(null);
    setLoading(false);
    stickToBottomRef.current = true;
  }, [agentId, open, taskId]);

  // 打开时拉一次；运行中每 2 秒轮询。任务结束时 running 变化会重新执行，再拉一次最终输出后不再轮询。
  useEffect(() => {
    if (!open || !taskId) return;
    void load();
    if (!running) return;
    const timer = setInterval(() => void load(), OUTPUT_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load, open, running, taskId]);

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

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className={s.dialog} aria-describedby={undefined}>
          <div className={s.head}>
            <Dialog.Title asChild>
              <h2 className={s.title} title={task?.description}>
                {task?.description || "后台命令输出"}
              </h2>
            </Dialog.Title>
            <div className={s.headActions}>
              <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
                刷新
              </Button>
              <Dialog.Close asChild>
                <IconButton aria-label="关闭">
                  <X size={16} aria-hidden="true" />
                </IconButton>
              </Dialog.Close>
            </div>
          </div>
          {output?.truncated ? (
            <p className={s.note}>已截断，仅显示最后 {OUTPUT_MAX_BYTES / 1024} KB</p>
          ) : null}
          {error ? <p className={s.error} role="alert">{error}</p> : null}
          <pre ref={bodyRef} className={s.body} onScroll={onScroll} aria-label="命令输出">
            {output ? (output.text || "（暂无输出）") : loading ? "读取中…" : ""}
          </pre>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
