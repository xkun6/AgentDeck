// 自写 Android 本地插件 native 的 JS 包装（前台服务 / 电池优化白名单 / 应用设置页，Rust 侧见 mobile/src/native.rs）。
// 非 Tauri 环境（浏览器 / 测试 / 桌面 dev）下全部是 no-op：不抛错，返回「不支持」的默认值。
import { isTauriShell } from "../platform";

export type NativeInvoker = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

let invokerOverride: NativeInvoker | null = null;

/** 测试注入：传入后无论是否在 Tauri 壳里都走它；传 null 恢复默认 */
export function setNativeInvoker(invoker: NativeInvoker | null): void {
  invokerOverride = invoker;
}

async function invokeNative(command: string, args?: Record<string, unknown>): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    if (invokerOverride) return { ok: true, value: await invokerOverride(command, args) };
    if (!isTauriShell()) return { ok: false };
    const { invoke } = await import("@tauri-apps/api/core");
    return { ok: true, value: await invoke(`plugin:native|${command}`, args) };
  } catch (error) {
    console.warn(`[native] ${command} 失败`, error);
    return { ok: false };
  }
}

/** 当前环境是否有原生插件（Tauri 壳，或测试注入了 invoker） */
export function nativeAvailable(): boolean {
  return invokerOverride !== null || isTauriShell();
}

/** 启动前台服务（已在运行则更新常驻通知文案）；返回是否成功 */
export async function keepaliveStart(text: string, options: { wakeLock?: boolean } = {}): Promise<boolean> {
  const result = await invokeNative("keepalive_start", { text, wakeLock: options.wakeLock === true });
  return result.ok;
}

export async function keepaliveStop(): Promise<boolean> {
  return (await invokeNative("keepalive_stop")).ok;
}

export interface BatteryOptimizationStatus {
  /** 当前环境是否能查询（非 Android 为 false） */
  supported: boolean;
  /** 已加入电池优化白名单（App 不被电池优化限制） */
  ignoring: boolean;
}

export async function getBatteryOptimization(): Promise<BatteryOptimizationStatus> {
  const result = await invokeNative("battery_optimization_status");
  if (!result.ok) return { supported: false, ignoring: false };
  const value = result.value as { ignoring?: unknown } | null;
  return { supported: true, ignoring: value?.ignoring === true };
}

/** 弹出系统「忽略电池优化」确认框；结果要等用户回到 App 后用 getBatteryOptimization 重新查询 */
export async function requestIgnoreBatteryOptimization(): Promise<boolean> {
  return (await invokeNative("request_ignore_battery_optimization")).ok;
}

/** 打开本应用的系统设置页（自启动 / 后台活动 / 通知开关） */
export async function openAppSettings(): Promise<boolean> {
  return (await invokeNative("open_app_settings")).ok;
}
