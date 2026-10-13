// 看板（design.md 4.28）的展示与拖拽排序规则。
import type { AgentSnapshot, Board, BoardTask, BoardTaskStatus } from "@agentdeck/protocol";
import { AGENT_STATUS_LABELS } from "@/lib/agent-session-display";

export const BOARD_COLUMNS: ReadonlyArray<{ status: BoardTaskStatus; label: string }> = [
  { status: "todo", label: "待办" },
  { status: "running", label: "运行中" },
  { status: "review", label: "待评审" },
  { status: "done", label: "完成" },
  { status: "blocked", label: "阻塞" },
];

export function columnLabel(status: BoardTaskStatus): string {
  return BOARD_COLUMNS.find((column) => column.status === status)?.label ?? status;
}

/** 各列任务，列内按 order 升序（order 相同按创建时间） */
export function tasksByColumn(board: Board): Record<BoardTaskStatus, BoardTask[]> {
  const columns: Record<BoardTaskStatus, BoardTask[]> = { todo: [], running: [], review: [], done: [], blocked: [] };
  for (const task of board.tasks) {
    columns[task.status].push(task);
  }
  for (const list of Object.values(columns)) {
    list.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }
  return columns;
}

/**
 * 拖到目标列第 index 位（index 以「不含被拖卡片」的列表为准）时的 order：
 * 取前后邻居的中点；列首取首位 - 1，列尾取末位 + 1，空列取 1。
 */
export function orderForDrop(columnTasks: BoardTask[], index: number): number {
  if (columnTasks.length === 0) return 1;
  if (index <= 0) return columnTasks[0]!.order - 1;
  if (index >= columnTasks.length) return columnTasks[columnTasks.length - 1]!.order + 1;
  return (columnTasks[index - 1]!.order + columnTasks[index]!.order) / 2;
}

export interface SessionBadge {
  label: string;
  tone: "running" | "attention" | "idle" | "error";
}

/** 关联会话的实时状态：等待审批 > 运行中 / 启动中 > 其它 */
export function sessionBadge(agent: AgentSnapshot | undefined): SessionBadge | null {
  if (!agent) return null;
  if (agent.pendingPermissions.length > 0) return { label: "等待审批", tone: "attention" };
  if (agent.status === "running" || agent.status === "starting") {
    return { label: AGENT_STATUS_LABELS[agent.status], tone: "running" };
  }
  if (agent.status === "error") return { label: AGENT_STATUS_LABELS.error, tone: "error" };
  return { label: AGENT_STATUS_LABELS[agent.status], tone: "idle" };
}
