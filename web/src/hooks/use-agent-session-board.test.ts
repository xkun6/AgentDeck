import { describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import type { Board } from "@agentdeck/protocol";
import type { SidecarClient } from "@/lib/sidecar-client";
import { bindBoardsToStore, createAgentSessionActions } from "./use-agent-session";
import { boardsByPathAtom } from "@/stores/boards";

const board: Board = {
  projectPath: "C:\\Work\\Proj",
  settings: { worktreePerTask: true, autoDispatch: false, maxConcurrent: 2, defaultAssignee: { provider: "claude" } },
  tasks: [],
};

function fakeClient(request: (method: string, params: unknown) => Promise<unknown>) {
  return { request: vi.fn(request) } as unknown as SidecarClient & { request: ReturnType<typeof vi.fn> };
}

describe("看板动作与 board.changed 绑定", () => {
  it("board.changed 整张看板写入 store，按规范化路径索引", () => {
    const store = createStore();
    let onChanged: (value: { projectPath: string; board: Board }) => void = () => {};
    const client = {
      onBoardChanged: (listener: typeof onChanged) => {
        onChanged = listener;
        return () => {};
      },
    } as unknown as SidecarClient;
    bindBoardsToStore(client, store);
    onChanged({ projectPath: board.projectPath, board });
    expect(store.get(boardsByPathAtom)["c:/work/proj"]).toEqual(board);
  });

  it("动作：get / settings / upsert / move / merge / delete 的 RPC 参数与 store 写入", async () => {
    const store = createStore();
    const task = { id: "t1", title: "x" };
    const client = fakeClient(async (method) => {
      if (method === "board.upsertTask") return { board, task };
      if (method === "board.merge") return { ok: false, conflicts: ["a.txt"], board };
      if (method === "board.deleteTask") return { board, warning: "清理失败" };
      return { board };
    });
    const actions = createAgentSessionActions(client, store);
    expect(await actions.getBoard("C:/Work/Proj")).toEqual(board);
    expect(store.get(boardsByPathAtom)["c:/work/proj"]).toEqual(board);
    await actions.updateBoardSettings("/p", { autoDispatch: true });
    expect(await actions.upsertBoardTask("/p", { title: "x" })).toEqual(task);
    await actions.moveBoardTask("/p", "t1", "running", 2);
    await actions.moveBoardTask("/p", "t1", "done");
    expect(await actions.mergeBoardTask("/p", "t1", true)).toEqual({ ok: false, conflicts: ["a.txt"] });
    expect(await actions.deleteBoardTask("/p", "t1", true)).toEqual({ warning: "清理失败" });
    await actions.deleteBoardTask("/p", "t1");
    expect(client.request.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ["board.get", { projectPath: "C:/Work/Proj" }],
      ["board.updateSettings", { projectPath: "/p", settings: { autoDispatch: true } }],
      ["board.upsertTask", { projectPath: "/p", task: { title: "x" } }],
      ["board.moveTask", { projectPath: "/p", taskId: "t1", status: "running", order: 2 }],
      ["board.moveTask", { projectPath: "/p", taskId: "t1", status: "done" }],
      ["board.merge", { projectPath: "/p", taskId: "t1", removeWorktree: true }],
      ["board.deleteTask", { projectPath: "/p", taskId: "t1", removeWorktree: true }],
      ["board.deleteTask", { projectPath: "/p", taskId: "t1" }],
    ]);
  });
});
