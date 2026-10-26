// 项目看板（design.md 4.28）：五列、卡片列间拖拽与列内排序（HTML5 原生拖拽，不引入依赖）、
// 指派 Agent 与关联会话实时状态、新建任务、详情抽屉与看板设置。
import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import { useAtomValue } from "jotai";
import { Link2, Plus, Settings } from "lucide-react";
import { Button, LoadingState } from "@agentdeck/shared-ui";
import type { Board, BoardTask, BoardTaskStatus } from "@agentdeck/protocol";
import { useAgentProviders } from "@/hooks/use-agent-catalog";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { agentProviderLabel } from "@/lib/agent-session-display";
import { BOARD_COLUMNS, orderForDrop, sessionBadge, tasksByColumn } from "@/lib/board-display";
import { boardPathKey } from "@/lib/board-path";
import { useConfirm } from "@/lib/use-confirm";
import { agentSnapshotsAtom, sidecarConnectionAtom } from "@/stores/agents";
import { boardsByPathAtom } from "@/stores/boards";
import { BoardSettingsDialog } from "./board-settings-dialog";
import { TaskDrawer } from "./task-drawer";
import s from "./board-view.module.css";

interface BoardViewProps {
  /** 项目根路径（规范化后的工作区路径） */
  projectPath: string;
}

type DrawerTarget = { taskId: string } | { create: true } | null;

export function BoardView({ projectPath }: BoardViewProps) {
  const actions = useAgentSession();
  const { confirm } = useConfirm();
  const connected = useAtomValue(sidecarConnectionAtom) === "open";
  const boards = useAtomValue(boardsByPathAtom);
  const agents = useAtomValue(agentSnapshotsAtom);
  const { data: providers } = useAgentProviders();
  const board: Board | undefined = boards[boardPathKey(projectPath)];
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerTarget>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStatus, setOverStatus] = useState<BoardTaskStatus | null>(null);

  // 进入页面与每次（重）连成功后拉一次，之后由 board.changed 维护
  useEffect(() => {
    if (!connected) return;
    actions.getBoard(projectPath).then(
      () => setLoadError(null),
      (error: unknown) => setLoadError(humanizeSidecarError(error)),
    );
  }, [actions, connected, projectPath]);

  const columns = useMemo(() => (board ? tasksByColumn(board) : null), [board]);

  const moveTask = useCallback(
    async (task: BoardTask, status: BoardTaskStatus, index: number) => {
      if (!columns) return;
      if (task.status === "running" && status !== "running") {
        const ok = await confirm({
          title: "中断运行中的任务",
          body: `任务「${task.title}」正在运行，移出「运行中」会先中断它的会话回合。`,
          confirmLabel: "中断并移动",
          danger: true,
        });
        if (!ok) return;
      }
      const target = columns[status].filter((item) => item.id !== task.id);
      const order = orderForDrop(target, index);
      setActionError(null);
      try {
        await actions.moveBoardTask(projectPath, task.id, status, order);
      } catch (error) {
        setActionError(humanizeSidecarError(error));
      }
    },
    [actions, columns, confirm, projectPath],
  );

  const dragged = board?.tasks.find((task) => task.id === dragId);

  const endDrag = () => {
    setDragId(null);
    setOverStatus(null);
  };

  const dropOnColumn = (event: DragEvent, status: BoardTaskStatus) => {
    event.preventDefault();
    if (!dragged || !columns) return endDrag();
    const list = columns[status].filter((item) => item.id !== dragged.id);
    endDrag();
    void moveTask(dragged, status, list.length);
  };

  const dropOnCard = (event: DragEvent<HTMLElement>, target: BoardTask) => {
    event.preventDefault();
    event.stopPropagation();
    if (!dragged || !columns || dragged.id === target.id) return endDrag();
    const list = columns[target.status].filter((item) => item.id !== dragged.id);
    const rect = event.currentTarget.getBoundingClientRect();
    const after = event.clientY >= rect.top + rect.height / 2;
    const targetIndex = list.findIndex((item) => item.id === target.id);
    const index = after ? targetIndex + 1 : targetIndex;
    endDrag();
    void moveTask(dragged, target.status, index);
  };

  if (!board || !columns) {
    return (
      <div className={s.state}>
        {loadError ? (
          <p role="alert" className={s.error}>{loadError}</p>
        ) : (
          <LoadingState variant="block" label="正在加载看板…" />
        )}
      </div>
    );
  }

  return (
    <div className={s.board}>
      <div className={s.toolbar}>
        <span className={s.summary}>
          共 {board.tasks.length} 个任务
          {board.settings.autoDispatch ? "，自动派发已开启" : ""}
        </span>
        <div className={s.toolbarActions}>
          <Button size="sm" leadingIcon={<Settings size={12} />} onClick={() => setSettingsOpen(true)}>
            看板设置
          </Button>
          <Button size="sm" variant="solid" tone="accent" leadingIcon={<Plus size={12} />} onClick={() => setDrawer({ create: true })}>
            新建任务
          </Button>
        </div>
      </div>
      {actionError ? (
        <p role="alert" className={s.error}>{actionError}</p>
      ) : null}
      <div className={s.columns}>
        {BOARD_COLUMNS.map((column) => (
          <section
            key={column.status}
            className={s.column}
            data-status={column.status}
            data-over={overStatus === column.status ? "true" : undefined}
            aria-label={column.label}
            onDragOver={(event) => {
              if (!dragId) return;
              event.preventDefault();
              setOverStatus(column.status);
            }}
            onDrop={(event) => dropOnColumn(event, column.status)}
          >
            <header className={s.columnHead}>
              <h3>{column.label}</h3>
              <span className={s.count}>{columns[column.status].length}</span>
            </header>
            <div className={s.cards}>
              {columns[column.status].map((task) => {
                const badge = sessionBadge(task.agentId ? agents[task.agentId] : undefined);
                const assignee = task.assignee ?? board.settings.defaultAssignee;
                return (
                  <article
                    key={task.id}
                    className={s.card}
                    data-testid={`task-${task.id}`}
                    data-dragging={dragId === task.id ? "true" : undefined}
                    draggable
                    tabIndex={0}
                    onClick={() => setDrawer({ taskId: task.id })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") setDrawer({ taskId: task.id });
                    }}
                    onDragStart={(event) => {
                      event.dataTransfer?.setData("text/plain", task.id);
                      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                      setDragId(task.id);
                    }}
                    onDragEnd={endDrag}
                    onDragOver={(event) => {
                      if (!dragId) return;
                      event.preventDefault();
                      setOverStatus(task.status);
                    }}
                    onDrop={(event) => dropOnCard(event, task)}
                  >
                    <div className={s.cardTitle}>{task.title}</div>
                    <div className={s.cardMeta}>
                      <span className={s.agent}>
                        {agentProviderLabel(assignee.provider, providers)}
                        {assignee.model ? `（${assignee.model}）` : ""}
                      </span>
                      {badge ? (
                        <span className={s.badge} data-tone={badge.tone}>
                          {badge.label}
                        </span>
                      ) : null}
                      {task.dependsOn?.length ? (
                        <span className={s.deps} title="依赖其它任务">
                          <Link2 size={12} aria-hidden /> {task.dependsOn.length}
                        </span>
                      ) : null}
                    </div>
                    {task.status === "blocked" && task.blockedReason ? (
                      <div className={s.blocked}>{task.blockedReason}</div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      {drawer ? (
        <TaskDrawer
          key={"taskId" in drawer ? drawer.taskId : "new"}
          projectPath={projectPath}
          board={board}
          taskId={"taskId" in drawer ? drawer.taskId : null}
          onClose={() => setDrawer(null)}
          onNotice={setActionError}
        />
      ) : null}
      {settingsOpen ? (
        <BoardSettingsDialog
          projectPath={projectPath}
          settings={board.settings}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </div>
  );
}
