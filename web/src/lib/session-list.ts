// 会话列表（侧栏 / 历史页）的置顶、归档规则与批量操作（design.md 4.17）。
import type { AgentSnapshot } from "@agentdeck/protocol";

/** 侧栏：不显示已归档的会话；置顶的排在最前，组内保持传入顺序（agent.list 已按 updatedAt 倒序）。 */
export function sidebarSessions<T extends Pick<AgentSnapshot, "pinned" | "archived">>(agents: T[]): T[] {
  const visible = agents.filter((agent) => !agent.archived);
  return [...visible.filter((agent) => agent.pinned), ...visible.filter((agent) => !agent.pinned)];
}

export type HistoryView = "all" | "archived";

export function inHistoryView(agent: Pick<AgentSnapshot, "archived">, view: HistoryView): boolean {
  return view === "archived" ? agent.archived === true : agent.archived !== true;
}

/** 历史页：「全部会话」视图把置顶的会话单列出来放最前；「已归档」视图不分置顶组。 */
export function splitPinned<T extends { agent: Pick<AgentSnapshot, "pinned"> }>(
  rows: T[],
  view: HistoryView,
): { pinned: T[]; rest: T[] } {
  if (view !== "all") return { pinned: [], rest: rows };
  return {
    pinned: rows.filter((row) => row.agent.pinned),
    rest: rows.filter((row) => !row.agent.pinned),
  };
}

export interface BatchResult {
  succeeded: string[];
  failed: string[];
}

/** 逐个执行（失败不中断），返回成功 / 失败的 id。 */
export async function runBatch(ids: string[], op: (id: string) => Promise<unknown>): Promise<BatchResult> {
  const result: BatchResult = { succeeded: [], failed: [] };
  for (const id of ids) {
    try {
      await op(id);
      result.succeeded.push(id);
    } catch {
      result.failed.push(id);
    }
  }
  return result;
}

export function batchSummary(label: string, result: BatchResult): string {
  const { succeeded, failed } = result;
  return failed.length === 0
    ? `${label}：成功 ${succeeded.length} 个`
    : `${label}：成功 ${succeeded.length} 个，失败 ${failed.length} 个`;
}
