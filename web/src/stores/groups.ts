import { atom } from "jotai";
import type { AgentGroup } from "@agentdeck/protocol";

/** sidecar 并行协作组（来自 group.list 与 group.changed / group.removed 通知，design.md 4.27）。 */
export interface GroupsState {
  groups: Record<string, AgentGroup>;
  /** 是否已拉到过一次完整列表（协作视图据此区分「还没加载」与「已被删除」） */
  loaded: boolean;
}

export const groupsStateAtom = atom<GroupsState>({ groups: {}, loaded: false });

/** 按创建时间倒序 */
export const groupListAtom = atom((get) =>
  Object.values(get(groupsStateAtom).groups).sort((a, b) => b.createdAt - a.createdAt),
);

export const replaceGroupsAtom = atom(null, (_get, set, groups: AgentGroup[]) => {
  set(groupsStateAtom, { groups: Object.fromEntries(groups.map((group) => [group.id, group])), loaded: true });
});

export const upsertGroupAtom = atom(null, (_get, set, group: AgentGroup) => {
  set(groupsStateAtom, (state) => ({ ...state, groups: { ...state.groups, [group.id]: group } }));
});

export const removeGroupAtom = atom(null, (_get, set, groupId: string) => {
  set(groupsStateAtom, (state) => {
    if (!(groupId in state.groups)) return state;
    const { [groupId]: _removed, ...rest } = state.groups;
    return { ...state, groups: rest };
  });
});
