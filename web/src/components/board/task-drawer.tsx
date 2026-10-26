// 看板任务详情抽屉（design.md 4.28）：编辑标题 / 描述 / 指派 / 依赖，查看会话与 diff，
// 合并到当前分支（带冲突结果展示），删除任务。新建任务也用同一个抽屉（taskId 为 null）。
import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { useNavigate } from "react-router-dom";
import { GitMerge, MessageSquare, Trash2, X } from "lucide-react";
import { Button, Dialog, Field, IconButton, Input, Textarea } from "@agentdeck/shared-ui";
import type { Board, BoardAssignee } from "@agentdeck/protocol";
import { ReviewTab } from "@/components/chat/preview-rail/review-tab";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { columnLabel, sessionBadge } from "@/lib/board-display";
import { shortenPath } from "@/lib/paths";
import { useConfirm } from "@/lib/use-confirm";
import { agentSnapshotsAtom } from "@/stores/agents";
import { AssigneePicker } from "./assignee-picker";
import s from "./board-panels.module.css";

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 20_000;

interface TaskDrawerProps {
  projectPath: string;
  board: Board;
  /** null = 新建 */
  taskId: string | null;
  onClose: () => void;
  /** 抽屉关闭后仍需告知用户的提示（如删除任务时清理 worktree 失败） */
  onNotice: (message: string) => void;
}

interface MergeResult {
  ok: boolean;
  conflicts?: string[];
  warning?: string;
}

export function TaskDrawer({ projectPath, board, taskId, onClose, onNotice }: TaskDrawerProps) {
  const actions = useAgentSession();
  const navigate = useNavigate();
  const { confirm } = useConfirm();
  const agents = useAtomValue(agentSnapshotsAtom);
  const task = taskId ? board.tasks.find((item) => item.id === taskId) : undefined;
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [assignee, setAssignee] = useState<BoardAssignee | null>(task?.assignee ?? null);
  const [dependsOn, setDependsOn] = useState<string[]>(task?.dependsOn ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [removeOnMerge, setRemoveOnMerge] = useState(true);
  const [removeOnDelete, setRemoveOnDelete] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeResult, setMergeResult] = useState<MergeResult | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);

  // 任务在别处被删除：关闭抽屉
  const missing = taskId !== null && !task;
  useEffect(() => {
    if (missing) onClose();
  }, [missing, onClose]);
  if (missing) return null;

  const titleError = !title.trim()
    ? "标题不能为空"
    : title.trim().length > TITLE_MAX
      ? `标题不能超过 ${TITLE_MAX} 字`
      : undefined;
  const descriptionError = description.length > DESCRIPTION_MAX ? `描述不能超过 ${DESCRIPTION_MAX} 字` : undefined;
  const others = board.tasks.filter((item) => item.id !== taskId);
  const badge = sessionBadge(task?.agentId ? agents[task.agentId] : undefined);

  const save = async () => {
    if (titleError || descriptionError) return;
    setSaving(true);
    setError(null);
    try {
      await actions.upsertBoardTask(projectPath, {
        ...(task ? { id: task.id } : {}),
        title: title.trim(),
        description,
        assignee,
        dependsOn,
      });
      if (!task) {
        onClose();
      } else {
        setSaving(false);
      }
    } catch (err) {
      setError(humanizeSidecarError(err));
      setSaving(false);
    }
  };

  const merge = async () => {
    if (!task) return;
    setMerging(true);
    setMergeError(null);
    setMergeResult(null);
    try {
      setMergeResult(await actions.mergeBoardTask(projectPath, task.id, removeOnMerge));
    } catch (err) {
      setMergeError(humanizeSidecarError(err));
    } finally {
      setMerging(false);
    }
  };

  const remove = async () => {
    if (!task) return;
    const ok = await confirm({
      title: "删除任务",
      body: `确认删除任务「${task.title}」？${task.status === "running" ? "它正在运行，会先中断会话回合。" : ""}关联的会话不会被删除。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await actions.deleteBoardTask(projectPath, task.id, task.worktree ? removeOnDelete : undefined);
      if (result.warning) {
        onNotice(`任务已删除，但清理 worktree 失败：${result.warning}`);
      }
      onClose();
    } catch (err) {
      setError(humanizeSidecarError(err));
    }
  };

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className={s.drawer} aria-describedby={undefined}>
          <div className={s.head}>
            <Dialog.Title asChild>
              <h2 className={s.title}>{task ? "任务详情" : "新建任务"}</h2>
            </Dialog.Title>
            <Dialog.Close asChild>
              <IconButton aria-label="关闭">
                <X size={16} aria-hidden="true" />
              </IconButton>
            </Dialog.Close>
          </div>
          <div className={s.body}>
            {task ? (
              <div className={s.statusRow}>
                <span className={s.status} data-status={task.status}>{columnLabel(task.status)}</span>
                {badge ? <span className={s.sessionBadge} data-tone={badge.tone}>会话{badge.label}</span> : null}
                {task.attempts > 0 ? <span className={s.muted}>已尝试 {task.attempts}/{task.maxAttempts}</span> : null}
              </div>
            ) : null}
            {task?.status === "blocked" && task.blockedReason ? (
              <p className={s.blockedReason} role="status">阻塞原因：{task.blockedReason}</p>
            ) : null}

            <Field label="标题" error={titleError} required>
              <Input
                aria-label="标题"
                value={title}
                invalid={Boolean(titleError)}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
            <Field label="描述" hint="作为提示的一部分发给 Agent" error={descriptionError}>
              <Textarea
                aria-label="描述"
                rows={6}
                value={description}
                invalid={Boolean(descriptionError)}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <Field label="指派" hint="新开会话时使用；已运行的任务不受影响">
              <AssigneePicker value={assignee} onChange={setAssignee} cwd={projectPath} allowInherit />
            </Field>
            <Field label="依赖" hint="自动派发时，依赖全部完成后才会开始">
              {others.length === 0 ? (
                <span className={s.muted}>没有其它任务可依赖</span>
              ) : (
                <ul className={s.depList} aria-label="依赖任务">
                  {others.map((item) => (
                    <li key={item.id}>
                      <label className={s.check}>
                        <input
                          type="checkbox"
                          checked={dependsOn.includes(item.id)}
                          onChange={(event) =>
                            setDependsOn((current) =>
                              event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id),
                            )
                          }
                        />
                        <span>{item.title}</span>
                        <span className={s.muted}>{columnLabel(item.status)}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </Field>

            {task ? (
              <>
                <div className={s.actionsRow}>
                  <Button
                    size="sm"
                    leadingIcon={<MessageSquare size={12} />}
                    disabled={!task.agentId}
                    onClick={() => task.agentId && navigate(`/tasks/${encodeURIComponent(task.agentId)}`)}
                  >
                    查看会话
                  </Button>
                  <Button size="sm" onClick={() => setShowDiff((value) => !value)}>
                    {showDiff ? "收起 diff" : "查看 diff"}
                  </Button>
                </div>
                {showDiff ? (
                  <div className={s.diff}>
                    <ReviewTab workspaceRoot={task.worktree?.path ?? projectPath} active />
                  </div>
                ) : null}
                {task.worktree ? (
                  <p className={s.muted} title={task.worktree.path}>
                    分支 {task.worktree.branch}，{shortenPath(task.worktree.path)}
                  </p>
                ) : null}

                {task.status === "review" && task.worktree ? (
                  <section className={s.mergeBox} aria-label="合并">
                    <label className={s.check}>
                      <input
                        type="checkbox"
                        checked={removeOnMerge}
                        onChange={(event) => setRemoveOnMerge(event.target.checked)}
                      />
                      <span>合并成功后删除 worktree 与分支</span>
                    </label>
                    <Button
                      variant="solid"
                      tone="accent"
                      size="sm"
                      leadingIcon={<GitMerge size={12} />}
                      loading={merging}
                      onClick={() => void merge()}
                    >
                      合并到当前分支
                    </Button>
                    {mergeResult?.ok ? (
                      <p className={s.mergeOk} role="status">
                        已合并到当前分支，任务已完成。{mergeResult.warning ? `（清理 worktree 失败：${mergeResult.warning}）` : ""}
                      </p>
                    ) : null}
                    {mergeResult && !mergeResult.ok ? (
                      <div className={s.mergeConflict} role="alert">
                        <p>合并冲突，已自动中止合并，任务仍在待评审。冲突文件：</p>
                        <ul>
                          {(mergeResult.conflicts ?? []).map((file) => (
                            <li key={file}>{file}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {mergeError ? <p className={s.mergeError} role="alert">{mergeError}</p> : null}
                  </section>
                ) : null}

                <div className={s.dangerRow}>
                  {task.worktree ? (
                    <label className={s.check}>
                      <input
                        type="checkbox"
                        checked={removeOnDelete}
                        onChange={(event) => setRemoveOnDelete(event.target.checked)}
                      />
                      <span>删除时同时删除 worktree 与分支</span>
                    </label>
                  ) : null}
                  <Button size="sm" tone="danger" leadingIcon={<Trash2 size={12} />} onClick={() => void remove()}>
                    删除任务
                  </Button>
                </div>
              </>
            ) : null}
          </div>
          <div className={s.foot}>
            {error ? <span className={s.footError} role="alert">{error}</span> : null}
            <Button onClick={onClose}>关闭</Button>
            <Button
              variant="solid"
              tone="accent"
              loading={saving}
              disabled={Boolean(titleError || descriptionError)}
              onClick={() => void save()}
            >
              {task ? "保存" : "创建"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
