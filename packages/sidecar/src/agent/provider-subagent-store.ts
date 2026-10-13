// Derived from paseo packages/server/src/server/agent/provider-subagents/store.ts (Apache-2.0); modified for AgentDeck
// 改动：时间为毫秒时间戳；时间线改为简单的内存数组（每个子代理最多保留 MAX_TIMELINE_ROWS 行），
// 分页只支持 tail / before / after，不做 paseo 的投影窗口与 epoch。
import type {
  AgentProviderId,
  ProviderSubagentDescriptor,
  ProviderSubagentTimelineRow,
  ProviderSubagentUpdate,
} from "@agentdeck/protocol";

import type { ProviderSubagentInputEvent } from "./types.js";

/** 每个子代理时间线保留的最大行数，超出丢最旧的 */
export const MAX_SUBAGENT_TIMELINE_ROWS = 2000;
export const DEFAULT_SUBAGENT_TIMELINE_LIMIT = 200;

export interface SubagentTimelineQuery {
  direction?: "tail" | "before" | "after";
  cursorSeq?: number;
  limit?: number;
}

export interface SubagentTimelinePage {
  rows: ProviderSubagentTimelineRow[];
  hasOlder: boolean;
  hasNewer: boolean;
}

interface TimelineState {
  rows: ProviderSubagentTimelineRow[];
  nextSeq: number;
}

function storeKey(parentAgentId: string, subagentId: string): string {
  return `${parentAgentId}\0${subagentId}`;
}

/** 省略 = 保留原值，显式 null = 清空（provider 增量观察这些字段，部分 upsert 不能抹掉它没提到的字段） */
function stickyField<T>(next: T | undefined, previous: T | null | undefined): T | null {
  return next === undefined ? (previous ?? null) : next;
}

export class ProviderSubagentStore {
  private readonly descriptors = new Map<string, ProviderSubagentDescriptor>();
  private readonly timelines = new Map<string, TimelineState>();

  constructor(private readonly now: () => number = Date.now) {}

  apply(
    parentAgentId: string,
    provider: AgentProviderId,
    event: ProviderSubagentInputEvent,
  ): ProviderSubagentUpdate {
    const key = storeKey(parentAgentId, event.id);
    if (event.type === "remove") {
      this.descriptors.delete(key);
      this.timelines.delete(key);
      return { kind: "remove", agentId: parentAgentId, subagentId: event.id };
    }

    if (event.type === "timeline") {
      const timeline = this.ensureTimeline(key);
      const row: ProviderSubagentTimelineRow = {
        seq: timeline.nextSeq,
        timestamp: event.timestamp ?? this.now(),
        item: event.item,
      };
      timeline.nextSeq += 1;
      timeline.rows.push(row);
      if (timeline.rows.length > MAX_SUBAGENT_TIMELINE_ROWS) {
        timeline.rows.splice(0, timeline.rows.length - MAX_SUBAGENT_TIMELINE_ROWS);
      }
      return { kind: "timeline", agentId: parentAgentId, subagentId: event.id, row };
    }

    const previous = this.descriptors.get(key);
    this.ensureTimeline(key);
    const timestamp = event.timestamp ?? this.now();
    const subagent: ProviderSubagentDescriptor = {
      id: event.id,
      parentAgentId,
      parentSubagentId: stickyField(event.parentSubagentId, previous?.parentSubagentId),
      provider,
      title: stickyField(event.title, previous?.title),
      description: stickyField(event.description, previous?.description),
      status: event.status ?? previous?.status ?? "running",
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
      toolCallId: stickyField(event.toolCallId, previous?.toolCallId),
      cwd: stickyField(event.cwd, previous?.cwd),
      subtitle: stickyField(event.subtitle, previous?.subtitle),
    };
    this.descriptors.set(key, subagent);
    return { kind: "upsert", agentId: parentAgentId, subagent: { ...subagent } };
  }

  /** 该会话全部层级的子代理，按 createdAt 升序 */
  list(parentAgentId: string): ProviderSubagentDescriptor[] {
    return [...this.descriptors.values()]
      .filter((subagent) => subagent.parentAgentId === parentAgentId)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((subagent) => ({ ...subagent }));
  }

  get(parentAgentId: string, subagentId: string): ProviderSubagentDescriptor | null {
    const subagent = this.descriptors.get(storeKey(parentAgentId, subagentId));
    return subagent ? { ...subagent } : null;
  }

  fetchTimeline(
    parentAgentId: string,
    subagentId: string,
    query: SubagentTimelineQuery = {},
  ): SubagentTimelinePage {
    const rows = this.timelines.get(storeKey(parentAgentId, subagentId))?.rows ?? [];
    const limit = Math.max(1, Math.floor(query.limit ?? DEFAULT_SUBAGENT_TIMELINE_LIMIT));
    let start: number;
    let end: number;
    if (query.direction === "before" && query.cursorSeq !== undefined) {
      const cursor = query.cursorSeq;
      end = countWhile(rows, (row) => row.seq < cursor);
      start = Math.max(0, end - limit);
    } else if (query.direction === "after" && query.cursorSeq !== undefined) {
      const cursor = query.cursorSeq;
      start = countWhile(rows, (row) => row.seq <= cursor);
      end = Math.min(rows.length, start + limit);
    } else {
      end = rows.length;
      start = Math.max(0, end - limit);
    }
    return {
      rows: rows.slice(start, end),
      hasOlder: start > 0,
      hasNewer: end < rows.length,
    };
  }

  /** 清空某会话的全部子代理，返回需要广播的 remove 更新 */
  deleteParent(parentAgentId: string): ProviderSubagentUpdate[] {
    const updates: ProviderSubagentUpdate[] = [];
    const prefix = `${parentAgentId}\0`;
    for (const key of [...this.descriptors.keys()]) {
      if (!key.startsWith(prefix)) continue;
      const subagent = this.descriptors.get(key)!;
      this.descriptors.delete(key);
      updates.push({ kind: "remove", agentId: parentAgentId, subagentId: subagent.id });
    }
    for (const key of [...this.timelines.keys()]) {
      if (key.startsWith(prefix)) this.timelines.delete(key);
    }
    return updates;
  }

  private ensureTimeline(key: string): TimelineState {
    let timeline = this.timelines.get(key);
    if (!timeline) {
      timeline = { rows: [], nextSeq: 1 };
      this.timelines.set(key, timeline);
    }
    return timeline;
  }
}

/** rows 按 seq 升序：返回满足 predicate 的前缀长度 */
function countWhile(
  rows: readonly ProviderSubagentTimelineRow[],
  predicate: (row: ProviderSubagentTimelineRow) => boolean,
): number {
  let count = 0;
  while (count < rows.length && predicate(rows[count]!)) count += 1;
  return count;
}
