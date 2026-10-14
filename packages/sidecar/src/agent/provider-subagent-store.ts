// Derived from paseo packages/server/src/server/agent/provider-subagents/store.ts (Apache-2.0); modified for AgentDeck
// 改动：时间为毫秒时间戳；时间线改为简单的内存数组（每个子代理最多保留 MAX_TIMELINE_ROWS 行），
// 分页只支持 tail / before / after，不做 paseo 的投影窗口与 epoch。
import type {
  AgentProviderId,
  ProviderSubagentDescriptor,
  ProviderSubagentTimelineRow,
  ProviderSubagentUpdate,
} from "@agentdeck/protocol";

import { limitTimelineItem } from "./timeline-limits.js";
import type { ProviderSubagentInputEvent } from "./types.js";

/** 每个子代理时间线保留的最大行数，超出丢最旧的 */
export const MAX_SUBAGENT_TIMELINE_ROWS = 2000;
/** 每个父会话的全部子代理时间线合计字节数上限（design.md 4.11），超出从最早的行丢弃 */
export const MAX_SUBAGENT_TIMELINE_BYTES = 8 * 1024 * 1024;
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
  /** 与 rows 一一对应的字节数（截断后 JSON 长度） */
  sizes: number[];
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

  /** 各父会话的子代理时间线合计字节数 */
  private readonly parentBytes = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxParentBytes: number = MAX_SUBAGENT_TIMELINE_BYTES,
  ) {}

  apply(
    parentAgentId: string,
    provider: AgentProviderId,
    event: ProviderSubagentInputEvent,
  ): ProviderSubagentUpdate {
    const key = storeKey(parentAgentId, event.id);
    if (event.type === "remove") {
      this.descriptors.delete(key);
      this.dropTimeline(parentAgentId, key);
      return { kind: "remove", agentId: parentAgentId, subagentId: event.id };
    }

    if (event.type === "timeline") {
      const timeline = this.ensureTimeline(key);
      const row: ProviderSubagentTimelineRow = {
        seq: timeline.nextSeq,
        timestamp: event.timestamp ?? this.now(),
        // 单行大小限制：文本截断、图片占位（design.md 4.11 / 5.3）
        item: limitTimelineItem(event.item),
      };
      const size = JSON.stringify(row).length;
      timeline.nextSeq += 1;
      timeline.rows.push(row);
      timeline.sizes.push(size);
      this.addBytes(parentAgentId, size);
      if (timeline.rows.length > MAX_SUBAGENT_TIMELINE_ROWS) {
        const excess = timeline.rows.length - MAX_SUBAGENT_TIMELINE_ROWS;
        timeline.rows.splice(0, excess);
        this.addBytes(
          parentAgentId,
          -timeline.sizes.splice(0, excess).reduce((sum, bytes) => sum + bytes, 0),
        );
      }
      this.enforceParentBytes(parentAgentId);
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
    this.parentBytes.delete(parentAgentId);
    return updates;
  }

  /** 全部子代理时间线的行数与字节数（内存采样用） */
  stats(): { rows: number; bytes: number } {
    let rows = 0;
    for (const timeline of this.timelines.values()) rows += timeline.rows.length;
    let bytes = 0;
    for (const value of this.parentBytes.values()) bytes += value;
    return { rows, bytes };
  }

  /** 某父会话的子代理时间线合计字节数 */
  bytesOf(parentAgentId: string): number {
    return this.parentBytes.get(parentAgentId) ?? 0;
  }

  private addBytes(parentAgentId: string, delta: number): void {
    const next = Math.max(0, (this.parentBytes.get(parentAgentId) ?? 0) + delta);
    if (next === 0) this.parentBytes.delete(parentAgentId);
    else this.parentBytes.set(parentAgentId, next);
  }

  private dropTimeline(parentAgentId: string, key: string): void {
    const timeline = this.timelines.get(key);
    if (!timeline) return;
    this.addBytes(
      parentAgentId,
      -timeline.sizes.reduce((sum, bytes) => sum + bytes, 0),
    );
    this.timelines.delete(key);
  }

  /** 超过父会话字节上限时，跨其全部子代理时间线从最早的行开始丢弃（至少保留最后一行） */
  private enforceParentBytes(parentAgentId: string): void {
    if (this.bytesOf(parentAgentId) <= this.maxParentBytes) return;
    const prefix = `${parentAgentId}\0`;
    const owned = [...this.timelines.entries()].filter(([key]) => key.startsWith(prefix));
    while (this.bytesOf(parentAgentId) > this.maxParentBytes) {
      let oldest: TimelineState | null = null;
      for (const [, timeline] of owned) {
        if (timeline.rows.length === 0) continue;
        if (
          oldest === null ||
          isOlder(timeline.rows[0]!, oldest.rows[0]!)
        ) {
          oldest = timeline;
        }
      }
      const total = owned.reduce((sum, [, timeline]) => sum + timeline.rows.length, 0);
      if (oldest === null || total <= 1) return;
      oldest.rows.shift();
      this.addBytes(parentAgentId, -oldest.sizes.shift()!);
    }
  }

  private ensureTimeline(key: string): TimelineState {
    let timeline = this.timelines.get(key);
    if (!timeline) {
      timeline = { rows: [], sizes: [], nextSeq: 1 };
      this.timelines.set(key, timeline);
    }
    return timeline;
  }
}

function isOlder(left: ProviderSubagentTimelineRow, right: ProviderSubagentTimelineRow): boolean {
  return left.timestamp !== right.timestamp
    ? left.timestamp < right.timestamp
    : left.seq < right.seq;
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
