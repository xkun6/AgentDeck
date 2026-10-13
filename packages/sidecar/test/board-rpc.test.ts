import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { AgentManager } from "../src/agent/agent-manager.js";
import { BoardService } from "../src/kanban/board-service.js";
import { BoardStore } from "../src/kanban/store.js";
import { MockAgentClient } from "../src/providers/mock/index.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { RpcServer } from "../src/server/rpc-server.js";
import { RpcCallError, TestRpcClient } from "./rpc-test-client.js";

const TOKEN = "test-token-0123456789abcdef";

let server: RpcServer;
let client: TestRpcClient;
let board: BoardService;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "agentdeck-board-rpc-"));
  const registry = new ProviderRegistry([new MockAgentClient()]);
  const manager = new AgentManager({ registry });
  board = new BoardService({ manager, store: new BoardStore() });
  await board.start();
  server = new RpcServer({ token: TOKEN, version: "t", manager, registry, board });
  const port = await server.listen(0);
  client = await TestRpcClient.connect(`ws://127.0.0.1:${port}/rpc?token=${TOKEN}`);
});

afterEach(async () => {
  await client.close();
  await server.close();
  await board.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function errorCode(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    return (error as RpcCallError).error.code;
  }
  throw new Error("预期失败");
}

describe("board.* RPC", () => {
  test("get / upsertTask / moveTask / updateSettings / deleteTask 与 board.changed 通知", async () => {
    const empty = await client.call("board.get", { projectPath: dir });
    expect(empty.board.tasks).toEqual([]);

    const { task } = await client.call("board.upsertTask", { projectPath: dir, task: { title: "写文档" } });
    expect(task).toMatchObject({ title: "写文档", status: "todo", maxAttempts: 2 });
    await client.waitFor(() => client.notifications.some((n) => n.method === "board.changed"));

    const moved = await client.call("board.moveTask", { projectPath: dir, taskId: task.id, status: "done" });
    expect(moved.board.tasks[0]!.status).toBe("done");
    const settings = await client.call("board.updateSettings", {
      projectPath: dir,
      settings: { maxConcurrent: 4, autoDispatch: true },
    });
    expect(settings.board.settings).toMatchObject({ maxConcurrent: 4, autoDispatch: true });
    const removed = await client.call("board.deleteTask", { projectPath: dir, taskId: task.id });
    expect(removed.board.tasks).toEqual([]);
  });

  test("参数非法与依赖不存在为 -32602；任务不存在为业务错误 -32000", async () => {
    expect(await errorCode(client.call("board.upsertTask", { projectPath: dir, task: { title: "" } }))).toBe(-32602);
    expect(
      await errorCode(client.call("board.upsertTask", { projectPath: dir, task: { title: "x", dependsOn: ["nope"] } })),
    ).toBe(-32602);
    expect(
      await errorCode(client.call("board.updateSettings", { projectPath: dir, settings: { maxConcurrent: 0 } })),
    ).toBe(-32602);
    expect(
      await errorCode(client.call("board.moveTask", { projectPath: dir, taskId: "ghost", status: "todo" })),
    ).toBe(-32000);
  });
});
