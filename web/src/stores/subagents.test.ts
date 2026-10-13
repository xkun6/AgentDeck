import { describe, expect, it } from "vitest";
import { createStore } from "jotai";
import type { ProviderSubagentDescriptor, ProviderSubagentTimelineRow } from "@agentdeck/protocol";
import {
  applySubagentUpdateAtom,
  removeAgentSubagentsAtom,
  replaceSubagentsAtom,
  storeSubagentTimelineAtom,
  subagentTimelineKey,
  subagentTimelinesAtom,
  subagentsByAgentAtom,
} from "./subagents";

function sub(id: string, status: ProviderSubagentDescriptor["status"] = "running"): ProviderSubagentDescriptor {
  return {
    id,
    parentAgentId: "a1",
    parentSubagentId: null,
    provider: "claude",
    title: "Explore",
    description: null,
    status,
    createdAt: 1,
    updatedAt: 1,
    toolCallId: id,
    cwd: null,
    subtitle: null,
  };
}

function row(seq: number, text = `r${seq}`): ProviderSubagentTimelineRow {
  return { seq, timestamp: seq, item: { type: "assistant_message", text } };
}

describe("stores/subagents", () => {
  it("upsert / remove 维护描述；list 替换整表", () => {
    const store = createStore();
    store.set(applySubagentUpdateAtom, { kind: "upsert", agentId: "a1", subagent: sub("s1") });
    store.set(applySubagentUpdateAtom, { kind: "upsert", agentId: "a1", subagent: sub("s1", "completed") });
    store.set(applySubagentUpdateAtom, { kind: "upsert", agentId: "a1", subagent: sub("s2") });
    expect(store.get(subagentsByAgentAtom).a1!.s1!.status).toBe("completed");
    store.set(applySubagentUpdateAtom, { kind: "remove", agentId: "a1", subagentId: "s2" });
    expect(Object.keys(store.get(subagentsByAgentAtom).a1!)).toEqual(["s1"]);
    store.set(replaceSubagentsAtom, { agentId: "a1", subagents: [sub("s9")] });
    expect(Object.keys(store.get(subagentsByAgentAtom).a1!)).toEqual(["s9"]);
  });

  it("时间线未加载时忽略实时行；加载后按 seq 去重追加，before 向前合并", () => {
    const store = createStore();
    const key = subagentTimelineKey("a1", "s1");
    store.set(applySubagentUpdateAtom, { kind: "timeline", agentId: "a1", subagentId: "s1", row: row(5) });
    expect(store.get(subagentTimelinesAtom)[key]).toBeUndefined();

    store.set(storeSubagentTimelineAtom, { agentId: "a1", subagentId: "s1", rows: [row(3), row(4)], hasOlder: true, mode: "tail" });
    store.set(applySubagentUpdateAtom, { kind: "timeline", agentId: "a1", subagentId: "s1", row: row(5) });
    store.set(applySubagentUpdateAtom, { kind: "timeline", agentId: "a1", subagentId: "s1", row: row(5, "dup") });
    store.set(storeSubagentTimelineAtom, { agentId: "a1", subagentId: "s1", rows: [row(1), row(2)], hasOlder: false, mode: "before" });
    const cache = store.get(subagentTimelinesAtom)[key]!;
    expect(cache.rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(cache.rows[4]!.item).toEqual({ type: "assistant_message", text: "r5" });
    expect(cache.hasOlder).toBe(false);
    expect(cache.loaded).toBe(true);
  });

  it("会话删除时清掉描述与时间线缓存", () => {
    const store = createStore();
    store.set(applySubagentUpdateAtom, { kind: "upsert", agentId: "a1", subagent: sub("s1") });
    store.set(storeSubagentTimelineAtom, { agentId: "a1", subagentId: "s1", rows: [row(1)], hasOlder: false, mode: "tail" });
    store.set(storeSubagentTimelineAtom, { agentId: "a2", subagentId: "s1", rows: [row(1)], hasOlder: false, mode: "tail" });
    store.set(removeAgentSubagentsAtom, "a1");
    expect(store.get(subagentsByAgentAtom).a1).toBeUndefined();
    expect(Object.keys(store.get(subagentTimelinesAtom))).toEqual([subagentTimelineKey("a2", "s1")]);
  });
});
