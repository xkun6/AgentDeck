import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getBatteryOptimization,
  getNotificationsEnabled,
  keepaliveStart,
  keepaliveStop,
  nativeAvailable,
  onNotificationClicked,
  openAppSettings,
  requestIgnoreBatteryOptimization,
  requestNotificationPermission,
  setNativeBackend,
  cancelAttentionNotification,
  showAttentionNotification,
  takeLaunchTarget,
} from "./native-plugin";

afterEach(() => {
  setNativeBackend(null);
  vi.restoreAllMocks();
});

describe("原生包装在非 Tauri 环境下是 no-op", () => {
  it("全部不抛错并返回不支持的默认值", async () => {
    expect(nativeAvailable()).toBe(false);
    expect(await keepaliveStart("AgentDeck 已连接：PC")).toBe(false);
    expect(await keepaliveStop()).toBe(false);
    expect(await getBatteryOptimization()).toEqual({ supported: false, ignoring: false });
    expect(await requestIgnoreBatteryOptimization()).toBe(false);
    expect(await openAppSettings()).toBe(false);
    expect(await showAttentionNotification({ id: 1, title: "t", body: "b", kind: "finished" })).toBe(false);
    expect(await cancelAttentionNotification(1)).toBe(false);
    expect(await getNotificationsEnabled()).toBeNull();
    expect(await requestNotificationPermission()).toBe("unsupported");
    expect(await takeLaunchTarget()).toBeNull();
    const off = await onNotificationClicked(() => {});
    expect(() => off()).not.toThrow();
  });
});

describe("原生包装转发命令", () => {
  it("命令名与 NativePlugin 一致，参数原样传递", async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    setNativeBackend({
      invoke: async (command, args) => {
        calls.push([command, args]);
        if (command === "battery_optimization_status") return { ignoring: true };
        if (command === "notification_status") return { enabled: false };
        return null;
      },
    });
    expect(nativeAvailable()).toBe(true);
    expect(await keepaliveStart("AgentDeck 已连接：PC")).toBe(true);
    expect(await keepaliveStart("x", { wakeLock: true })).toBe(true);
    expect(await keepaliveStop()).toBe(true);
    expect(await getBatteryOptimization()).toEqual({ supported: true, ignoring: true });
    expect(await requestIgnoreBatteryOptimization()).toBe(true);
    expect(await openAppSettings()).toBe(true);
    expect(await getNotificationsEnabled()).toBe(false);
    expect(await showAttentionNotification({ id: 7, title: "标题", body: "正文", kind: "permission", agentId: "a1" })).toBe(true);
    expect(await cancelAttentionNotification(7)).toBe(true);
    expect(calls).toEqual([
      ["keepalive_start", { text: "AgentDeck 已连接：PC", wakeLock: false }],
      ["keepalive_start", { text: "x", wakeLock: true }],
      ["keepalive_stop", undefined],
      ["battery_optimization_status", undefined],
      ["request_ignore_battery_optimization", undefined],
      ["open_app_settings", undefined],
      ["notification_status", undefined],
      ["show_attention", { id: 7, title: "标题", body: "正文", kind: "permission", agentId: "a1" }],
      ["cancel_attention", { id: 7 }],
    ]);
  });

  it("原生调用失败时吞掉错误并返回失败", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setNativeBackend({
      invoke: async () => {
        throw new Error("boom");
      },
    });
    expect(await keepaliveStart("x")).toBe(false);
    expect(await getBatteryOptimization()).toEqual({ supported: false, ignoring: false });
    expect(await getNotificationsEnabled()).toBeNull();
  });

  it("通知点击事件与冷启动目标：只取 agentId，缺省时目标为空对象", async () => {
    let handler: ((payload: unknown) => void) | null = null;
    const unlisten = vi.fn();
    setNativeBackend({
      invoke: async (command) => (command === "take_launch_target" ? { target: { agentId: "a9" } } : null),
      listen: async (event, h) => {
        expect(event).toBe("notificationClicked");
        handler = h;
        return unlisten;
      },
    });
    const clicks: unknown[] = [];
    const off = await onNotificationClicked((target) => clicks.push(target));
    handler!({ agentId: "a1" });
    handler!({});
    handler!(null);
    expect(clicks).toEqual([{ agentId: "a1" }, {}, {}]);
    off();
    expect(unlisten).toHaveBeenCalled();
    expect(await takeLaunchTarget()).toEqual({ agentId: "a9" });
  });

  it("没有冷启动目标时 takeLaunchTarget 返回 null；通知权限申请透传结果，异常按拒绝处理", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = vi.fn().mockResolvedValueOnce("granted").mockRejectedValueOnce(new Error("x"));
    setNativeBackend({ invoke: async () => ({}), requestNotificationPermission: request });
    expect(await takeLaunchTarget()).toBeNull();
    expect(await requestNotificationPermission()).toBe("granted");
    expect(await requestNotificationPermission()).toBe("denied");
  });
});
