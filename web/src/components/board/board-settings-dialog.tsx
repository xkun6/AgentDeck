// 看板设置弹窗（design.md 4.28）：每任务独立 worktree、自动派发、并发上限、默认指派。
import { useState } from "react";
import { X } from "lucide-react";
import { Button, Dialog, Field, IconButton, Input } from "@agentdeck/shared-ui";
import type { BoardAssignee, BoardSettings } from "@agentdeck/protocol";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { AssigneePicker } from "./assignee-picker";
import s from "./board-panels.module.css";

const MAX_CONCURRENT_LIMIT = 16;

interface BoardSettingsDialogProps {
  projectPath: string;
  settings: BoardSettings;
  onClose: () => void;
}

export function BoardSettingsDialog({ projectPath, settings, onClose }: BoardSettingsDialogProps) {
  const actions = useAgentSession();
  const [worktreePerTask, setWorktreePerTask] = useState(settings.worktreePerTask);
  const [autoDispatch, setAutoDispatch] = useState(settings.autoDispatch);
  const [maxConcurrent, setMaxConcurrent] = useState(String(settings.maxConcurrent));
  const [assignee, setAssignee] = useState<BoardAssignee | null>(settings.defaultAssignee);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const concurrent = Number(maxConcurrent);
  const concurrentValid = Number.isInteger(concurrent) && concurrent >= 1 && concurrent <= MAX_CONCURRENT_LIMIT;

  const save = async () => {
    if (!concurrentValid || !assignee) return;
    setSaving(true);
    setError(null);
    try {
      await actions.updateBoardSettings(projectPath, {
        worktreePerTask,
        autoDispatch,
        maxConcurrent: concurrent,
        defaultAssignee: assignee,
      });
      onClose();
    } catch (err) {
      setError(humanizeSidecarError(err));
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className={s.dialog} aria-describedby={undefined}>
          <div className={s.head}>
            <Dialog.Title asChild>
              <h2 className={s.title}>看板设置</h2>
            </Dialog.Title>
            <Dialog.Close asChild>
              <IconButton aria-label="关闭">
                <X size={16} aria-hidden="true" />
              </IconButton>
            </Dialog.Close>
          </div>
          <div className={s.body}>
            <label className={s.check}>
              <input
                type="checkbox"
                checked={worktreePerTask}
                onChange={(event) => setWorktreePerTask(event.target.checked)}
              />
              <span>每个任务使用独立 git worktree（非 git 项目自动忽略）</span>
            </label>
            <label className={s.check}>
              <input
                type="checkbox"
                checked={autoDispatch}
                onChange={(event) => setAutoDispatch(event.target.checked)}
              />
              <span>自动派发：依赖全部完成的待办任务按顺序自动开始</span>
            </label>
            <Field
              label="并发上限"
              hint={`同时运行的任务数（1–${MAX_CONCURRENT_LIMIT}），只限制自动派发`}
              error={concurrentValid ? undefined : `请输入 1–${MAX_CONCURRENT_LIMIT} 的整数`}
            >
              <Input
                aria-label="并发上限"
                inputMode="numeric"
                value={maxConcurrent}
                invalid={!concurrentValid}
                onChange={(event) => setMaxConcurrent(event.target.value)}
              />
            </Field>
            <Field label="默认指派" hint="未单独指派的任务使用这里的 Agent、模型与模式">
              <AssigneePicker value={assignee} onChange={setAssignee} cwd={projectPath} />
            </Field>
          </div>
          <div className={s.foot}>
            {error ? <span className={s.footError} role="alert">{error}</span> : null}
            <Button onClick={onClose}>取消</Button>
            <Button variant="solid" tone="accent" loading={saving} disabled={!concurrentValid || !assignee} onClick={() => void save()}>
              保存
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
