import { atom } from "jotai";
import type { AgentSnapshot } from "@agentdeck/protocol";
import type { SidecarConnectionState } from "@/lib/sidecar-client";

/**
 * sidecar 注册表中的 agent 快照（来自 agent.list 与 agent.state 通知）。
 * sidecar 会把会话持久化到磁盘（design.md 4.5），重启后的历史会话以 dormant / closed 状态出现在这里。
 */
export const agentSnapshotsAtom = atom<Record<string, AgentSnapshot>>({});

/** 是否已从 sidecar 拉到过一次完整列表。 */
export const agentListLoadedAtom = atom(false);

/** 与 sidecar 的连接状态。 */
export const sidecarConnectionAtom = atom<SidecarConnectionState>("idle");

/** 最近一次被删除的 agent（agent.removed）；nonce 让订阅方能区分先后两次删除。 */
export const lastRemovedAgentAtom = atom<{ agentId: string; nonce: number } | null>(null);

/** 按更新时间倒序的 agent 列表（与 agent.list 的顺序一致）。 */
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

/** 用一次完整的 agent.list 替换快照：列表即 sidecar 注册表全集（含已持久化的 dormant / closed 会话）。 */
export const replaceAgentSnapshotsAtom = atom(null, (_get, set, agents: AgentSnapshot[]) => {
  set(agentSnapshotsAtom, Object.fromEntries(agents.map((agent) => [agent.id, agent])));
  set(agentListLoadedAtom, true);
});
