// 会话列表过滤：隐藏 isHiddenAgent 的会话；默认隐藏归档（可切换显示）；置顶在前，组内保持 agent.list 的 updatedAt 倒序。
import type { AgentSnapshot } from "@agentdeck/protocol";
import { isHiddenAgent } from "@/lib/session-list";

export function visibleSessions<T extends Pick<AgentSnapshot, "pinned" | "archived" | "origin">>(
  agents: readonly T[],
  showArchived: boolean,
): T[] {
  const visible = agents.filter((agent) => !isHiddenAgent(agent) && (showArchived || !agent.archived));
  return [...visible.filter((agent) => agent.pinned), ...visible.filter((agent) => !agent.pinned)];
}

export function archivedCount(agents: readonly Pick<AgentSnapshot, "archived" | "origin">[]): number {
  return agents.filter((agent) => !isHiddenAgent(agent) && agent.archived).length;
}
