// 派单分组（design.md 4.26）：侧栏徽标、对话页入口与派单页共用。
import { useMemo } from "react";
import { useAtomValue } from "jotai";
import { isAgentRunning } from "@/lib/agent-session-display";
import { buildDispatchGroups, type DispatchGroup } from "@/lib/dispatch";
import { agentListAtom } from "@/stores/agents";
import { chatRuntimeBySessionAtom } from "@/stores/chat";

export function useDispatchGroups(options?: { includeArchived?: boolean }): DispatchGroup[] {
  const includeArchived = options?.includeArchived === true;
  const agents = useAtomValue(agentListAtom);
  const runtimes = useAtomValue(chatRuntimeBySessionAtom);
  return useMemo(
    () => buildDispatchGroups(agents, (agent) => isAgentRunning(agent, runtimes[agent.id]), { includeArchived }),
    [agents, includeArchived, runtimes],
  );
}
