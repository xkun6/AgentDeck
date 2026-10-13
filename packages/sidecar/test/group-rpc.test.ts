import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { AgentManager } from "../src/agent/agent-manager.js";
import { GroupService } from "../src/groups/group-service.js";
import { GroupStore } from "../src/groups/store.js";
import { MockAgentClient } from "../src/providers/mock/index.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { RpcServer } from "../src/server/rpc-server.js";
import { RpcCallError, TestRpcClient } from "./rpc-test-client.js";

const TOKEN = "test-token-0123456789abcdef";

let server: RpcServer;
let client: TestRpcClient;
let groups: GroupService;
let dataDir: string;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "agentdeck-group-rpc-"));
  const registry = new ProviderRegistry([new MockAgentClient()]);
  const manager = new AgentManager({ registry });
  groups = new GroupService({ manager, registry, store: new GroupStore({ dataDir }), dataDir });
  await groups.start();
  server = new RpcServer({ token: TOKEN, version: "t", manager, registry, groups });
  const port = await server.listen(0);
  client = await TestRpcClient.connect(`ws://127.0.0.1:${port}/rpc?token=${TOKEN}`);
});

afterEach(async () => {
  await client.close();
  await server.close();
  await groups.stop();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function errorCode(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    return (error as RpcCallError).error.code;
  }
  throw new Error("预期失败");
}

describe("group.* RPC", () => {
  test("成员数不足 / cwd 非 git 仓库的 per-member 为 -32602", async () => {
    const base = { prompt: "p", cwd: dataDir, worktree: "none" as const };
    expect(
      await errorCode(client.call("group.create", { ...base, members: [{ provider: "mock" }] })),
    ).toBe(-32602);
    expect(
      await errorCode(
        client.call("group.create", {
          ...base,
          worktree: "per-member",
          members: [{ provider: "mock" }, { provider: "mock" }],
        }),
      ),
    ).toBe(-32602);
  });

  test("create / list / get / delete 全流程并广播 group.changed / group.removed", async () => {
    const { group } = await client.call("group.create", {
      prompt: "你好",
      cwd: dataDir,
      worktree: "none",
      members: [{ provider: "mock" }, { provider: "mock" }],
    });
    expect(group.members).toHaveLength(2);
    await client.waitFor(() => client.notifications.some((n) => n.method === "group.changed"));
    expect((await client.call("group.list")).groups.map((item) => item.id)).toEqual([group.id]);
    expect((await client.call("group.get", { id: group.id })).group.id).toBe(group.id);
    expect(await errorCode(client.call("group.get", { id: "nope" }))).toBe(-32602);
    expect(await client.call("group.delete", { id: group.id, removeWorktrees: false })).toEqual({});
    await client.waitFor(() => client.notifications.some((n) => n.method === "group.removed"));
    expect((await client.call("group.list")).groups).toEqual([]);
  });
});
