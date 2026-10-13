import { describe, expect, test } from "vitest";

import {
  MAX_SUBAGENT_TIMELINE_ROWS,
  ProviderSubagentStore,
} from "../src/agent/provider-subagent-store.js";

function createStore() {
  let now = 1_000;
  const store = new ProviderSubagentStore(() => now);
  return {
    store,
    tick: (ms = 1) => {
      now += ms;
    },
  };
}

describe("ProviderSubagentStore", () => {
  test("upsert：省略字段保留原值，显式 null 清空；createdAt 不变、updatedAt 更新", () => {
    const { store, tick } = createStore();
    const first = store.apply("agent-1", "claude", {
      type: "upsert",
      id: "sub-1",
      title: "Explore",
      description: "读文件",
      toolCallId: "toolu_1",
      subtitle: "Explore",
    });
    expect(first).toEqual({
      kind: "upsert",
      agentId: "agent-1",
      subagent: {
        id: "sub-1",
        parentAgentId: "agent-1",
        parentSubagentId: null,
        provider: "claude",
        title: "Explore",
        description: "读文件",
        status: "running",
        createdAt: 1_000,
        updatedAt: 1_000,
        toolCallId: "toolu_1",
        cwd: null,
        subtitle: "Explore",
      },
    });

    tick(5);
    // 只带 status：其它字段保留
    store.apply("agent-1", "claude", { type: "upsert", id: "sub-1", status: "completed" });
    expect(store.get("agent-1", "sub-1")).toMatchObject({
      title: "Explore",
      description: "读文件",
      status: "completed",
      createdAt: 1_000,
      updatedAt: 1_005,
      subtitle: "Explore",
    });

    // 显式 null 清空
    store.apply("agent-1", "claude", { type: "upsert", id: "sub-1", description: null, subtitle: null });
    expect(store.get("agent-1", "sub-1")).toMatchObject({ title: "Explore", description: null, subtitle: null });
  });

  test("同一子代理 id 在不同父会话下互不影响；list 按 createdAt 升序", () => {
    const { store, tick } = createStore();
    store.apply("agent-1", "codex", { type: "upsert", id: "b" });
    tick();
    store.apply("agent-1", "codex", { type: "upsert", id: "a", parentSubagentId: "b" });
    store.apply("agent-2", "codex", { type: "upsert", id: "a", title: "另一个" });
    expect(store.list("agent-1").map((s) => [s.id, s.parentSubagentId])).toEqual([
      ["b", null],
      ["a", "b"],
    ]);
    expect(store.list("agent-2")).toHaveLength(1);
    expect(store.get("agent-1", "a")?.title).toBeNull();
  });

  test("时间线：seq 递增，tail / before / after 分页与 hasOlder / hasNewer", () => {
    const { store } = createStore();
    for (let i = 1; i <= 5; i += 1) {
      store.apply("p", "claude", { type: "timeline", id: "s", item: { type: "assistant_message", text: `t${i}` } });
    }
    const tail = store.fetchTimeline("p", "s", { limit: 2 });
    expect(tail.rows.map((r) => r.seq)).toEqual([4, 5]);
    expect(tail).toMatchObject({ hasOlder: true, hasNewer: false });

    const before = store.fetchTimeline("p", "s", { direction: "before", cursorSeq: 4, limit: 2 });
    expect(before.rows.map((r) => r.seq)).toEqual([2, 3]);
    expect(before).toMatchObject({ hasOlder: true, hasNewer: true });

    const after = store.fetchTimeline("p", "s", { direction: "after", cursorSeq: 1, limit: 2 });
    expect(after.rows.map((r) => r.seq)).toEqual([2, 3]);
    expect(after).toMatchObject({ hasOlder: true, hasNewer: true });

    expect(store.fetchTimeline("p", "missing")).toEqual({ rows: [], hasOlder: false, hasNewer: false });
  });

  test("时间线超过上限丢最旧的行", () => {
    const { store } = createStore();
    for (let i = 0; i < MAX_SUBAGENT_TIMELINE_ROWS + 3; i += 1) {
      store.apply("p", "claude", { type: "timeline", id: "s", item: { type: "reasoning", text: "x" } });
    }
    const page = store.fetchTimeline("p", "s", { direction: "after", cursorSeq: 0, limit: 1 });
    expect(page.rows[0]?.seq).toBe(4);
    expect(page.hasOlder).toBe(false);
  });

  test("remove 与 deleteParent 清除描述与时间线并返回 remove 更新", () => {
    const { store } = createStore();
    store.apply("p", "claude", { type: "upsert", id: "s1" });
    store.apply("p", "claude", { type: "timeline", id: "s1", item: { type: "reasoning", text: "x" } });
    store.apply("p", "claude", { type: "upsert", id: "s2" });
    store.apply("q", "claude", { type: "upsert", id: "s1" });

    expect(store.apply("p", "claude", { type: "remove", id: "s2" })).toEqual({
      kind: "remove",
      agentId: "p",
      subagentId: "s2",
    });
    expect(store.deleteParent("p")).toEqual([{ kind: "remove", agentId: "p", subagentId: "s1" }]);
    expect(store.list("p")).toEqual([]);
    expect(store.fetchTimeline("p", "s1").rows).toEqual([]);
    expect(store.list("q")).toHaveLength(1);
  });
});
