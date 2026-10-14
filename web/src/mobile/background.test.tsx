// @vitest-environment jsdom
// 后台保持连接：偏好存储、前台服务启停时机、「正在同步…」提示、设置页开关。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SidecarClient } from "@/lib/sidecar-client";
import type { ConnectionPhase, ConnectionSnapshot } from "./connection-manager";
import { KeepAliveController, keepAliveText, type KeepAliveNative } from "./native/keepalive-controller";
import { PREFERENCES_KEY, PreferencesStore } from "./preferences";
import { Settings } from "./settings";
import { SyncBanner, useClientSyncing } from "./sync-indicator";

afterEach(() => cleanup());

class MemoryStorage {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

describe("PreferencesStore", () => {
  it("后台保持连接默认开、首次引导默认未弹；修改后持久化并通知订阅方", () => {
    const storage = new MemoryStorage();
    const prefs = new PreferencesStore(storage);
    expect(prefs.getState()).toEqual({ keepAlive: true, keepAliveGuided: false });

    const listener = vi.fn();
    prefs.subscribe(listener);
    prefs.setKeepAlive(false);
    prefs.setKeepAlive(false);
    prefs.markKeepAliveGuided();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(JSON.parse(storage.data.get(PREFERENCES_KEY)!)).toEqual({ keepAlive: false, keepAliveGuided: true });

    const reloaded = new PreferencesStore(storage);
    expect(reloaded.getState()).toEqual({ keepAlive: false, keepAliveGuided: true });
  });

  it("存储损坏 / 不可用时回到默认值，不抛错", () => {
    const storage = new MemoryStorage();
    storage.setItem(PREFERENCES_KEY, "{坏的");
    expect(new PreferencesStore(storage).getState().keepAlive).toBe(true);
    expect(new PreferencesStore(null).getState().keepAlive).toBe(true);
  });
});

function snapshot(phase: ConnectionPhase, hostId: string | null = "h1"): ConnectionSnapshot {
  return {
    hostId: phase === "idle" ? null : hostId,
    phase,
    error: null,
    authReason: null,
    client: phase === "idle" ? null : ({} as SidecarClient),
    store: null,
  };
}

function rig(initialKeepAlive = true) {
  let connection = snapshot("idle");
  const connectionListeners = new Set<() => void>();
  const storage = new MemoryStorage();
  const prefs = new PreferencesStore(storage);
  prefs.setKeepAlive(initialKeepAlive);
  const calls: string[] = [];
  const native: KeepAliveNative = {
    start: async (text) => {
      calls.push(`start:${text}`);
    },
    stop: async () => {
      calls.push("stop");
    },
  };
  const names: Record<string, string> = { h1: "书房电脑", h2: "公司电脑" };
  const controller = new KeepAliveController(
    {
      getConnection: () => connection,
      subscribeConnection: (listener) => {
        connectionListeners.add(listener);
        return () => connectionListeners.delete(listener);
      },
      getPreferences: prefs.getState,
      subscribePreferences: prefs.subscribe,
      hostName: (id) => names[id],
    },
    native,
  );
  const setConnection = (next: ConnectionSnapshot) => {
    connection = next;
    for (const listener of [...connectionListeners]) listener();
  };
  return { controller, prefs, calls, setConnection };
}

describe("KeepAliveController 启停时机", () => {
  it("连上电脑才启动前台服务（文案带电脑名）；连接中不启动", () => {
    const { calls, setConnection } = rig();
    expect(calls).toEqual([]);
    setConnection(snapshot("connecting"));
    expect(calls).toEqual([]);
    setConnection(snapshot("open"));
    expect(calls).toEqual(["start:AgentDeck 已连接：书房电脑"]);
    setConnection(snapshot("open"));
    expect(calls).toHaveLength(1);
  });

  it("启动后短暂断线（自动重连中）保持服务，只更新文案；重连成功再改回", () => {
    const { calls, setConnection } = rig();
    setConnection(snapshot("open"));
    setConnection(snapshot("failed"));
    setConnection(snapshot("connecting"));
    setConnection(snapshot("open"));
    expect(calls).toEqual([
      "start:AgentDeck 已连接：书房电脑",
      "start:AgentDeck 重连中：书房电脑",
      "start:AgentDeck 已连接：书房电脑",
    ]);
    expect(calls).not.toContain("stop");
  });

  it("用户断开 / 删除电脑（idle）与凭据失效（auth_failed）时停止", () => {
    const { calls, setConnection } = rig();
    setConnection(snapshot("open"));
    setConnection(snapshot("idle"));
    expect(calls.at(-1)).toBe("stop");

    setConnection(snapshot("open"));
    setConnection(snapshot("auth_failed"));
    expect(calls.at(-1)).toBe("stop");
    expect(calls.filter((c) => c === "stop")).toHaveLength(2);
  });

  it("从没连上过的电脑（一直连不上）不启动；切换电脑后要重新连上才启动", () => {
    const { calls, setConnection } = rig();
    setConnection(snapshot("connecting", "h1"));
    setConnection(snapshot("failed", "h1"));
    expect(calls).toEqual([]);

    setConnection(snapshot("open", "h1"));
    setConnection(snapshot("idle"));
    setConnection(snapshot("connecting", "h2"));
    expect(calls).toEqual(["start:AgentDeck 已连接：书房电脑", "stop"]);
    setConnection(snapshot("open", "h2"));
    expect(calls.at(-1)).toBe("start:AgentDeck 已连接：公司电脑");
  });

  it("关闭开关立即停止，再打开（已连着）立即启动", () => {
    const { calls, prefs, setConnection } = rig();
    setConnection(snapshot("open"));
    prefs.setKeepAlive(false);
    expect(calls.at(-1)).toBe("stop");
    setConnection(snapshot("failed"));
    expect(calls.filter((c) => c.startsWith("start")).length).toBe(1);
    prefs.setKeepAlive(true);
    expect(calls.at(-1)).toBe("start:AgentDeck 重连中：书房电脑");
  });

  it("开关关闭时连上电脑不启动；dispose 后停止服务且不再响应", () => {
    const off = rig(false);
    off.setConnection(snapshot("open"));
    expect(off.calls).toEqual([]);

    const on = rig();
    on.setConnection(snapshot("open"));
    on.controller.dispose();
    expect(on.calls.at(-1)).toBe("stop");
    const before = on.calls.length;
    on.setConnection(snapshot("failed"));
    expect(on.calls).toHaveLength(before);
  });

  it("文案兜底：取不到电脑名用「电脑」", () => {
    expect(keepAliveText(undefined, true)).toBe("AgentDeck 已连接：电脑");
  });
});

describe("正在同步提示", () => {
  function fakeClient() {
    const listeners = new Set<(value: boolean) => void>();
    const client = {
      syncing: false,
      onSyncing(listener: (value: boolean) => void) {
        listener(client.syncing);
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const set = (value: boolean) => {
      client.syncing = value;
      for (const listener of [...listeners]) listener(value);
    };
    return { client, set };
  }

  function Probe({ client }: { client: ReturnType<typeof fakeClient>["client"] }) {
    const syncing = useClientSyncing(client);
    return syncing ? <SyncBanner /> : null;
  }

  it("补齐开始时出现，结束后自动消失", () => {
    const { client, set } = fakeClient();
    render(<Probe client={client} />);
    expect(screen.queryByText("正在同步…")).toBeNull();
    act(() => set(true));
    expect(screen.getByText("正在同步…")).toBeTruthy();
    act(() => set(false));
    expect(screen.queryByText("正在同步…")).toBeNull();
  });

  it("没有 client 时不显示", () => {
    function Empty() {
      return useClientSyncing(null) ? <SyncBanner /> : null;
    }
    render(<Empty />);
    expect(screen.queryByText("正在同步…")).toBeNull();
  });
});

describe("设置页：后台保持连接开关", () => {
  it("开关反映偏好并可切换", () => {
    const prefs = new PreferencesStore(new MemoryStorage());
    render(
      <Settings
        host={undefined}
        connection={snapshot("idle")}
        deviceName="Pixel"
        prefs={prefs}
        onRenameDevice={() => {}}
        onSwitchHost={() => {}}
        onDisconnect={() => {}}
        onDeleteHost={() => {}}
      />,
    );
    const toggle = screen.getByRole("switch", { name: "后台保持连接" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(prefs.getState().keepAlive).toBe(false);
    expect(toggle.checked).toBe(false);
  });
});
