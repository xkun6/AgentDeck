// 会话列表过滤：隐藏 isHiddenAgent 的会话；默认隐藏归档（可切换显示）；派单出去的子会话只在派单页（design.md 4.26）；
// 置顶在前，组内保持 agent.list 的 updatedAt 倒序。
import type { AgentSnapshot } from "@agentdeck/protocol";
import { isUnderArchivedMaster } from "@/lib/dispatch";
import { isDispatchedAgent, isHiddenAgent } from "@/lib/session-list";

type FilterFields = Pick<AgentSnapshot, "id" | "archived" | "origin" | "parentAgentId" | "reportToAgentId">;

/**
 * 属于「显示已归档」的会话。手机端没有历史页，派单页又不列已归档的子会话和已归档主会话名下（含多层）的子会话，
 * 这里是它们唯一的入口。
 */
function isInArchiveView<T extends FilterFields>(agent: T, byId: ReadonlyMap<string, T>): boolean {
  return agent.archived === true || (isDispatchedAgent(agent) && isUnderArchivedMaster(agent, byId));
}

export function visibleSessions<T extends FilterFields & Pick<AgentSnapshot, "pinned">>(
  agents: readonly T[],
  showArchived: boolean,
): T[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const visible = agents.filter((agent) => {
    if (isHiddenAgent(agent)) return false;
    if (isDispatchedAgent(agent)) return showArchived && isInArchiveView(agent, byId);
    return showArchived || !agent.archived;
  });
  return [...visible.filter((agent) => agent.pinned), ...visible.filter((agent) => !agent.pinned)];
}

export function archivedCount(agents: readonly FilterFields[]): number {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return agents.filter((agent) => !isHiddenAgent(agent) && isInArchiveView(agent, byId)).length;
}
