import { atom } from "jotai";
import type { AgentSnapshot } from "@agentdeck/protocol";
import type { SidecarConnectionState } from "@/lib/sidecar-client";

/** sidecar 当前进程内的 agent 快照（来自 agent.list 与 agent.state 通知）。 */
export const agentSnapshotsAtom = atom<Record<string, AgentSnapshot>>({});

/** 是否已从 sidecar 拉到过一次完整列表。 */
export const agentListLoadedAtom = atom(false);

/** 与 sidecar 的连接状态。 */
export const sidecarConnectionAtom = atom<SidecarConnectionState>("idle");

/** 按更新时间倒序的 agent 列表。 */
export const agentListAtom = atom((get) =>
  Object.values(get(agentSnapshotsAtom)).sort((a, b) => b.updatedAt - a.updatedAt),
);

export const upsertAgentSnapshotAtom = atom(null, (_get, set, agent: AgentSnapshot) => {
  set(agentSnapshotsAtom, (state) => {
    const current = state[agent.id];
    if (current && current.updatedAt > agent.updatedAt) return state;
    return { ...state, [agent.id]: agent };
  });
});

/** 用一次完整的 agent.list 替换快照（sidecar 不持久化，列表外的 agent 已不存在）。 */
export const replaceAgentSnapshotsAtom = atom(null, (_get, set, agents: AgentSnapshot[]) => {
  set(agentSnapshotsAtom, Object.fromEntries(agents.map((agent) => [agent.id, agent])));
  set(agentListLoadedAtom, true);
});
