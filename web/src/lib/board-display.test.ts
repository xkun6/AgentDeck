import { describe, expect, it } from "vitest";
import type { AgentSnapshot, Board, BoardTask } from "@agentdeck/protocol";
import { BOARD_COLUMNS, columnLabel, orderForDrop, sessionBadge, tasksByColumn } from "./board-display";
import { boardPathKey } from "./board-path";

function task(id: string, status: BoardTask["status"], order: number): BoardTask {
  return { id, title: id, description: "", status, attempts: 0, maxAttempts: 2, order, createdAt: 1, updatedAt: 1 };
}

describe("boardPathKey", () => {
  it("Windows 路径大小写不敏感、分隔符统一、去尾部分隔符；POSIX 路径保留大小写", () => {
    expect(boardPathKey("C:\\Work\\Proj\\")).toBe("c:/work/proj");
    expect(boardPathKey(" c:/work/proj/ ")).toBe("c:/work/proj");
    expect(boardPathKey("/Home/Me/Proj/")).toBe("/Home/Me/Proj");
    expect(boardPathKey("/")).toBe("/");
  });
});

describe("board-display", () => {
  it("五列顺序与中文名", () => {
    expect(BOARD_COLUMNS.map((column) => column.label)).toEqual(["待办", "运行中", "待评审", "完成", "阻塞"]);
    expect(columnLabel("blocked")).toBe("阻塞");
  });

  it("tasksByColumn：分列并按 order 升序", () => {
    const board = {
      projectPath: "/p",
      settings: {} as Board["settings"],
      tasks: [task("b", "todo", 2), task("a", "todo", 1), task("c", "done", 5)],
    } as Board;
    const columns = tasksByColumn(board);
    expect(columns.todo.map((item) => item.id)).toEqual(["a", "b"]);
    expect(columns.done.map((item) => item.id)).toEqual(["c"]);
    expect(columns.running).toEqual([]);
  });

  it("orderForDrop：空列 / 列首 / 列尾 / 中间取中点", () => {
    const list = [task("a", "todo", 1), task("b", "todo", 2), task("c", "todo", 4)];
    expect(orderForDrop([], 0)).toBe(1);
    expect(orderForDrop(list, 0)).toBe(0);
    expect(orderForDrop(list, 3)).toBe(5);
    expect(orderForDrop(list, 1)).toBe(1.5);
    expect(orderForDrop(list, 2)).toBe(3);
  });

  it("sessionBadge：等待审批优先，其次运行中 / 出错 / 其它状态", () => {
    const agent = (patch: Partial<AgentSnapshot>): AgentSnapshot => ({
      id: "a", provider: "claude", cwd: "/", status: "idle", pendingPermissions: [], lastSeq: 0, resumable: true,
      createdAt: 1, updatedAt: 1, ...patch,
    });
    expect(sessionBadge(undefined)).toBeNull();
    expect(sessionBadge(agent({ status: "running" }))).toEqual({ label: "运行中", tone: "running" });
    expect(sessionBadge(agent({ status: "running", pendingPermissions: [{ id: "p" } as never] }))).toEqual({
      label: "等待审批",
      tone: "attention",
    });
    expect(sessionBadge(agent({ pendingPermissions: [{ id: "p", kind: "question" } as never] }))?.label).toBe("等待回答");
    expect(sessionBadge(agent({ pendingPermissions: [{ id: "p", kind: "plan" } as never] }))?.label).toBe("等待确认计划");
    expect(sessionBadge(agent({ status: "error" }))?.tone).toBe("error");
    expect(sessionBadge(agent({ status: "idle" }))).toEqual({ label: "空闲", tone: "idle" });
    expect(sessionBadge(agent({ status: "idle", backgroundActive: true }))).toEqual({ label: "运行中", tone: "running" });
  });
});
