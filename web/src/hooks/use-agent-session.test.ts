// 持久化会话相关的动作层：dormant / closed 发送的错误映射、恢复提示、删除与 agent.removed 绑定。
import { describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import type { AgentBackgroundTask, AgentSnapshot } from "@agentdeck/protocol";
import { SidecarConnectionLostError, SidecarRpcError, type SidecarClient } from "@/lib/sidecar-client";
import {
  AgentSendError,
  bindSchedulesToStore,
  bindSidecarToStore,
  createAgentSessionActions,
  describeAgentSendError,
  isInactiveAgent,
  SESSION_PROVIDER_DELETED_MESSAGE,
  SESSION_PROVIDER_DISABLED_MESSAGE,
  SESSION_RESUME_BUSY_MESSAGE,
  SESSION_UNRECOVERABLE_MESSAGE,
} from "./use-agent-session";
import { AGENT_RESUMING_PROGRESS, agentPendingAssistantId, chatRuntimeBySessionAtom } from "@/stores/chat";
import { agentSnapshotsAtom, lastRemovedAgentAtom, upsertAgentSnapshotAtom } from "@/stores/agents";
import { backgroundTasksByAgentAtom } from "@/stores/background-tasks";
import { schedulesStateAtom } from "@/stores/schedules";

const AGENT = "agent-d";

function snapshot(patch: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id: AGENT,
    provider: "mock",
    cwd: "/work",
    status: "dormant",
    pendingPermissions: [],
    lastSeq: 4,
    resumable: true,
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  };
}

function rpcError(code: string, message = "boom"): SidecarRpcError {
  return new SidecarRpcError({ code: -32000, message, data: { code } });
}

function fakeClient(request: (method: string, params: unknown) => Promise<unknown>) {
  return { request: vi.fn(request) } as unknown as SidecarClient & { request: ReturnType<typeof vi.fn> };
}

function noticeTexts(store: ReturnType<typeof createStore>): string[] {
  return (store.get(chatRuntimeBySessionAtom)[AGENT]?.messages ?? [])
    .filter((message) => message.role === "system")
    .flatMap((message) => message.parts.map((part) => (part as { text?: string }).text ?? ""));
}

describe("describeAgentSendError", () => {
  it("NOT_SUPPORTED / AGENT_CLOSED → 无法恢复，需要新建会话", () => {
    for (const code of ["NOT_SUPPORTED", "AGENT_CLOSED"]) {
      expect(describeAgentSendError(rpcError(code), { resuming: true })).toEqual({
        message: SESSION_UNRECOVERABLE_MESSAGE,
        unrecoverable: true,
      });
    }
  });

  it("恢复中 PROVIDER_UNAVAILABLE → 显示快照的 lastError，缺失时用错误消息", () => {
    const error = rpcError("PROVIDER_UNAVAILABLE", "恢复会话失败：spawn ENOENT");
    expect(describeAgentSendError(error, { resuming: true, lastError: "恢复会话失败：找不到 claude" })).toEqual({
      message: "恢复会话失败：找不到 claude",
      unrecoverable: false,
    });
    expect(describeAgentSendError(error, { resuming: true, lastError: null }).message).toBe("恢复会话失败：spawn ENOENT");
  });

  it("恢复中 TURN_IN_PROGRESS → 会话正在恢复或运行中；非恢复场景沿用通用提示", () => {
    expect(describeAgentSendError(rpcError("TURN_IN_PROGRESS"), { resuming: true }).message).toBe(SESSION_RESUME_BUSY_MESSAGE);
    expect(describeAgentSendError(rpcError("TURN_IN_PROGRESS"), { resuming: false }).message).toContain("上一轮");
  });

  it("PROVIDER_NOT_FOUND → 中转已删除（不可恢复）；中转停用时提示启用（可重试）", () => {
    expect(describeAgentSendError(rpcError("PROVIDER_NOT_FOUND"), { resuming: true })).toEqual({
      message: SESSION_PROVIDER_DELETED_MESSAGE,
      unrecoverable: true,
      providerMissing: true,
    });
    expect(SESSION_PROVIDER_DELETED_MESSAGE).toBe("该会话使用的中转已被删除，请新建会话");
    expect(describeAgentSendError(rpcError("PROVIDER_NOT_FOUND"), { resuming: true, providerDisabled: true })).toEqual({
      message: SESSION_PROVIDER_DISABLED_MESSAGE,
      unrecoverable: false,
      providerMissing: true,
    });
  });

  it("isInactiveAgent 只认 dormant / closed", () => {
    expect(isInactiveAgent(snapshot({ status: "dormant" }))).toBe(true);
    expect(isInactiveAgent(snapshot({ status: "closed" }))).toBe(true);
    expect(isInactiveAgent(snapshot({ status: "idle" }))).toBe(false);
    expect(isInactiveAgent(undefined)).toBe(false);
  });
});

describe("dormant 会话发送", () => {
  it("直接调 agent.send，占位消息显示正在恢复会话", async () => {
    const store = createStore();
    store.set(upsertAgentSnapshotAtom, snapshot());
    const client = fakeClient(async () => ({ turnId: "t9" }));
    const actions = createAgentSessionActions(client, store);

    const result = await actions.sendPrompt(AGENT, "继续", { clientMessageId: "cm-1" });
    expect(result.turnId).toBe("t9");
    expect(client.request).toHaveBeenCalledWith("agent.send", { agentId: AGENT, prompt: "继续", clientMessageId: "cm-1" });
    const pending = store.get(chatRuntimeBySessionAtom)[AGENT]!.messages
      .find((message) => message.id === agentPendingAssistantId("cm-1"));
    expect(pending?.parts).toEqual([{ type: "progress", text: AGENT_RESUMING_PROGRESS }]);
  });

  it("不可恢复：抛出带中文提示的 AgentSendError，并在时间线追加提示", async () => {
    const store = createStore();
    store.set(upsertAgentSnapshotAtom, snapshot({ resumable: false }));
    const actions = createAgentSessionActions(
      fakeClient(async () => { throw rpcError("NOT_SUPPORTED", "该会话无法恢复，请新建会话"); }),
      store,
    );

    const error = await actions.sendPrompt(AGENT, "继续", { clientMessageId: "cm-2" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentSendError);
    expect((error as AgentSendError).unrecoverable).toBe(true);
    expect((error as AgentSendError).message).toBe(SESSION_UNRECOVERABLE_MESSAGE);
    expect(noticeTexts(store)).toEqual([`发送失败：${SESSION_UNRECOVERABLE_MESSAGE}`]);
  });

  it("恢复失败（PROVIDER_UNAVAILABLE）显示 sidecar 写入的 lastError", async () => {
    const store = createStore();
    store.set(upsertAgentSnapshotAtom, snapshot({ status: "closed" }));
    const actions = createAgentSessionActions(
      fakeClient(async () => {
        // sidecar 先推 agent.state（lastError），再返回错误
        store.set(upsertAgentSnapshotAtom, snapshot({ status: "closed", lastError: "恢复会话失败：claude 不可用", updatedAt: 3 }));
        throw rpcError("PROVIDER_UNAVAILABLE", "恢复会话失败：claude 不可用");
      }),
      store,
    );

    const error = await actions.sendPrompt(AGENT, "继续", { clientMessageId: "cm-3" }).catch((e: unknown) => e);
    expect((error as AgentSendError).unrecoverable).toBe(false);
    expect(noticeTexts(store)).toEqual(["发送失败：恢复会话失败：claude 不可用"]);
  });
});

describe("断线期间发送（连接断开 ≠ 发送失败）", () => {
  const lost = () => new SidecarConnectionLostError("与 Agent 服务的连接已断开");

  function lostClient(confirm: (agentId: string, clientMessageId: string) => Promise<{ turnId: string } | null>) {
    return {
      request: vi.fn(async () => {
        throw lost();
      }),
      confirmUserMessage: vi.fn(confirm),
    } as unknown as SidecarClient & { confirmUserMessage: ReturnType<typeof vi.fn> };
  }

  it("重连补齐后发现服务端已收到：按成功处理，不报错、不追加失败提示、不回填", async () => {
    const store = createStore();
    store.set(upsertAgentSnapshotAtom, snapshot({ status: "idle" }));
    const client = lostClient(async () => ({ turnId: "t-real" }));
    const actions = createAgentSessionActions(client, store);
    const result = await actions.sendPrompt(AGENT, "继续", { clientMessageId: "cm-lost" });
    expect(result).toEqual({ turnId: "t-real", clientMessageId: "cm-lost" });
    expect(client.confirmUserMessage).toHaveBeenCalledWith(AGENT, "cm-lost");
    expect(noticeTexts(store)).toEqual([]);
  });

  it("补齐后没有该消息：才报错并追加失败提示", async () => {
    const store = createStore();
    store.set(upsertAgentSnapshotAtom, snapshot({ status: "idle" }));
    const actions = createAgentSessionActions(lostClient(async () => null), store);
    const error = await actions.sendPrompt(AGENT, "继续", { clientMessageId: "cm-gone" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentSendError);
    expect(noticeTexts(store)).toEqual(["发送失败：与 Agent 服务的连接已断开"]);
  });

  it("核对本身失败（仍连不上）：沿用原有报错", async () => {
    const store = createStore();
    store.set(upsertAgentSnapshotAtom, snapshot({ status: "idle" }));
    const actions = createAgentSessionActions(
      lostClient(async () => {
        throw new Error("连接 Agent 服务超时");
      }),
      store,
    );
    const error = await actions.sendPrompt(AGENT, "继续", { clientMessageId: "cm-x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentSendError);
  });

  it("非断线类失败（RPC 错误）不做核对", async () => {
    const store = createStore();
    store.set(upsertAgentSnapshotAtom, snapshot({ status: "idle" }));
    const confirmUserMessage = vi.fn();
    const client = {
      request: vi.fn(async () => {
        throw rpcError("TURN_IN_PROGRESS");
      }),
      confirmUserMessage,
    } as unknown as SidecarClient;
    const actions = createAgentSessionActions(client, store);
    await actions.sendPrompt(AGENT, "继续").catch(() => {});
    expect(confirmUserMessage).not.toHaveBeenCalled();
  });

  it("steerPrompt 同样核对：已落地按成功处理，否则抛出原提示", async () => {
    const ok = createAgentSessionActions(lostClient(async () => ({ turnId: "t1" })), createStore());
    await expect(ok.steerPrompt(AGENT, "补一句", { clientMessageId: "cm-s" })).resolves.toEqual({ clientMessageId: "cm-s" });
    const missing = createAgentSessionActions(lostClient(async () => null), createStore());
    await expect(missing.steerPrompt(AGENT, "补一句")).rejects.toThrow("与 Agent 服务的连接已断开");
  });
});

describe("中转被删除的会话发送", () => {
  it("抛出 providerMissing 的 AgentSendError，并在时间线提示中转已删除", async () => {
    const store = createStore();
    store.set(upsertAgentSnapshotAtom, snapshot({ provider: "custom:gone", status: "closed" }));
    const client = fakeClient(async () => {
      throw rpcError("PROVIDER_NOT_FOUND", "未找到 provider");
    });
    const actions = createAgentSessionActions(client, store);
    const error = await actions.sendPrompt(AGENT, "hi").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentSendError);
    expect((error as AgentSendError).unrecoverable).toBe(true);
    expect((error as AgentSendError).providerMissing).toBe(true);
    expect((error as AgentSendError).message).toBe(SESSION_PROVIDER_DELETED_MESSAGE);
    expect(noticeTexts(store)).toEqual([`发送失败：${SESSION_PROVIDER_DELETED_MESSAGE}`]);
  });
});

describe("思考强度（design.md 4.10）", () => {
  it("createSession 带 thinkingOptionId 时传给 agent.create，省略时不传", async () => {
    const store = createStore();
    const client = fakeClient(async () => ({ agent: snapshot({ status: "idle", thinkingOptionId: "low" }) }));
    const actions = createAgentSessionActions(client, store);
    await actions.createSession({ provider: "mock", cwd: "/work", thinkingOptionId: "low" });
    expect(client.request).toHaveBeenLastCalledWith("agent.create", {
      provider: "mock",
      cwd: "/work",
      thinkingOptionId: "low",
    });
    await actions.createSession({ provider: "mock", cwd: "/work" });
    expect(client.request).toHaveBeenLastCalledWith("agent.create", { provider: "mock", cwd: "/work" });
  });

  it("setThinking 调 agent.setThinking，更新快照并返回提示", async () => {
    const store = createStore();
    store.set(upsertAgentSnapshotAtom, snapshot({ status: "running" }));
    const client = fakeClient(async () => ({
      agent: snapshot({ status: "running", thinkingOptionId: "high", updatedAt: 3 }),
      notice: "思考强度将在下一轮生效",
    }));
    const result = await createAgentSessionActions(client, store).setThinking(AGENT, "high");
    expect(client.request).toHaveBeenCalledWith("agent.setThinking", { agentId: AGENT, thinkingOptionId: "high" });
    expect(result.notice).toBe("思考强度将在下一轮生效");
    expect(store.get(agentSnapshotsAtom)[AGENT]?.thinkingOptionId).toBe("high");
  });
});

describe("agent.update（design.md 4.17）", () => {
  it("updateSession 调 agent.update 并把结果写入快照；title 为 null 时清除自定义标题", async () => {
    const store = createStore();
    store.set(upsertAgentSnapshotAtom, snapshot({ title: "旧" }));
    const client = fakeClient(async () => ({ agent: snapshot({ pinned: true }) }));
    const agent = await createAgentSessionActions(client, store).updateSession(AGENT, { title: null, pinned: true });
    expect(client.request).toHaveBeenCalledWith("agent.update", { agentId: AGENT, title: null, pinned: true });
    expect(agent.pinned).toBe(true);
    const stored = store.get(agentSnapshotsAtom)[AGENT];
    expect(stored?.pinned).toBe(true);
    expect(stored?.title).toBeUndefined();
  });

  it("agent.state 推送（updatedAt 不变）会刷新快照", () => {
    const store = createStore();
    store.set(upsertAgentSnapshotAtom, snapshot());
    let onState: (agent: AgentSnapshot) => void = () => {};
    const noop = () => () => {};
    const client = {
      onState: noop,
      onStream: noop,
      onAgentState: (listener: (agent: AgentSnapshot) => void) => {
        onState = listener;
        return () => {};
      },
      onAgentRemoved: noop,
      onSubagentUpdate: noop,
      onTasksUpdate: noop,
      onAgents: noop,
      onEpochChange: noop,
    } as unknown as SidecarClient;
    bindSidecarToStore(client, store);
    onState(snapshot({ archived: true, title: "新名字" }));
    expect(store.get(agentSnapshotsAtom)[AGENT]).toMatchObject({ archived: true, title: "新名字" });
  });

  it("forkSession 调 agent.fork（可选 throughSeq / title），结果写入快照并预建聊天运行时", async () => {
    const store = createStore();
    const forked = snapshot({ id: "agent-fork", title: "分叉", status: "idle" });
    const client = fakeClient(async () => ({ agent: forked }));
    const actions = createAgentSessionActions(client, store);
    await expect(actions.forkSession(AGENT)).resolves.toEqual(forked);
    expect(client.request.mock.calls[0]?.slice(0, 2)).toEqual(["agent.fork", { agentId: AGENT }]);
    await actions.forkSession(AGENT, { throughSeq: 7, title: "T" });
    expect(client.request.mock.calls[1]?.slice(0, 2)).toEqual([
      "agent.fork",
      { agentId: AGENT, throughSeq: 7, title: "T" },
    ]);
    expect(store.get(agentSnapshotsAtom)["agent-fork"]).toMatchObject({ title: "分叉" });
    expect(store.get(chatRuntimeBySessionAtom)["agent-fork"]).toBeDefined();
  });

  it("fetchAllTimelineEntries 取全部条目", async () => {
    const store = createStore();
    const entries = [{ agentId: AGENT, seq: 1, epoch: "e", timestamp: 1, event: { type: "turn_started", turnId: "t" } }];
    const client = fakeClient(async () => ({ epoch: "e", entries }));
    await expect(createAgentSessionActions(client, store).fetchAllTimelineEntries(AGENT)).resolves.toEqual(entries);
    expect(client.request.mock.calls[0]?.slice(0, 2)).toEqual(["agent.timeline", { agentId: AGENT }]);
  });
});

describe("后台任务（design.md 4.15）", () => {
  const task: AgentBackgroundTask = {
    taskId: "t1",
    kind: "command",
    description: "pnpm build",
    status: "running",
    startedAt: 1,
  };

  it("listBackgroundTasks 调 agent.tasks.list 并写入 store", async () => {
    const store = createStore();
    const client = fakeClient(async () => ({ tasks: [task] }));
    await expect(createAgentSessionActions(client, store).listBackgroundTasks(AGENT)).resolves.toEqual([task]);
    expect(client.request).toHaveBeenCalledWith("agent.tasks.list", { agentId: AGENT });
    expect(store.get(backgroundTasksByAgentAtom)[AGENT]).toEqual([task]);
  });

  it("stopBackgroundTask / backgroundTaskOutput 调对应 RPC，maxBytes 缺省时不带", async () => {
    const store = createStore();
    const client = fakeClient(async () => ({ text: "x", truncated: false, size: 1 }));
    const actions = createAgentSessionActions(client, store);
    await actions.stopBackgroundTask(AGENT, "t1");
    expect(client.request).toHaveBeenLastCalledWith("agent.tasks.stop", { agentId: AGENT, taskId: "t1" });
    await actions.backgroundTaskOutput(AGENT, "t1");
    expect(client.request).toHaveBeenLastCalledWith("agent.tasks.output", { agentId: AGENT, taskId: "t1" });
    await actions.backgroundTaskOutput(AGENT, "t1", 1024);
    expect(client.request).toHaveBeenLastCalledWith("agent.tasks.output", {
      agentId: AGENT,
      taskId: "t1",
      maxBytes: 1024,
    });
  });

  it("bindSidecarToStore：agent.tasks.update 整表替换，agent.removed 清掉该会话的任务", () => {
    const store = createStore();
    let tasksListener: ((update: { agentId: string; tasks: AgentBackgroundTask[] }) => void) | null = null;
    let removedListener: ((agentId: string) => void) | null = null;
    const noop = () => () => {};
    const client = {
      onState: noop,
      onStream: noop,
      onAgentState: noop,
      onAgents: noop,
      onEpochChange: noop,
      onSubagentUpdate: noop,
      onTasksUpdate: (listener: typeof tasksListener) => {
        tasksListener = listener;
        return () => {};
      },
      onAgentRemoved: (listener: (agentId: string) => void) => {
        removedListener = listener;
        return () => {};
      },
    } as unknown as SidecarClient;
    const unbind = bindSidecarToStore(client, store);
    tasksListener!({ agentId: AGENT, tasks: [task] });
    expect(store.get(backgroundTasksByAgentAtom)[AGENT]).toEqual([task]);
    tasksListener!({ agentId: AGENT, tasks: [{ ...task, status: "completed" }] });
    expect(store.get(backgroundTasksByAgentAtom)[AGENT]?.[0]?.status).toBe("completed");
    removedListener!(AGENT);
    expect(store.get(backgroundTasksByAgentAtom)[AGENT]).toBeUndefined();
    unbind();
  });
});

describe("删除会话", () => {
  it("deleteSession 调 agent.delete 并从 store 移除", async () => {
    const store = createStore();
    store.set(upsertAgentSnapshotAtom, snapshot());
    const client = fakeClient(async () => ({}));
    await createAgentSessionActions(client, store).deleteSession(AGENT);
    expect(client.request).toHaveBeenCalledWith("agent.delete", { agentId: AGENT });
    expect(store.get(agentSnapshotsAtom)[AGENT]).toBeUndefined();
    expect(store.get(lastRemovedAgentAtom)?.agentId).toBe(AGENT);
  });

  it("bindSidecarToStore：agent.removed 通知移除会话", () => {
    const store = createStore();
    store.set(upsertAgentSnapshotAtom, snapshot());
    let removedListener: ((agentId: string) => void) | null = null;
    const noop = () => () => {};
    const client = {
      onState: noop,
      onStream: noop,
      onAgentState: noop,
      onAgents: noop,
      onEpochChange: noop,
      onSubagentUpdate: noop,
      onTasksUpdate: noop,
      onAgentRemoved: (listener: (agentId: string) => void) => {
        removedListener = listener;
        return () => {};
      },
    } as unknown as SidecarClient;

    const unbind = bindSidecarToStore(client, store);
    removedListener!(AGENT);
    expect(store.get(agentSnapshotsAtom)[AGENT]).toBeUndefined();
    expect(store.get(lastRemovedAgentAtom)).toEqual({ agentId: AGENT, nonce: 1 });
    unbind();
  });
});

describe("调度器绑定与动作（design.md 4.25）", () => {
  const schedule = {
    id: "s1", name: "x", enabled: true, createdAt: 1, updatedAt: 1, kind: "heartbeat", agentId: "a", idleMinutes: 5, prompt: "p", runs: 0,
  } as const;

  it("schedule.changed 整表写入 store；每次拉到 agent.list 后重新拉 schedule.list；notice 触发通知", async () => {
    const store = createStore();
    let onChanged: (value: { schedules: unknown[]; paused: boolean }) => void = () => {};
    let onAgents: () => void = () => {};
    const request = vi.fn(async () => ({ schedules: [schedule], paused: true }));
    const client = {
      request,
      onScheduleChanged: (listener: typeof onChanged) => { onChanged = listener; return () => {}; },
      onScheduleNotice: () => () => {},
      onAgents: (listener: () => void) => { onAgents = listener; return () => {}; },
    } as unknown as SidecarClient;
    const unbind = bindSchedulesToStore(client, store);

    onAgents();
    await vi.waitFor(() => expect(store.get(schedulesStateAtom).loaded).toBe(true));
    expect(request).toHaveBeenCalledWith("schedule.list");
    expect(store.get(schedulesStateAtom)).toMatchObject({ schedules: [schedule], paused: true });

    onChanged({ schedules: [], paused: false });
    expect(store.get(schedulesStateAtom)).toMatchObject({ schedules: [], paused: false });
    unbind();
  });

  it("动作：upsert / delete / runNow / runs / setPaused 对应的 RPC 参数", async () => {
    const store = createStore();
    const client = fakeClient(async (method) => {
      if (method === "schedule.upsert") return { schedule };
      if (method === "schedule.runs") return { runs: [{ scheduleId: "s1", ts: 1, outcome: "sent" }] };
      if (method === "schedule.setPaused") return { paused: true };
      return {};
    });
    const actions = createAgentSessionActions(client, store);
    expect(await actions.upsertSchedule(schedule)).toEqual(schedule);
    await actions.deleteSchedule("s1");
    await actions.runScheduleNow("s1");
    expect(await actions.listScheduleRuns("s1", 20)).toHaveLength(1);
    await actions.listScheduleRuns();
    expect(await actions.setSchedulesPaused(true)).toBe(true);
    expect(client.request.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ["schedule.upsert", { schedule }],
      ["schedule.delete", { id: "s1" }],
      ["schedule.runNow", { id: "s1" }],
      ["schedule.runs", { id: "s1", limit: 20 }],
      ["schedule.runs", {}],
      ["schedule.setPaused", { paused: true }],
    ]);
  });
});

describe("steerPrompt（design.md 4.22）", () => {
  it("请求 agent.steer 并带上 clientMessageId，不做乐观插入", async () => {
    const store = createStore();
    const client = fakeClient(async () => ({}));
    const actions = createAgentSessionActions(client, store);
    const { clientMessageId } = await actions.steerPrompt(AGENT, "补充一句", { clientMessageId: "cm-9" });
    expect(clientMessageId).toBe("cm-9");
    expect(client.request).toHaveBeenCalledWith("agent.steer", { agentId: AGENT, prompt: "补充一句", clientMessageId: "cm-9" });
    expect(store.get(chatRuntimeBySessionAtom)[AGENT]).toBeUndefined();
  });

  it("失败时抛出中文提示的 Error", async () => {
    const client = fakeClient(async () => {
      throw rpcError("NOT_SUPPORTED", "该 Agent 不支持运行中插话");
    });
    const actions = createAgentSessionActions(client, createStore());
    await expect(actions.steerPrompt(AGENT, "x")).rejects.toThrow("该 Agent 不支持运行中插话");
  });
});
