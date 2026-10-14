// @vitest-environment jsdom
// 后台运行小节：电池优化 / 通知状态与按钮、厂商指引、被冻结的说明，以及首次开启「后台保持连接」的一次性引导。
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BATTERY_NOT_WHITELISTED, BackgroundGuideDialog, BackgroundSection, BANNER_HINT, FROZEN_NOTE, NotifyModeSection } from "./background-section";
import { setNativeBackend, type NativeBackend } from "./native/native-plugin";
import { PreferencesStore } from "./preferences";

afterEach(() => {
  cleanup();
  setNativeBackend(null);
});

class MemoryStorage {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

function fakeBackend(state: { ignoring: boolean; notifications: boolean }, permission: "granted" | "denied" = "granted") {
  const calls: string[] = [];
  const backend: NativeBackend = {
    invoke: async (command) => {
      calls.push(command);
      if (command === "battery_optimization_status") return { ignoring: state.ignoring };
      if (command === "notification_status") return { enabled: state.notifications };
      return null;
    },
    requestNotificationPermission: async () => {
      calls.push("request_notification_permission");
      if (permission === "granted") state.notifications = true;
      return permission;
    },
  };
  setNativeBackend(backend);
  return { calls, state };
}

const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

describe("设置页「后台运行」小节", () => {
  it("显示通知与电池优化状态；未放行时给出按钮，点击调用对应原生命令", async () => {
    const { calls } = fakeBackend({ ignoring: false, notifications: false });
    render(<BackgroundSection prefs={new PreferencesStore(new MemoryStorage())} />);
    await flush();
    expect(screen.getByText("未开启：后台收不到提醒")).toBeTruthy();
    expect(screen.getByText(BATTERY_NOT_WHITELISTED)).toBeTruthy();
    expect(screen.getByText(BATTERY_NOT_WHITELISTED).getAttribute("data-state")).toBeNull(); // 中性，不标红

    fireEvent.click(screen.getByRole("button", { name: "请求忽略电池优化" }));
    fireEvent.click(screen.getByRole("button", { name: "打开应用设置" }));
    await flush();
    expect(calls).toContain("request_ignore_battery_optimization");
    expect(calls).toContain("open_app_settings");

    // 华为等机型把「待审批」降为不弹横幅：给出引导文案与直达 channel 设置页的按钮
    expect(screen.getByText(BANNER_HINT)).toBeTruthy();
    expect(BANNER_HINT).toContain("系统设置 → 通知 → AgentDeck → 待审批");
    fireEvent.click(screen.getByRole("button", { name: "打开「待审批」通知设置" }));
    await flush();
    expect(calls).toContain("open_channel_settings");
  });

  it("已放行：显示已忽略 / 已开启，不再给请求按钮", async () => {
    fakeBackend({ ignoring: true, notifications: true });
    render(<BackgroundSection prefs={new PreferencesStore(new MemoryStorage())} />);
    await flush();
    expect(screen.getByText("已忽略（不受电池优化限制）")).toBeTruthy();
    expect(screen.getByText("已开启")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "请求忽略电池优化" })).toBeNull();
    expect(screen.queryByRole("button", { name: "开启通知" })).toBeNull();
  });

  it("开启通知：系统框允许后刷新为已开启；被拒（系统不再弹框）时引导去应用设置", async () => {
    const granted = fakeBackend({ ignoring: true, notifications: false });
    const { unmount } = render(<BackgroundSection prefs={new PreferencesStore(new MemoryStorage())} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "开启通知" }));
    await flush();
    expect(granted.calls).toContain("request_notification_permission");
    expect(granted.calls).not.toContain("open_app_settings");
    expect(screen.getByText("已开启")).toBeTruthy();
    unmount();

    const denied = fakeBackend({ ignoring: true, notifications: false }, "denied");
    render(<BackgroundSection prefs={new PreferencesStore(new MemoryStorage())} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "开启通知" }));
    await flush();
    expect(denied.calls).toContain("open_app_settings");
  });

  it("从系统设置页回到前台（visibilitychange）时重新查询状态", async () => {
    const { state } = fakeBackend({ ignoring: false, notifications: true });
    render(<BackgroundSection prefs={new PreferencesStore(new MemoryStorage())} />);
    await flush();
    expect(screen.getByText(BATTERY_NOT_WHITELISTED)).toBeTruthy();
    state.ignoring = true;
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(screen.getByText("已忽略（不受电池优化限制）")).toBeTruthy();
  });

  it("厂商指引（华为 / 荣耀、小米、OPPO / vivo）与被冻结后自动补齐的说明始终显示；非 Tauri 环境不显示原生状态", () => {
    render(<BackgroundSection prefs={new PreferencesStore(new MemoryStorage())} />);
    expect(screen.getByText("华为 / 荣耀")).toBeTruthy();
    expect(screen.getByText("小米 / Redmi")).toBeTruthy();
    expect(screen.getByText("OPPO / vivo / 一加")).toBeTruthy();
    expect(screen.getAllByText(/允许自启动/).length).toBeGreaterThan(0);
    expect(screen.getByText(FROZEN_NOTE)).toBeTruthy();
    expect(FROZEN_NOTE).toContain("不会丢消息");
    expect(screen.queryByRole("button", { name: "打开应用设置" })).toBeNull();
  });
});

describe("首次开启「后台保持连接」引导", () => {
  it("开关为开且未引导过时弹出；点「知道了」后写入偏好，不再弹", async () => {
    fakeBackend({ ignoring: false, notifications: true });
    const storage = new MemoryStorage();
    const prefs = new PreferencesStore(storage);
    const { unmount } = render(<BackgroundGuideDialog prefs={prefs} />);
    await flush();
    expect(screen.getByRole("dialog", { name: "后台保持连接引导" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "请求忽略电池优化" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(prefs.getState().keepAliveGuided).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();

    render(<BackgroundGuideDialog prefs={new PreferencesStore(storage)} />);
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("开关关闭或非 Tauri 环境不弹", async () => {
    fakeBackend({ ignoring: false, notifications: true });
    const off = new PreferencesStore(new MemoryStorage());
    off.setKeepAlive(false);
    const { unmount } = render(<BackgroundGuideDialog prefs={off} />);
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();

    setNativeBackend(null);
    render(<BackgroundGuideDialog prefs={new PreferencesStore(new MemoryStorage())} />);
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("关闭开关后再打开（偏好变化）时按未引导过处理", async () => {
    fakeBackend({ ignoring: true, notifications: true });
    const prefs = new PreferencesStore(new MemoryStorage());
    prefs.setKeepAlive(false);
    render(<BackgroundGuideDialog prefs={prefs} />);
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => prefs.setKeepAlive(true));
    await flush();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("设置页「通知」单选", () => {
  it("默认总是通知；选择后写入偏好并持久化", () => {
    const storage = new MemoryStorage();
    const prefs = new PreferencesStore(storage);
    render(<NotifyModeSection prefs={prefs} />);
    expect((screen.getByRole("radio", { name: "总是通知" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "仅在前台时" }));
    expect(prefs.getState().notifyMode).toBe("foreground");
    expect((screen.getByRole("radio", { name: "仅在前台时" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "从不通知" }));
    expect(new PreferencesStore(storage).getState().notifyMode).toBe("never");
  });
});
