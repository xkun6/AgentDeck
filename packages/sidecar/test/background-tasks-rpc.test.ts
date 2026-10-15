// agent.tasks.list / stop / output 与 agent.tasks.update（design.md 4.15）
import type { AgentBackgroundTask } from "@agentdeck/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { AgentManager } from "../src/agent/agent-manager.js";
import { AgentRpcError } from "../src/agent/errors.js";
import type { AgentSession, AgentSessionConfig, AgentSessionEvent } from "../src/agent/types.js";
import { MockAgentClient } from "../src/providers/mock/index.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { RpcServer } from "../src/server/rpc-server.js";
import { RpcCallError, TestRpcClient } from "./rpc-test-client.js";

const TOKEN = "test-token-0123456789abcdef";

const task = (overrides: Partial<AgentBackgroundTask> = {}): AgentBackgroundTask => ({
  taskId: "bk1",
  kind: "command",
  description: "pnpm build",
  status: "running",
  startedAt: 1,
  ...overrides,
});

/** 给 mock 会话补上后台任务方法；测试通过 push 推送整表快照 */
class TaskTestClient extends MockAgentClient {
  readonly pushers: Array<(tasks: AgentBackgroundTask[]) => void> = [];
  readonly stopped: string[] = [];
  readonly outputCalls: Array<{ taskId: string; maxBytes: number }> = [];
  supportTasks = true;

  override async createSession(cfg: AgentSessionConfig): Promise<AgentSession> {
    const session = await super.createSession(cfg);
    if (!this.supportTasks) return session;
    const listeners = new Set<(event: AgentSessionEvent) => void>();
    const subscribe = session.subscribe.bind(session);
    session.subscribe = (cb) => {
      listeners.add(cb);
      const off = subscribe(cb);
      return () => {
        listeners.delete(cb);
        off();
      };
    };
    let current: AgentBackgroundTask[] = [];
    this.pushers.push((tasks) => {
      current = tasks;
      for (const listener of listeners) listener({ type: "provider_background_tasks", tasks });
    });
    session.listBackgroundTasks = () => current;
    session.stopBackgroundTask = async (taskId) => {
      if (taskId !== "bk1") throw new AgentRpcError("TASK_NOT_FOUND", `未找到后台任务：${taskId}`);
      this.stopped.push(taskId);
    };
    session.readBackgroundTaskOutput = async (taskId, maxBytes) => {
      if (taskId !== "bk1") throw new AgentRpcError("TASK_NOT_FOUND", `未找到后台任务：${taskId}`);
      this.outputCalls.push({ taskId, maxBytes });
      return { text: "输出", truncated: false, size: 6 };
    };
    return session;
  }
}

let server: RpcServer;
let manager: AgentManager;
let client: TestRpcClient;
let provider: TaskTestClient;

async function start(): Promise<void> {
  const registry = new ProviderRegistry([provider]);
  manager = new AgentManager({ registry });
  server = new RpcServer({ token: TOKEN, version: "9.9.9-test", manager, registry });
  const port = await server.listen(0);
  client = await TestRpcClient.connect(`ws://127.0.0.1:${port}/rpc?token=${TOKEN}`);
}

function taskUpdates(): Array<{ agentId: string; tasks: AgentBackgroundTask[] }> {
  return client.notifications
    .filter((n) => n.method === "agent.tasks.update")
    .map((n) => n.params as { agentId: string; tasks: AgentBackgroundTask[] });
}

async function errorCode(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcCallError);
  return (error as RpcCallError).error.data?.code;
}

beforeEach(() => {
  provider = new TaskTestClient();
});

afterEach(async () => {
  await client.close();
  await manager.shutdown();
  await server.close();
});

describe("后台任务 RPC", () => {
  test("provider 推送整表 → 广播 agent.tasks.update；list 返回最新；关闭会话后 list 返回缓存", async () => {
    await start();
    const { agent } = await client.call("agent.create", { provider: "mock", cwd: process.cwd() });
    await expect(client.call("agent.tasks.list", { agentId: agent.id })).resolves.toEqual({ tasks: [] });

    provider.pushers[0]!([task()]);
    provider.pushers[0]!([task({ status: "completed", endedAt: 5 })]);
    await client.waitFor(() => taskUpdates().length === 2);
    expect(taskUpdates()[0]).toEqual({ agentId: agent.id, tasks: [task()] });
    await expect(client.call("agent.tasks.list", { agentId: agent.id })).resolves.toEqual({
      tasks: [task({ status: "completed", endedAt: 5 })],
    });

    await client.call("agent.close", { agentId: agent.id });
    await expect(client.call("agent.tasks.list", { agentId: agent.id })).resolves.toEqual({
      tasks: [task({ status: "completed", endedAt: 5 })],
    });
  });

  test("backgroundActive：running 后台任务 → true；全部结束 → 缺省；再启动后关闭会话 → 缺省（design.md 4.15）", async () => {
    await start();
    const { agent } = await client.call("agent.create", { provider: "mock", cwd: process.cwd() });
    const stateOf = () => client.states.filter((a) => a.id === agent.id);
    const snapshot = async () => (await client.call("agent.list", {})).agents.find((a) => a.id === agent.id)!;
    expect((await snapshot()).backgroundActive).toBeUndefined();

    provider.pushers[0]!([task(), task({ taskId: "bk2" })]);
    await client.waitFor(() => stateOf().some((a) => a.backgroundActive === true));
    const active = await snapshot();
    expect(active.status).toBe("idle");
    expect(active.backgroundActive).toBe(true);

    provider.pushers[0]!([task({ status: "completed" }), task({ taskId: "bk2", status: "stopped" })]);
    await client.waitFor(() => stateOf().at(-1)?.backgroundActive === undefined);
    expect((await snapshot()).backgroundActive).toBeUndefined();

    provider.pushers[0]!([task({ taskId: "bk3" })]);
    await client.waitFor(() => stateOf().at(-1)?.backgroundActive === true);
    await client.call("agent.close", { agentId: agent.id });
    expect((await snapshot()).backgroundActive).toBeUndefined();
  });

  test("stop / output 转发到会话；maxBytes 缺省 64KB、上限 256KB；任务未知 TASK_NOT_FOUND", async () => {
    await start();
    const { agent } = await client.call("agent.create", { provider: "mock", cwd: process.cwd() });
    await expect(client.call("agent.tasks.stop", { agentId: agent.id, taskId: "bk1" })).resolves.toEqual({});
    expect(provider.stopped).toEqual(["bk1"]);
    expect(await errorCode(client.call("agent.tasks.stop", { agentId: agent.id, taskId: "nope" }))).toBe(
      "TASK_NOT_FOUND",
    );

    await expect(client.call("agent.tasks.output", { agentId: agent.id, taskId: "bk1" })).resolves.toEqual({
      text: "输出",
      truncated: false,
      size: 6,
    });
    await client.call("agent.tasks.output", { agentId: agent.id, taskId: "bk1", maxBytes: 1000 });
    await client.call("agent.tasks.output", { agentId: agent.id, taskId: "bk1", maxBytes: 99_999_999 });
    expect(provider.outputCalls.map((c) => c.maxBytes)).toEqual([64 * 1024, 1000, 256 * 1024]);
    expect(await errorCode(client.call("agent.tasks.output", { agentId: agent.id, taskId: "nope" }))).toBe(
      "TASK_NOT_FOUND",
    );
  });

  test("参数校验（-32602）与 AGENT_NOT_FOUND", async () => {
    await start();
    const { agent } = await client.call("agent.create", { provider: "mock", cwd: process.cwd() });
    for (const [method, params] of [
      ["agent.tasks.list", { agentId: "" }],
      ["agent.tasks.stop", { agentId: agent.id, taskId: "" }],
      ["agent.tasks.stop", { agentId: agent.id }],
      ["agent.tasks.output", { agentId: agent.id, taskId: "" }],
      ["agent.tasks.output", { agentId: agent.id, taskId: "bk1", maxBytes: 0 }],
      ["agent.tasks.output", { agentId: agent.id, taskId: "bk1", maxBytes: 1.5 }],
    ] as const) {
      const response = await client.request(method, params);
      expect(response.error?.code, `${method} ${JSON.stringify(params)}`).toBe(-32602);
    }
    expect(await errorCode(client.call("agent.tasks.list", { agentId: "missing" }))).toBe("AGENT_NOT_FOUND");
    expect(await errorCode(client.call("agent.tasks.stop", { agentId: "missing", taskId: "bk1" }))).toBe(
      "AGENT_NOT_FOUND",
    );
  });

  test("会话关闭后 stop / output 返回 AGENT_CLOSED（不恢复会话）", async () => {
    await start();
    const { agent } = await client.call("agent.create", { provider: "mock", cwd: process.cwd() });
    await client.call("agent.close", { agentId: agent.id });
    expect(await errorCode(client.call("agent.tasks.stop", { agentId: agent.id, taskId: "bk1" }))).toBe(
      "AGENT_CLOSED",
    );
    expect(await errorCode(client.call("agent.tasks.output", { agentId: agent.id, taskId: "bk1" }))).toBe(
      "AGENT_CLOSED",
    );
  });

  test("provider 不支持后台任务：list 返回 []，stop / output 返回 NOT_SUPPORTED", async () => {
    provider.supportTasks = false;
    await start();
    const { agent } = await client.call("agent.create", { provider: "mock", cwd: process.cwd() });
    await expect(client.call("agent.tasks.list", { agentId: agent.id })).resolves.toEqual({ tasks: [] });
    expect(await errorCode(client.call("agent.tasks.stop", { agentId: agent.id, taskId: "bk1" }))).toBe(
      "NOT_SUPPORTED",
    );
    expect(await errorCode(client.call("agent.tasks.output", { agentId: agent.id, taskId: "bk1" }))).toBe(
      "NOT_SUPPORTED",
    );
  });
});
