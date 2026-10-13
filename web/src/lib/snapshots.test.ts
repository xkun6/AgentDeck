import { describe, expect, it } from "vitest";
import type { SnapshotTurn } from "@agentdeck/protocol";
import { formatSnapshotBytes, rollbackPreview, snapshotForMessage } from "./snapshots";

function turn(patch: Partial<SnapshotTurn> & Pick<SnapshotTurn, "turnId" | "seq">): SnapshotTurn {
  return { startedAt: 0, before: "b", after: "a", changedFiles: [], ...patch };
}

describe("snapshotForMessage", () => {
  const turns = [
    turn({ turnId: "t1", seq: 2, changedFiles: [{ path: "a.ts", status: "M" }] }),
    turn({ turnId: "t2", seq: 9 }),
    turn({ turnId: "t3", seq: 14, after: null, changedFiles: [{ path: "x", status: "A" }] }),
    turn({ turnId: "t4", seq: 20, pruned: true, changedFiles: [{ path: "y", status: "A" }] }),
  ];

  it("按 firstSeq 对应回合，只有已结束且有变化的回合才返回", () => {
    expect(snapshotForMessage(turns, 2)?.turnId).toBe("t1");
    expect(snapshotForMessage(turns, 9)).toBeUndefined(); // 无变化
    expect(snapshotForMessage(turns, 14)).toBeUndefined(); // 回合后快照未生成
    expect(snapshotForMessage(turns, 20)).toBeUndefined(); // 已清理
    expect(snapshotForMessage(turns, 99)).toBeUndefined();
    expect(snapshotForMessage(turns, undefined)).toBeUndefined();
    expect(snapshotForMessage(undefined, 2)).toBeUndefined();
  });
});

describe("rollbackPreview", () => {
  it("折叠该回合及之后各回合的改动：新增 → 删除，修改 / 删除 → 恢复", () => {
    const turns = [
      turn({ turnId: "t1", seq: 1, changedFiles: [{ path: "old.ts", status: "M" }] }),
      turn({
        turnId: "t2",
        seq: 5,
        changedFiles: [
          { path: "new.ts", status: "A" },
          { path: "gone.ts", status: "D" },
          { path: "old.ts", status: "M" },
        ],
      }),
      turn({
        turnId: "t3",
        seq: 9,
        changedFiles: [
          { path: "new.ts", status: "M" },
          { path: "temp.ts", status: "A" },
        ],
      }),
      turn({ turnId: "t4", seq: 12, changedFiles: [{ path: "temp.ts", status: "D" }] }),
    ];
    expect(rollbackPreview(turns, "t2")).toEqual({
      restore: ["gone.ts", "old.ts"],
      remove: ["new.ts"],
    });
    expect(rollbackPreview(turns, "t1").restore).toEqual(["gone.ts", "old.ts"]);
    expect(rollbackPreview(turns, "missing")).toEqual({ restore: [], remove: [] });
  });
});

describe("formatSnapshotBytes", () => {
  it("按 1024 进位", () => {
    expect(formatSnapshotBytes(0)).toBe("0 B");
    expect(formatSnapshotBytes(1536)).toBe("1.5 KB");
    expect(formatSnapshotBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
