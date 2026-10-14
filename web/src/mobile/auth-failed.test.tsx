// @vitest-environment jsdom
// 凭据失效（含被吊销）：不再显示旧会话列表，整页只剩说明与重新配对入口。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createStore } from "jotai";
import { HostStore, type HostsState } from "@/lib/remote/hosts";
import { stubRadixGlobals } from "@/test-utils/radix";
import type { ConnectionManager, ConnectionSnapshot } from "./connection-manager";
import { MobileApp } from "./mobile-app";
import { PreferencesStore } from "./preferences";

vi.mock("@/hooks/use-agent-session", () => ({
  useSidecarBridge: () => {},
  useAgentSession: () => ({ listSessions: async () => [] }),
  humanizeSidecarError: String,
}));
vi.mock("./session-list", () => ({ SessionList: () => <div>旧会话列表</div> }));

stubRadixGlobals();

beforeEach(() => {
  window.location.hash = "#/sessions";
});
afterEach(cleanup);

function setup(phase: ConnectionSnapshot["phase"], authReason: ConnectionSnapshot["authReason"]) {
  const fakeClient = { onSyncing: () => () => {}, syncing: false, onAttention: () => () => {} };
  const snapshot = {
    hostId: "h1",
    phase,
    error: null,
    authReason,
    client: fakeClient,
    store: createStore(),
  } as unknown as ConnectionSnapshot;
  const manager = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as ConnectionManager;
  const state: HostsState = {
    hosts: [{ id: "h1", name: "电脑", daemonPublicKey: "k", addresses: [], deviceId: "d", deviceSecret: "s", pairedAt: 1 }],
    activeHostId: "h1",
    deviceName: "手机",
  } as HostsState;
  const hosts = new HostStore({ read: async () => state, write: async () => {} });
  return { manager, hosts };
}

async function renderApp(phase: ConnectionSnapshot["phase"], authReason: ConnectionSnapshot["authReason"]) {
  const { manager, hosts } = setup(phase, authReason);
  await hosts.load();
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <MobileApp hosts={hosts} manager={manager} prefs={new PreferencesStore(null)} />
    </QueryClientProvider>,
  );
  await act(async () => {});
}

describe("凭据失效", () => {
  it("被吊销：不显示会话列表与底部导航，只有说明和「重新配对」入口，点击进入配对页", async () => {
    await renderApp("auth_failed", "revoked");
    expect(screen.getByText("此设备已被吊销，请重新配对")).toBeTruthy();
    expect(screen.queryByText("旧会话列表")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "主导航" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新配对" }));
    expect(window.location.hash).toBe("#/pair");
  });

  it("其它失效原因给出通用提示", async () => {
    await renderApp("auth_failed", "invalid");
    expect(screen.getByText("凭据已失效，请重新配对")).toBeTruthy();
    expect(screen.queryByText("旧会话列表")).toBeNull();
  });

  it("正常连接时仍显示会话列表与导航", async () => {
    await renderApp("open", null);
    expect(screen.getByText("旧会话列表")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeTruthy();
  });
});
