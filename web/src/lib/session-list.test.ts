import { describe, expect, it } from "vitest";
import type { AgentSnapshot } from "@agentdeck/protocol";
import { batchSummary, inHistoryView, runBatch, sidebarSessions, splitPinned } from "./session-list";

type Flags = Pick<AgentSnapshot, "pinned" | "archived"> & { id: string };

describe("sidebarSessions", () => {
  it("过滤归档；置顶排最前，组内保持原有（updatedAt 倒序）顺序", () => {
    const agents: Flags[] = [
      { id: "a" },
      { id: "b", pinned: true },
      { id: "c", archived: true, pinned: true },
      { id: "d" },
      { id: "e", pinned: true },
    ];
    expect(sidebarSessions(agents).map((agent) => agent.id)).toEqual(["b", "e", "a", "d"]);
  });
});

describe("历史页视图", () => {
  it("inHistoryView：默认视图不含归档，已归档视图只含归档", () => {
    expect(inHistoryView({}, "all")).toBe(true);
    expect(inHistoryView({ archived: true }, "all")).toBe(false);
    expect(inHistoryView({ archived: true }, "archived")).toBe(true);
    expect(inHistoryView({ archived: false }, "archived")).toBe(false);
  });

  it("splitPinned：仅「全部会话」视图单列置顶", () => {
    const rows = [{ agent: { pinned: true } }, { agent: {} }, { agent: { pinned: true } }];
    expect(splitPinned(rows, "all")).toEqual({ pinned: [rows[0], rows[2]], rest: [rows[1]] });
    expect(splitPinned(rows, "archived")).toEqual({ pinned: [], rest: rows });
  });
});

describe("批量操作", () => {
  it("runBatch 逐个执行，失败不中断，汇总成功 / 失败", async () => {
    const calls: string[] = [];
    const result = await runBatch(["a", "b", "c"], async (id) => {
      calls.push(id);
      if (id === "b") throw new Error("boom");
    });
    expect(calls).toEqual(["a", "b", "c"]);
    expect(result).toEqual({ succeeded: ["a", "c"], failed: ["b"] });
    expect(batchSummary("归档", result)).toBe("归档：成功 2 个，失败 1 个");
    expect(batchSummary("删除", { succeeded: ["a"], failed: [] })).toBe("删除：成功 1 个");
  });
});
