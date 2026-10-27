// @vitest-environment jsdom
// 发送队列自动出队：在应用根部监视所有会话，不依赖详情页正在显示哪个会话。
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import type { AgentSnapshot } from "@agentdeck/protocol";

const sendPrompt = vi.fn(async () => ({ turnId: "t1", clientMessageId: "cm-1" }));

vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => ({ sendPrompt }),
}));
vi.mock("@/hooks/use-provider-config", () => ({
  useProviderConfig: () => ({ data: undefined }),
}));

import { agentSnapshotsAtom } from "@/stores/agents";
import {
  enqueueQueuedPrompt,
  entriesFor,
  markQueueInterrupted,
  removeQueuedPrompt,
  useQueueState,
} from "@/stores/composer-queue";
import { useQueueAutoDrain } from "./use-queue-auto-drain";

function snapshot(id: string, status: AgentSnapshot["status"]): AgentSnapshot {
  return { id, provider: "claude", cwd: "/work", status } as AgentSnapshot;
}

function setup() {
  const store = createStore();
  const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
  const { result } = renderHook(() => {
    useQueueAutoDrain();
    return useQueueState();
  }, { wrapper });
  const setStatus = (statuses: Record<string, AgentSnapshot["status"]>) =>
    act(() => {
      store.set(
        agentSnapshotsAtom,
        Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, snapshot(id, status)])),
      );
    });
  const queued = (key: string) => entriesFor(result.current, key);
  return { setStatus, queued };
}

const enqueued: Array<[string, string]> = [];

function enqueue(key: string, text: string) {
  act(() => {
    const entry = enqueueQueuedPrompt(key, { text, attachments: [] }, 1);
    if (entry) enqueued.push([key, entry.id]);
  });
}

afterEach(() => {
  cleanup();
  sendPrompt.mockClear();
  for (const [key, id] of enqueued.splice(0)) removeQueuedPrompt(key, id);
});

describe("useQueueAutoDrain", () => {
  it("回合结束时发出队首排队消息（与是否在看该会话无关）", async () => {
    const { setStatus, queued } = setup();
    setStatus({ s1: "running", s2: "idle" });
    enqueue("s1", "排队的话");
    setStatus({ s1: "idle", s2: "idle" });

    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    expect(sendPrompt).toHaveBeenCalledWith("s1", "排队的话", expect.objectContaining({ providerDisabled: false }));
    await waitFor(() => expect(queued("s1")).toHaveLength(0));
  });

  it("用户中止的那一轮结束时不自动出队，下一轮结束时照常发出", async () => {
    const { setStatus } = setup();
    setStatus({ s1: "running" });
    enqueue("s1", "等会儿再发");
    markQueueInterrupted("s1");
    setStatus({ s1: "idle" });
    expect(sendPrompt).not.toHaveBeenCalled();

    setStatus({ s1: "running" });
    setStatus({ s1: "idle" });
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
  });

  it("首次看到就是空闲的会话不自动发出（如重启后恢复的队列）", () => {
    enqueue("s2", "旧消息");
    const { setStatus } = setup();
    setStatus({ s2: "idle" });
    expect(sendPrompt).not.toHaveBeenCalled();
  });
});
