// 持久化会话相关的动作层：dormant / closed 发送的错误映射、恢复提示、删除与 agent.removed 绑定。
import { describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import type { AgentSnapshot } from "@agentdeck/protocol";
import { SidecarRpcError, type SidecarClient } from "@/lib/sidecar-client";
import {
  AgentSendError,
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
