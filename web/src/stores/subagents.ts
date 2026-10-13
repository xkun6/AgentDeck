// provider 子代理（design.md 4.11）的前端状态：描述按会话存放，时间线按需加载并缓存。
// 数据来源：进入会话时 agent.subagents.list 拉一次（重连后重拉），之后由 agent.subagents.update 增量维护；
// 时间线在打开子代理面板时用 agent.subagents.timeline 拉 tail，之后实时行按 seq 追加去重。
import { atom } from "jotai";
import type {
  ProviderSubagentDescriptor,
  ProviderSubagentTimelineRow,
  ProviderSubagentUpdate,
} from "@agentdeck/protocol";

export interface SubagentTimelineCache {
  /** 按 seq 升序、去重 */
  rows: ProviderSubagentTimelineRow[];
  hasOlder: boolean;
  /** 已拉过 tail；未加载时实时 timeline 行直接忽略（打开面板时会重新拉 tail） */
  loaded: boolean;
}

export type SubagentsByAgent = Record<string, Record<string, ProviderSubagentDescriptor>>;

export const subagentsByAgentAtom = atom<SubagentsByAgent>({});
export const subagentTimelinesAtom = atom<Record<string, SubagentTimelineCache>>({});

export function subagentTimelineKey(agentId: string, subagentId: string): string {
  return `${agentId}\0${subagentId}`;
}

/** 合并两组行：按 seq 去重（后者覆盖前者）并升序排列。 */
export function mergeTimelineRows(
  current: ProviderSubagentTimelineRow[],
  incoming: ProviderSubagentTimelineRow[],
): ProviderSubagentTimelineRow[] {
  if (incoming.length === 0) return current;
  const bySeq = new Map<number, ProviderSubagentTimelineRow>();
  for (const row of current) bySeq.set(row.seq, row);
  for (const row of incoming) bySeq.set(row.seq, row);
  return Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
}

/** 应用一条 agent.subagents.update 通知。 */
export const applySubagentUpdateAtom = atom(null, (_get, set, update: ProviderSubagentUpdate) => {
  if (update.kind === "upsert") {
    set(subagentsByAgentAtom, (state) => ({
      ...state,
      [update.agentId]: { ...(state[update.agentId] ?? {}), [update.subagent.id]: update.subagent },
    }));
    return;
  }
  const key = subagentTimelineKey(update.agentId, update.subagentId);
  if (update.kind === "timeline") {
    set(subagentTimelinesAtom, (state) => {
      const cache = state[key];
      if (!cache?.loaded) return state;
      if (cache.rows.some((row) => row.seq === update.row.seq)) return state;
      return { ...state, [key]: { ...cache, rows: mergeTimelineRows(cache.rows, [update.row]) } };
    });
    return;
  }
  set(subagentsByAgentAtom, (state) => {
    const current = state[update.agentId];
    if (!current || !(update.subagentId in current)) return state;
    const { [update.subagentId]: _removed, ...rest } = current;
    return { ...state, [update.agentId]: rest };
  });
  set(subagentTimelinesAtom, (state) => {
    if (!(key in state)) return state;
    const { [key]: _removed, ...rest } = state;
    return rest;
  });
});

/** 用一次完整的 agent.subagents.list 替换该会话的子代理描述。 */
export const replaceSubagentsAtom = atom(
  null,
  (_get, set, params: { agentId: string; subagents: ProviderSubagentDescriptor[] }) => {
    set(subagentsByAgentAtom, (state) => ({
      ...state,
      [params.agentId]: Object.fromEntries(params.subagents.map((subagent) => [subagent.id, subagent])),
    }));
  },
);

/** 写入一次时间线请求的结果：tail 替换整段，before 向前合并。 */
export const storeSubagentTimelineAtom = atom(
  null,
  (
    _get,
    set,
    params: {
      agentId: string;
      subagentId: string;
      rows: ProviderSubagentTimelineRow[];
      hasOlder: boolean;
      mode: "tail" | "before";
    },
  ) => {
    const key = subagentTimelineKey(params.agentId, params.subagentId);
    set(subagentTimelinesAtom, (state) => {
      const cache = state[key];
      if (params.mode === "tail") {
        // tail 之后、请求返回之前到达的实时行保留（seq 更大）
        const kept = cache?.loaded ? cache.rows : [];
        return {
          ...state,
          [key]: { rows: mergeTimelineRows(params.rows, kept), hasOlder: params.hasOlder, loaded: true },
        };
      }
      return {
        ...state,
        [key]: {
          rows: mergeTimelineRows(cache?.rows ?? [], params.rows),
          hasOlder: params.hasOlder,
          loaded: true,
        },
      };
    });
  },
);

/** 会话被删除：清掉它的子代理与时间线缓存。 */
export const removeAgentSubagentsAtom = atom(null, (_get, set, agentId: string) => {
  set(subagentsByAgentAtom, (state) => {
    if (!(agentId in state)) return state;
    const { [agentId]: _removed, ...rest } = state;
    return rest;
  });
  const prefix = `${agentId}\0`;
  set(subagentTimelinesAtom, (state) => {
    const keys = Object.keys(state).filter((key) => key.startsWith(prefix));
    if (keys.length === 0) return state;
    const next = { ...state };
    for (const key of keys) delete next[key];
    return next;
  });
});
