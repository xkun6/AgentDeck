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

  test("大行：文本截断、图片替换为占位文本，广播与分页返回的都是截断后的内容", () => {
    const { store } = createStore();
    const update = store.apply("p", "claude", {
      type: "timeline",
      id: "s",
      item: {
        type: "tool_call",
        callId: "t1",
        name: "mcp__browser__shot",
        status: "completed",
        detail: {
          type: "unknown",
          input: {},
          output: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(409_600) } },
            { type: "text", text: "T".repeat(300_000) },
          ],
        },
      },
    });
    const json = JSON.stringify(update);
    expect(json.length).toBeLessThan(70_000);
    expect(json).toContain("[图片 约 300 KB，已省略]");
    expect(json).toContain("已截断");
    expect(json).not.toContain("AAAAAAAA");
    expect(JSON.stringify(store.fetchTimeline("p", "s").rows)).toBe(JSON.stringify([
      (update as { row: unknown }).row,
    ]));
    expect(store.bytesOf("p")).toBe(JSON.stringify((update as { row: unknown }).row).length);
    expect(store.stats()).toEqual({ rows: 1, bytes: store.bytesOf("p") });
  });

  test("父会话字节总量超上限时，跨子代理从最早的行丢弃，且保留最新一行", () => {
    let now = 1_000;
    const store = new ProviderSubagentStore(() => now, 2_500);
    const row = (text: string) => ({ type: "reasoning" as const, text });
    // 每行约 100 字节 + 文本
    const add = (id: string, text: string) => {
      now += 1;
      store.apply("p", "claude", { type: "timeline", id, item: row(text) });
    };
    add("a", "a1".padEnd(900, "x"));
    add("b", "b1".padEnd(900, "x"));
    add("a", "a2".padEnd(900, "x")); // 触发超限：丢最早的 a1
    const texts = (id: string) =>
      store.fetchTimeline("p", id).rows.map((r) => (r.item as { text: string }).text.slice(0, 2));
    expect(texts("a")).toEqual(["a2"]);
    expect(texts("b")).toEqual(["b1"]);
    expect(store.bytesOf("p")).toBeLessThanOrEqual(2_500);
    // seq 不回退，hasOlder 以实际保留为准
    expect(store.fetchTimeline("p", "a").rows[0]?.seq).toBe(2);
    expect(store.fetchTimeline("p", "a").hasOlder).toBe(false);

    // 另一个父会话互不影响
    store.apply("q", "claude", { type: "timeline", id: "a", item: row("q1") });
    expect(store.fetchTimeline("q", "a").rows).toHaveLength(1);

    // 单行本身就超过上限：仍保留最新一行
    const tiny = new ProviderSubagentStore(() => now, 10);
    tiny.apply("p", "claude", { type: "timeline", id: "a", item: row("x".repeat(500)) });
    tiny.apply("p", "claude", { type: "timeline", id: "a", item: row("y".repeat(500)) });
    expect(tiny.fetchTimeline("p", "a").rows).toHaveLength(1);
    expect((tiny.fetchTimeline("p", "a").rows[0]!.item as { text: string }).text[0]).toBe("y");
  });

  test("字节计数在行数上限丢弃、remove、deleteParent 后保持一致", () => {
    const { store } = createStore();
    for (let i = 0; i < MAX_SUBAGENT_TIMELINE_ROWS + 5; i++) {
      store.apply("p", "claude", { type: "timeline", id: "s", item: { type: "reasoning", text: "x" } });
    }
    const rows = store.fetchTimeline("p", "s", { limit: 1000 }).rows;
    expect(store.stats().rows).toBe(MAX_SUBAGENT_TIMELINE_ROWS);
    expect(store.bytesOf("p")).toBeGreaterThan(rows.length);
    store.apply("p", "claude", { type: "remove", id: "s" });
    expect(store.bytesOf("p")).toBe(0);
    store.apply("p", "claude", { type: "timeline", id: "s2", item: { type: "reasoning", text: "x" } });
    store.deleteParent("p");
    expect(store.stats()).toEqual({ rows: 0, bytes: 0 });
  });
});
