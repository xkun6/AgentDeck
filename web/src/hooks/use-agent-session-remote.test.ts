import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { RemoteStatus } from "@agentdeck/protocol";
import { AGENT_QUERY_KEYS } from "@/lib/agent-query-keys";
import type { SidecarConnectionState } from "@/lib/sidecar-client";
import { bindDesktopPresence, bindRemoteToQueries, PRESENCE_HEARTBEAT_MS } from "./use-agent-session";

function fakeDocument(initial: "visible" | "hidden") {
  const listeners = new Set<() => void>();
  return {
    visibilityState: initial as DocumentVisibilityState,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    setVisibility(next: DocumentVisibilityState) {
      this.visibilityState = next;
      for (const listener of Array.from(listeners)) listener();
    },
    listenerCount: () => listeners.size,
  };
}

function fakeClient(initial: SidecarConnectionState = "idle") {
  const stateListeners = new Set<(state: SidecarConnectionState) => void>();
  const request = vi.fn().mockResolvedValue({});
  let state = initial;
  return {
    request,
    onState(listener: (state: SidecarConnectionState) => void) {
      stateListeners.add(listener);
      listener(state);
      return () => stateListeners.delete(listener);
    },
    setState(next: SidecarConnectionState) {
      state = next;
      for (const listener of Array.from(stateListeners)) listener(next);
    },
    listenerCount: () => stateListeners.size,
  };
}

const presenceCalls = (request: ReturnType<typeof vi.fn>) =>
  request.mock.calls.filter((call) => call[0] === "client.presence").map((call) => call[1]);

describe("bindDesktopPresence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("连接成功时上报一次 desktop 可见状态；未连接时不上报", () => {
    const client = fakeClient("idle");
    const doc = fakeDocument("visible");
    const unbind = bindDesktopPresence(client as never, doc as never);
    expect(client.request).not.toHaveBeenCalled();
    client.setState("connecting");
    expect(client.request).not.toHaveBeenCalled();
    client.setState("open");
    expect(presenceCalls(client.request)).toEqual([{ kind: "desktop", visible: true }]);
    unbind();
  });

  it("绑定时连接已打开则立即上报；重连成功会再次上报，open 期间重复通知不重复上报", () => {
    const client = fakeClient("open");
    const doc = fakeDocument("hidden");
    const unbind = bindDesktopPresence(client as never, doc as never);
    expect(presenceCalls(client.request)).toEqual([{ kind: "desktop", visible: false }]);
    client.setState("open");
    expect(client.request).toHaveBeenCalledTimes(1);
    client.setState("closed");
    client.setState("open");
    expect(client.request).toHaveBeenCalledTimes(2);
    unbind();
  });

  it("窗口可见性变化时上报最新状态", () => {
    const client = fakeClient("open");
    const doc = fakeDocument("visible");
    const unbind = bindDesktopPresence(client as never, doc as never);
    client.request.mockClear();
    doc.setVisibility("hidden");
    doc.setVisibility("visible");
    expect(presenceCalls(client.request)).toEqual([
      { kind: "desktop", visible: false },
      { kind: "desktop", visible: true },
    ]);
    unbind();
  });

  it("可见期间每 30 秒心跳一次，不可见时不发心跳", () => {
    const client = fakeClient("open");
    const doc = fakeDocument("visible");
    const unbind = bindDesktopPresence(client as never, doc as never);
    client.request.mockClear();
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 2);
    expect(presenceCalls(client.request)).toHaveLength(2);

    doc.setVisibility("hidden");
    client.request.mockClear();
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 3);
    expect(client.request).not.toHaveBeenCalled();
    unbind();
  });

  it("上报失败被吞掉；解绑后不再上报并移除监听", () => {
    const client = fakeClient("open");
    client.request.mockRejectedValue(new Error("断开"));
    const doc = fakeDocument("visible");
    const unbind = bindDesktopPresence(client as never, doc as never);
    expect(doc.listenerCount()).toBe(1);
    unbind();
    expect(doc.listenerCount()).toBe(0);
    expect(client.listenerCount()).toBe(0);
    client.request.mockClear();
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 2);
    doc.setVisibility("hidden");
    expect(client.request).not.toHaveBeenCalled();
  });
});

describe("bindRemoteToQueries", () => {
  it("remote.changed 直接写入 remote.status 缓存，解绑后不再写入", () => {
    let listener: ((status: RemoteStatus) => void) | null = null;
    const client = {
      onRemoteChanged: (next: (status: RemoteStatus) => void) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
    };
    const queryClient = new QueryClient();
    const unbind = bindRemoteToQueries(client, queryClient);
    const status: RemoteStatus = { enabled: true, port: 47_631, listening: true, addresses: [], devices: [] };
    listener!(status);
    expect(queryClient.getQueryData(AGENT_QUERY_KEYS.remoteStatus)).toEqual(status);
    unbind();
    expect(listener).toBeNull();
    queryClient.clear();
  });
});
