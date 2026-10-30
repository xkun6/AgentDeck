// 自写 Android 本地插件 native 的 JS 包装（Rust 侧见 mobile/src/native.rs，Kotlin 见 gen/android 下的 NativePlugin.kt）：
// 前台服务 / 电池优化白名单 / 应用设置页 / 后台提醒通知及其点击回调。
// 非 Tauri 环境（浏览器 / 测试 / 桌面 dev）下全部是 no-op：不抛错，返回「不支持」的默认值。
import { isTauriShell } from "../platform";

export type NotificationPermissionResult = "granted" | "denied" | "default";

/** 原生能力的底层通道；默认走 Tauri，测试里用 setNativeBackend 注入 */
export interface NativeBackend {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  /** 订阅插件事件，返回取消订阅函数 */
  listen?(event: string, handler: (payload: unknown) => void): Promise<() => void>;
  /** 弹系统通知权限对话框（Android 13+） */
  requestNotificationPermission?(): Promise<NotificationPermissionResult>;
}

let backendOverride: NativeBackend | null = null;

export function setNativeBackend(backend: NativeBackend | null): void {
  backendOverride = backend;
}

const tauriBackend: NativeBackend = {
  async invoke(command, args) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke(`plugin:native|${command}`, args);
  },
  async listen(event, handler) {
    const { addPluginListener } = await import("@tauri-apps/api/core");
    const listener = await addPluginListener("native", event, handler);
    return () => {
      void listener.unregister();
    };
  },
  async requestNotificationPermission() {
    const { requestPermission } = await import("@tauri-apps/plugin-notification");
    return requestPermission();
  },
};

function currentBackend(): NativeBackend | null {
  return backendOverride ?? (isTauriShell() ? tauriBackend : null);
}

/** 当前环境是否有原生插件（Tauri 壳，或测试注入了 backend） */
export function nativeAvailable(): boolean {
  return currentBackend() !== null;
}

async function call(command: string, args?: Record<string, unknown>): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const backend = currentBackend();
  if (!backend) return { ok: false };
  try {
    return { ok: true, value: await backend.invoke(command, args) };
  } catch (error) {
    console.warn(`[native] ${command} 失败`, error);
    return { ok: false };
  }
}

// ── 前台服务 / 电池优化 / 应用设置 ─────────────────────────────────────────────

/** 启动前台服务（已在运行则更新常驻通知文案）；返回是否成功 */
export async function keepaliveStart(text: string, options: { wakeLock?: boolean } = {}): Promise<boolean> {
  return (await call("keepalive_start", { text, wakeLock: options.wakeLock === true })).ok;
}

export async function keepaliveStop(): Promise<boolean> {
  return (await call("keepalive_stop")).ok;
}

export interface BatteryOptimizationStatus {
  /** 当前环境是否能查询（非 Android 为 false） */
  supported: boolean;
  /** 已加入电池优化白名单（App 不被电池优化限制） */
  ignoring: boolean;
}

export async function getBatteryOptimization(): Promise<BatteryOptimizationStatus> {
  const result = await call("battery_optimization_status");
  if (!result.ok) return { supported: false, ignoring: false };
  const value = result.value as { ignoring?: unknown } | null;
  return { supported: true, ignoring: value?.ignoring === true };
}

/** 弹出系统「忽略电池优化」确认框；结果要等用户回到 App 后用 getBatteryOptimization 重新查询 */
export async function requestIgnoreBatteryOptimization(): Promise<boolean> {
  return (await call("request_ignore_battery_optimization")).ok;
}

/** 打开本应用的系统设置页（自启动 / 后台活动 / 通知开关） */
export async function openAppSettings(): Promise<boolean> {
  return (await call("open_app_settings")).ok;
}

/** 打开本应用的系统通知设置页（横幅 / 悬浮通知 / 声音等开关都在这里）；不支持时原生侧依次退到「待审批」channel 设置、应用详情页 */
export async function openAppNotificationSettings(): Promise<boolean> {
  return (await call("open_app_notification_settings")).ok;
}

/** 用系统浏览器打开 http / https 链接（Intent.ACTION_VIEW）；非 http(s)、没有浏览器、非 Tauri 环境都返回 false */
export async function openUrl(url: string): Promise<boolean> {
  return (await call("open_url", { url })).ok;
}

/** 系统栏（状态栏 / 刘海、导航条）的顶部与底部高度，单位 CSS px；原生取不到（窗口未就绪 / 非 Tauri 环境）返回 null，单项无效时该项为 null */
export async function getSafeAreaInsets(): Promise<{ top: number | null; bottom: number | null } | null> {
  const result = await call("safe_area_insets");
  if (!result.ok) return null;
  const value = result.value as { top?: unknown; bottom?: unknown } | null;
  const valid = (inset: unknown) => (typeof inset === "number" && Number.isFinite(inset) ? inset : null);
  return { top: valid(value?.top), bottom: valid(value?.bottom) };
}

// ── 后台提醒通知 ──────────────────────────────────────────────────────────────

export interface AttentionNotification {
  /** Android 通知 id（同 id 覆盖） */
  id: number;
  title: string;
  body: string;
  /** 决定 channel：permission 高优先级，finished / failed 一组，schedule 一组 */
  kind: "finished" | "failed" | "permission" | "schedule";
  agentId?: string;
}

export async function showAttentionNotification(notification: AttentionNotification): Promise<boolean> {
  return (await call("show_attention", { ...notification })).ok;
}

/** 取消一条已发出的 attention 通知（别处已处理审批时撤回）；通知不存在也算成功 */
export async function cancelAttentionNotification(id: number): Promise<boolean> {
  return (await call("cancel_attention", { id })).ok;
}

/** 系统层面的通知开关是否开着；null = 当前环境无法查询（浏览器 / 测试） */
export async function getNotificationsEnabled(): Promise<boolean | null> {
  const result = await call("notification_status");
  if (!result.ok) return null;
  return (result.value as { enabled?: unknown } | null)?.enabled === true;
}

export async function requestNotificationPermission(): Promise<NotificationPermissionResult | "unsupported"> {
  const backend = currentBackend();
  if (!backend?.requestNotificationPermission) return "unsupported";
  try {
    return await backend.requestNotificationPermission();
  } catch (error) {
    console.warn("[native] 申请通知权限失败", error);
    return "denied";
  }
}

export interface NotificationClickTarget {
  agentId?: string;
}

function targetOf(payload: unknown): NotificationClickTarget {
  const agentId = (payload as { agentId?: unknown } | null)?.agentId;
  return typeof agentId === "string" && agentId ? { agentId } : {};
}

/** 订阅「用户点了 attention 通知」；返回取消订阅函数（非 Tauri 环境为 no-op） */
export async function onNotificationClicked(handler: (target: NotificationClickTarget) => void): Promise<() => void> {
  const backend = currentBackend();
  if (!backend?.listen) return () => {};
  try {
    return await backend.listen("notificationClicked", (payload) => handler(targetOf(payload)));
  } catch (error) {
    console.warn("[native] 订阅通知点击失败", error);
    return () => {};
  }
}

/** 取走「由点击通知冷启动 App」的目标（只会返回一次） */
export async function takeLaunchTarget(): Promise<NotificationClickTarget | null> {
  const result = await call("take_launch_target");
  if (!result.ok) return null;
  const target = (result.value as { target?: unknown } | null)?.target;
  return target && typeof target === "object" ? targetOf(target) : null;
}

// ── App 前后台状态 ────────────────────────────────────────────────────────────

/**
 * Activity 是否在前台（onResume 为 true、onStop 为 false）；null = 当前环境无法查询。
 * 后台保活时原生层会让 WebView 一直保持「可见」，document.visibilityState 不可信，所以前端读这个值（见 app-state.ts）。
 */
export async function getAppForeground(): Promise<boolean | null> {
  const result = await call("app_state");
  if (!result.ok) return null;
  const foreground = (result.value as { foreground?: unknown } | null)?.foreground;
  return typeof foreground === "boolean" ? foreground : null;
}

/** 订阅前后台切换事件 appState；返回取消订阅函数（非 Tauri 环境为 no-op） */
export async function onAppStateChanged(handler: (foreground: boolean) => void): Promise<() => void> {
  const backend = currentBackend();
  if (!backend?.listen) return () => {};
  try {
    return await backend.listen("appState", (payload) => {
      const foreground = (payload as { foreground?: unknown } | null)?.foreground;
      if (typeof foreground === "boolean") handler(foreground);
    });
  } catch (error) {
    console.warn("[native] 订阅前后台状态失败", error);
    return () => {};
  }
}
