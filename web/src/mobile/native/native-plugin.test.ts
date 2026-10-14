import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getBatteryOptimization,
  keepaliveStart,
  keepaliveStop,
  nativeAvailable,
  openAppSettings,
  requestIgnoreBatteryOptimization,
  setNativeInvoker,
} from "./native-plugin";

afterEach(() => {
  setNativeInvoker(null);
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
  });
});

describe("原生包装转发命令", () => {
  it("keepalive_start 带文案与 wakeLock，其余命令名与插件一致", async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    setNativeInvoker(async (command, args) => {
      calls.push([command, args]);
      return command === "battery_optimization_status" ? { ignoring: true } : null;
    });
    expect(nativeAvailable()).toBe(true);
    expect(await keepaliveStart("AgentDeck 已连接：PC")).toBe(true);
    expect(await keepaliveStart("x", { wakeLock: true })).toBe(true);
    expect(await keepaliveStop()).toBe(true);
    expect(await getBatteryOptimization()).toEqual({ supported: true, ignoring: true });
    expect(await requestIgnoreBatteryOptimization()).toBe(true);
    expect(await openAppSettings()).toBe(true);
    expect(calls).toEqual([
      ["keepalive_start", { text: "AgentDeck 已连接：PC", wakeLock: false }],
      ["keepalive_start", { text: "x", wakeLock: true }],
      ["keepalive_stop", undefined],
      ["battery_optimization_status", undefined],
      ["request_ignore_battery_optimization", undefined],
      ["open_app_settings", undefined],
    ]);
  });

  it("原生调用失败时吞掉错误并返回失败", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setNativeInvoker(async () => {
      throw new Error("boom");
    });
    expect(await keepaliveStart("x")).toBe(false);
    expect(await getBatteryOptimization()).toEqual({ supported: false, ignoring: false });
  });
});
