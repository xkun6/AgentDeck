// App 前后台状态（手机端）。
//
// 为什么不直接读 document.visibilityState：「后台保持连接」开启时，MainActivity 会让 WebView 在 App 切后台后继续保持「可见」，
// 否则 Chromium 会对不可见页面限流并在约 5 分钟后冻结 JS，后台通知就失效了（见 MainActivity.kt 注释）。
// 因此原生壳里以 NativePlugin 的 appState（Activity resume / stop）为准；拿不到时（浏览器 / 测试 / 事件尚未到达）退回页面可见性。
import { getAppForeground, onAppStateChanged } from "./native-plugin";

let nativeForeground: boolean | null = null;
const listeners = new Set<(foreground: boolean) => void>();
let visibilityBound = false;

function pageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/** 当前 App 是否在前台 */
export function isAppForeground(): boolean {
  return nativeForeground ?? pageVisible();
}

function emit(foreground: boolean): void {
  for (const listener of [...listeners]) listener(foreground);
}

function setNativeForeground(foreground: boolean): void {
  if (nativeForeground === foreground) return;
  const before = isAppForeground();
  nativeForeground = foreground;
  if (before !== foreground) emit(foreground);
}

/** 订阅前后台切换（只在状态真正变化时回调）。原生状态未知时跟随页面可见性。 */
export function subscribeAppForeground(listener: (foreground: boolean) => void): () => void {
  listeners.add(listener);
  if (!visibilityBound && typeof document !== "undefined") {
    visibilityBound = true;
    document.addEventListener("visibilitychange", () => {
      if (nativeForeground === null) emit(pageVisible());
    });
  }
  return () => {
    listeners.delete(listener);
  };
}

/** 启动原生前后台状态跟踪（main.tsx 调用一次）：先订阅事件，再读一次当前值；非原生环境什么都不做 */
export async function startAppStateTracking(): Promise<() => void> {
  const off = await onAppStateChanged(setNativeForeground);
  const current = await getAppForeground();
  if (current !== null) setNativeForeground(current);
  return off;
}

/** 仅测试用：重置模块状态 */
export function resetAppStateForTest(): void {
  nativeForeground = null;
  listeners.clear();
}
