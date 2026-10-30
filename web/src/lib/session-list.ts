// 会话列表（侧栏 / 历史页）的置顶、归档规则与批量操作（design.md 4.17）。
import type { AgentSnapshot } from "@agentdeck/protocol";

/** 隐藏会话：目标循环的评判会话（origin 为 judge，design.md 4.25），侧栏 / 历史页 / 命令面板默认不显示。 */
export function isHiddenAgent(agent: Pick<AgentSnapshot, "origin">): boolean {
  return agent.origin === "judge";
}

/** 派单出去的子会话（design.md 4.26）：只在派单页显示，不进项目列表；历史页与命令面板仍可搜到。 */
export function isDispatchedAgent(
  agent: Pick<AgentSnapshot, "origin" | "parentAgentId" | "reportToAgentId">,
): boolean {
  return agent.origin === "delegate" || agent.parentAgentId !== undefined || agent.reportToAgentId !== undefined;
}

/** 子会话所属的主会话（或上一级子会话）；0.3.18–0.3.19 建的顶层会话可能只有 reportToAgentId，或两者都没有。 */
export function dispatcherIdOf(agent: Pick<AgentSnapshot, "parentAgentId" | "reportToAgentId">): string | undefined {
  return agent.parentAgentId ?? agent.reportToAgentId;
}

/** 侧栏：不显示已归档、隐藏与派单出去的会话；置顶的排在最前，组内保持传入顺序（agent.list 已按 updatedAt 倒序）。 */
export function sidebarSessions<
  T extends Pick<AgentSnapshot, "pinned" | "archived" | "origin" | "parentAgentId" | "reportToAgentId">,
>(agents: T[]): T[] {
  const visible = agents.filter((agent) => !agent.archived && !isHiddenAgent(agent) && !isDispatchedAgent(agent));
  return [...visible.filter((agent) => agent.pinned), ...visible.filter((agent) => !agent.pinned)];
}

export type HistoryView = "all" | "archived";

export function inHistoryView(agent: Pick<AgentSnapshot, "archived" | "origin">, view: HistoryView): boolean {
  if (isHiddenAgent(agent)) return false;
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

// ---------------------------------------------------------------------------
// 会话森林：协作组（design.md 4.27）按根归并；子会话不进侧栏后（4.26）侧栏的根都没有子节点
// ---------------------------------------------------------------------------

export interface SessionTreeNode<T> {
  agent: T;
  children: SessionTreeNode<T>[];
}

/**
 * 按 parentAgentId 把会话排成森林：父会话不在列表里（已归档 / 已删除）的子会话当作根；成环时断开成根。
 * 根与同一父会话下的子会话都保持传入顺序。
 */
export function buildSessionTree<T extends Pick<AgentSnapshot, "id" | "parentAgentId">>(
  agents: T[],
): SessionTreeNode<T>[] {
  const nodes = new Map<string, SessionTreeNode<T>>(agents.map((agent) => [agent.id, { agent, children: [] }]));
  const reachesSelf = (agent: T): boolean => {
    const seen = new Set<string>([agent.id]);
    let parentId = agent.parentAgentId;
    while (parentId !== undefined) {
      if (seen.has(parentId)) return true;
      seen.add(parentId);
      parentId = nodes.get(parentId)?.agent.parentAgentId;
    }
    return false;
  };
  const roots: SessionTreeNode<T>[] = [];
  for (const agent of agents) {
    const node = nodes.get(agent.id)!;
    const parent = agent.parentAgentId !== undefined ? nodes.get(agent.parentAgentId) : undefined;
    if (parent && parent !== node && !reachesSelf(agent)) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export interface SessionTreeRow<T> {
  agent: T;
  depth: number;
  childCount: number;
  collapsed: boolean;
}

/** 树的某个根下按先序展开成行；collapsed 中的会话不展开其子会话 */
export function flattenSessionTree<T>(
  root: SessionTreeNode<T>,
  idOf: (agent: T) => string,
  collapsedIds: ReadonlySet<string>,
): SessionTreeRow<T>[] {
  const rows: SessionTreeRow<T>[] = [];
  const walk = (node: SessionTreeNode<T>, depth: number) => {
    const collapsed = node.children.length > 0 && collapsedIds.has(idOf(node.agent));
    rows.push({ agent: node.agent, depth, childCount: node.children.length, collapsed });
    if (!collapsed) for (const child of node.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return rows;
}

/** 根节点自身或任一子孙满足条件 */
export function treeSome<T>(node: SessionTreeNode<T>, predicate: (agent: T) => boolean): boolean {
  return predicate(node.agent) || node.children.some((child) => treeSome(child, predicate));
}

// ---------------------------------------------------------------------------
// 协作组（design.md 4.27）：同组会话聚在侧栏一个可折叠的「协作组」节点下
// ---------------------------------------------------------------------------

export interface SessionBlock<T> {
  /** null = 不属于任何已知协作组（单棵会话树） */
  groupId: string | null;
  roots: SessionTreeNode<T>[];
}

/**
 * 把会话森林的根按协作组归并：根会话的 groupId 属于 `knownGroupIds` 时，同组的根合并成一个块（位置取该组首个成员，
 * 保持传入顺序）；其余根各自一块。子会话树（4.26）随根一起留在块内；groupId 未知（组已删除）的会话按普通会话处理。
 */
export function groupSessionRoots<T extends Pick<AgentSnapshot, "groupId">>(
  roots: SessionTreeNode<T>[],
  knownGroupIds: ReadonlySet<string>,
): SessionBlock<T>[] {
  const blocks: SessionBlock<T>[] = [];
  const byGroup = new Map<string, SessionBlock<T>>();
  for (const root of roots) {
    const groupId = root.agent.groupId;
    if (groupId === undefined || !knownGroupIds.has(groupId)) {
      blocks.push({ groupId: null, roots: [root] });
      continue;
    }
    let block = byGroup.get(groupId);
    if (!block) {
      block = { groupId, roots: [] };
      byGroup.set(groupId, block);
      blocks.push(block);
    }
    block.roots.push(root);
  }
  return blocks;
}
