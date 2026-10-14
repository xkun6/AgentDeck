// @vitest-environment jsdom
// 前后台状态：原生 appState 优先；原生状态未知时跟随页面可见性；只在真正变化时通知。
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAppForeground, resetAppStateForTest, startAppStateTracking, subscribeAppForeground } from "./app-state";
import { getAppForeground, setNativeBackend } from "./native-plugin";

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  resetAppStateForTest();
  setNativeBackend(null);
  setVisibility("visible");
});

describe("app-state", () => {
  it("非原生环境：跟随 document.visibilityState", () => {
    const listener = vi.fn();
    subscribeAppForeground(listener);
    expect(isAppForeground()).toBe(true);
    setVisibility("hidden");
    expect(isAppForeground()).toBe(false);
    setVisibility("visible");
    expect(listener.mock.calls).toEqual([[false], [true]]);
  });

  it("原生环境：以 appState 为准，页面一直 visible 也能判定为后台；回前台再通知", async () => {
    let handler: ((payload: unknown) => void) | null = null;
    setNativeBackend({
      invoke: async (command) => (command === "app_state" ? { foreground: true } : null),
      listen: async (event, h) => {
        expect(event).toBe("appState");
        handler = h;
        return () => {};
      },
    });
    const listener = vi.fn();
    subscribeAppForeground(listener);
    await startAppStateTracking();
    expect(isAppForeground()).toBe(true);
    expect(listener).not.toHaveBeenCalled();

    handler!({ foreground: false });
    expect(isAppForeground()).toBe(false); // 页面 visibilityState 仍是 visible
    handler!({ foreground: false });
    handler!({ foreground: true });
    expect(isAppForeground()).toBe(true);
    expect(listener.mock.calls).toEqual([[false], [true]]);
  });

  it("原生状态已知后，页面可见性变化不再影响判断", async () => {
    setNativeBackend({
      invoke: async () => ({ foreground: true }),
      listen: async () => () => {},
    });
    const listener = vi.fn();
    subscribeAppForeground(listener);
    await startAppStateTracking();
    setVisibility("hidden");
    expect(isAppForeground()).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it("getAppForeground 在非 Tauri 环境返回 null，返回值异常时返回 null", async () => {
    expect(await getAppForeground()).toBeNull();
    setNativeBackend({ invoke: async () => ({ foreground: "yes" }) });
    expect(await getAppForeground()).toBeNull();
  });
});
