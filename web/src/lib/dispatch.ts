// 派单页（design.md 4.26）的纯逻辑：主会话 / 子会话的归属、状态与汇总。
import type { AgentSnapshot } from "@agentdeck/protocol";
import type { StatusDotTone } from "@agentdeck/shared-ui";
import { dispatcherIdOf, isDispatchedAgent, isHiddenAgent } from "./session-list";

export type DispatchStatus =
  | "approval"
  | "running"
  | "waiting"
  | "failed"
  | "canceled"
  | "done"
  | "notStarted"
  | "ended";

export const DISPATCH_STATUS_LABELS: Record<DispatchStatus, string> = {
  approval: "待审批",
  running: "运行中",
  waiting: "等待子任务",
  failed: "失败",
  canceled: "已中断",
  done: "已完成",
  notStarted: "未开始",
  ended: "已结束",
};

export const DISPATCH_STATUS_TONES: Record<DispatchStatus, StatusDotTone> = {
  approval: "warning",
  running: "success",
  waiting: "info",
  failed: "danger",
  canceled: "danger",
  done: "neutral",
  notStarted: "neutral",
  ended: "neutral",
};

/** 需要用户处理：待审批，或没有成功结束 */
const ATTENTION_STATUSES: ReadonlySet<DispatchStatus> = new Set(["approval", "failed", "canceled"]);
const WORKING_STATUSES: ReadonlySet<DispatchStatus> = new Set(["approval", "running", "waiting"]);
/** 算进进度分子：已结束 = 没有结局记录的旧会话，已经做完，只是不知道成败 */
const FINISHED_STATUSES: ReadonlySet<DispatchStatus> = new Set(["done", "ended"]);

/** 汇总文案的显示顺序 */
const SUMMARY_ORDER: readonly DispatchStatus[] = [
  "approval",
  "running",
  "waiting",
  "failed",
  "canceled",
  "done",
  "notStarted",
  "ended",
];

export function dispatchStatus(
  agent: AgentSnapshot,
  context: { running: boolean; descendantsWorking: boolean },
): DispatchStatus {
  if (agent.pendingPermissions.length > 0) return "approval";
  if (context.running || agent.backgroundActive === true) return "running";
  if (context.descendantsWorking) return "waiting";
  const outcome = agent.lastTurnOutcome;
  if (outcome === "failed" || agent.status === "error") return "failed";
  if (outcome === "canceled" || outcome === "running") return "canceled"; // 仍为 running 且不在运行 = 回合被打断
  if (outcome === "completed") return "done";
  return agent.lastSeq === 0 ? "notStarted" : "ended";
}

export interface DispatchNode {
  agent: AgentSnapshot;
  status: DispatchStatus;
  children: DispatchNode[];
}

export interface DispatchSummary {
  total: number;
  done: number;
  working: number;
  attention: number;
  counts: Partial<Record<DispatchStatus, number>>;
}

export interface DispatchGroup {
  /** null = 主会话已删除，或是没有记录归属的旧会话 */
  master: DispatchNode | null;
  children: DispatchNode[];
  summary: DispatchSummary;
}

function summarize(nodes: readonly DispatchNode[]): DispatchSummary {
  const summary: DispatchSummary = { total: 0, done: 0, working: 0, attention: 0, counts: {} };
  const walk = (node: DispatchNode) => {
    summary.total += 1;
    summary.counts[node.status] = (summary.counts[node.status] ?? 0) + 1;
    if (FINISHED_STATUSES.has(node.status)) summary.done += 1;
    if (WORKING_STATUSES.has(node.status)) summary.working += 1;
    if (ATTENTION_STATUSES.has(node.status)) summary.attention += 1;
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return summary;
}

/** 「2 运行中 · 1 待审批 · 3 已完成」 */
export function dispatchSummaryText(summary: DispatchSummary): string {
  return SUMMARY_ORDER.flatMap((status) => {
    const count = summary.counts[status];
    return count ? [`${count} ${DISPATCH_STATUS_LABELS[status]}`] : [];
  }).join(" · ");
}

/** 派单入口的角标：工作中与需要处理的子会话数（待审批两边都算，只计一次）；没有时为 null */
export function dispatchBadgeOf(
  groups: readonly DispatchGroup[],
): { count: number; working: number; attention: number } | null {
  let working = 0;
  let attention = 0;
  let approval = 0;
  for (const { summary } of groups) {
    working += summary.working;
    attention += summary.attention;
    approval += summary.counts.approval ?? 0;
  }
  const count = working + attention - approval;
  return count > 0 ? { count, working, attention } : null;
}

/** 会话（主会话或任一层子会话）所在的分组；多层派单时上一级不是主会话，入口要跳到这里的 master */
export function findDispatchGroup(groups: readonly DispatchGroup[], agentId: string): DispatchGroup | undefined {
  const contains = (nodes: readonly DispatchNode[]): boolean =>
    nodes.some((node) => node.agent.id === agentId || contains(node.children));
  return groups.find((group) => group.master?.agent.id === agentId || contains(group.children));
}

type ChainFields = Pick<AgentSnapshot, "id" | "archived" | "origin" | "parentAgentId" | "reportToAgentId">;

/** 显示用的上级：跳过已归档的子会话，中间层归档后它派出的会话接到再上一级；链上成环时没有上级 */
function liveDispatcherId(agent: ChainFields, byId: ReadonlyMap<string, ChainFields>): string | undefined {
  const seen = new Set([agent.id]);
  let id = dispatcherIdOf(agent);
  while (id !== undefined && !seen.has(id)) {
    const dispatcher = byId.get(id);
    if (!dispatcher?.archived || !isDispatchedAgent(dispatcher)) return id;
    seen.add(id);
    id = dispatcherIdOf(dispatcher);
  }
  return undefined;
}

/** 子会话真正的主会话（多层时上一级只是子会话）；归属链断了或成环时没有 */
export function dispatchMasterOf<T extends ChainFields>(agent: ChainFields, byId: ReadonlyMap<string, T>): T | undefined {
  const seen = new Set([agent.id]);
  let id = dispatcherIdOf(agent);
  while (id !== undefined && !seen.has(id)) {
    const dispatcher = byId.get(id);
    if (!dispatcher) return undefined;
    if (!isDispatchedAgent(dispatcher)) return dispatcher;
    seen.add(id);
    id = dispatcherIdOf(dispatcher);
  }
  return undefined;
}

/** 归属链的顶端是已归档的主会话：这样的子会话不工作时不在派单页，手机端要从「显示已归档」进入 */
export function isUnderArchivedMaster(agent: ChainFields, byId: ReadonlyMap<string, ChainFields>): boolean {
  return dispatchMasterOf(agent, byId)?.archived === true;
}

/** 沿归属链向上找所在的分组：已归档的子会话不在树里，派单页入口要跳到它上级所在的主会话 */
export function findDispatchGroupThrough(
  groups: readonly DispatchGroup[],
  snapshots: Readonly<Record<string, AgentSnapshot | undefined>>,
  agentId: string,
): DispatchGroup | undefined {
  const seen = new Set<string>();
  let id: string | undefined = agentId;
  while (id !== undefined && !seen.has(id)) {
    seen.add(id);
    const group = findDispatchGroup(groups, id);
    if (group) return group;
    const snapshot: AgentSnapshot | undefined = snapshots[id];
    id = snapshot ? dispatcherIdOf(snapshot) : undefined;
  }
  return undefined;
}

/**
 * 按主会话分组：主会话 = 有未归档的子会话指向它、自身不是子会话。已归档的主会话只有还有工作中的子会话时才列出
 * （includeArchived 时总是列出：直接打开它的详情或对话页时要用，避免最后一个子会话结束时详情突然消失）；
 * 中间层子会话归档后，它派出的会话接到再上一级；找不到主会话（或成环）的子会话归入 master 为 null 的一组，排在最后。
 * 保持传入顺序（agent.list 已按 updatedAt 倒序）。
 */
export function buildDispatchGroups(
  agents: readonly AgentSnapshot[],
  isRunning: (agent: AgentSnapshot) => boolean,
  options?: { includeArchived?: boolean },
): DispatchGroup[] {
  const visible = agents.filter((agent) => !isHiddenAgent(agent));
  const byId = new Map(visible.map((agent) => [agent.id, agent]));
  const childrenOf = new Map<string, AgentSnapshot[]>();
  for (const agent of visible) {
    const dispatcherId = liveDispatcherId(agent, byId);
    if (agent.archived || dispatcherId === undefined) continue;
    const siblings = childrenOf.get(dispatcherId);
    if (siblings) siblings.push(agent);
    else childrenOf.set(dispatcherId, [agent]);
  }
  const placed = new Set<string>();
  const buildNode = (agent: AgentSnapshot): DispatchNode => {
    placed.add(agent.id);
    const children = (childrenOf.get(agent.id) ?? []).filter((child) => !placed.has(child.id)).map(buildNode);
    const descendantsWorking = children.some((child) => WORKING_STATUSES.has(child.status));
    return { agent, status: dispatchStatus(agent, { running: isRunning(agent), descendantsWorking }), children };
  };

  const groups: DispatchGroup[] = [];
  for (const agent of visible) {
    if (isDispatchedAgent(agent) || !childrenOf.has(agent.id)) continue;
    const master = buildNode(agent);
    const summary = summarize(master.children);
    if (agent.archived && summary.working === 0 && !options?.includeArchived) continue;
    groups.push({ master, children: master.children, summary });
  }

  // 剩下的子会话找不到主会话：上级不在其中的作为根，成环的依次断开
  const rest = visible.filter((agent) => !agent.archived && !placed.has(agent.id) && isDispatchedAgent(agent));
  const restIds = new Set(rest.map((agent) => agent.id));
  const roots = rest.filter((agent) => {
    const dispatcherId = liveDispatcherId(agent, byId);
    return dispatcherId === undefined || !restIds.has(dispatcherId);
  });
  const orphans: DispatchNode[] = [];
  for (const agent of [...roots, ...rest]) {
    if (!placed.has(agent.id)) orphans.push(buildNode(agent));
  }
  if (orphans.length > 0) {
    groups.push({ master: null, children: orphans, summary: summarize(orphans) });
  }
  return groups;
}
