import { describe, expect, it } from "vitest";
import type { AgentSnapshot } from "@agentdeck/protocol";
import {
  batchSummary,
  buildSessionTree,
  flattenSessionTree,
  inHistoryView,
  runBatch,
  sidebarSessions,
  splitPinned,
  treeSome,
} from "./session-list";

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

describe("隐藏的评判会话（origin: judge）", () => {
  it("侧栏与历史页（两个视图）都不显示", () => {
    const agents = [{ id: "a" }, { id: "j", origin: "judge" as const }, { id: "s", origin: "schedule" as const }];
    expect(sidebarSessions(agents).map((agent) => agent.id)).toEqual(["a", "s"]);
    expect(inHistoryView({ origin: "judge" }, "all")).toBe(false);
    expect(inHistoryView({ origin: "judge", archived: true }, "archived")).toBe(false);
    expect(inHistoryView({ origin: "schedule" }, "all")).toBe(true);
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

describe("buildSessionTree / flattenSessionTree（子会话嵌套，4.26）", () => {
  type Node = Pick<AgentSnapshot, "id" | "parentAgentId">;
  const idOf = (agent: Node) => agent.id;

  it("子会话挂在父会话下，根与兄弟保持传入顺序；父会话缺失的子会话当作根", () => {
    const agents: Node[] = [
      { id: "c1", parentAgentId: "p" },
      { id: "x" },
      { id: "p" },
      { id: "c2", parentAgentId: "p" },
      { id: "g", parentAgentId: "c1" },
      { id: "orphan", parentAgentId: "missing" },
    ];
    const roots = buildSessionTree(agents);
    expect(roots.map((root) => root.agent.id)).toEqual(["x", "p", "orphan"]);
    const rows = flattenSessionTree(roots[1]!, idOf, new Set());
    expect(rows.map((row) => [row.agent.id, row.depth, row.childCount])).toEqual([
      ["p", 0, 2],
      ["c1", 1, 1],
      ["g", 2, 0],
      ["c2", 1, 0],
    ]);
  });

  it("collapsed 的会话不展开子会话；treeSome 检查整棵树", () => {
    const [root] = buildSessionTree<Node>([{ id: "p" }, { id: "c", parentAgentId: "p" }]);
    const rows = flattenSessionTree(root!, idOf, new Set(["p"]));
    expect(rows.map((row) => row.agent.id)).toEqual(["p"]);
    expect(rows[0]).toMatchObject({ childCount: 1, collapsed: true });
    expect(treeSome(root!, (agent) => agent.id === "c")).toBe(true);
    expect(treeSome(root!, (agent) => agent.id === "zzz")).toBe(false);
  });

  it("父子成环时断开成根，不会丢会话也不会死循环", () => {
    const roots = buildSessionTree<Node>([
      { id: "a", parentAgentId: "b" },
      { id: "b", parentAgentId: "a" },
    ]);
    expect(roots.map((root) => root.agent.id).sort()).toEqual(["a", "b"]);
  });
});
