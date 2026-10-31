// 安全区：Android WebView 在 edge-to-edge 下 env(safe-area-inset-*) 不一定包含系统栏，
// 所以由原生 NativePlugin 读出系统栏高度（CSS px），写进 --ad-safe-top / --ad-safe-bottom；mobile.module.css 用
// var(--ad-safe-top, env(safe-area-inset-top)) —— 原生取不到时仍退回 env()。
import { getSafeAreaInsets } from "./native/native-plugin";

const RETRY_DELAYS_MS = [300, 1_000, 3_000];
/** 窗口变矮超过这么多才算软键盘弹起，避开系统栏显隐造成的小幅变化 */
const KEYBOARD_MIN_PX = 120;

export async function applySafeArea(root: HTMLElement = document.documentElement): Promise<boolean> {
  const insets = await getSafeAreaInsets();
  let applied = false;
  // 0 视为「没取到有效值」（窗口尚未布局），不覆盖 env() 的结果
  if (insets && insets.top !== null && insets.top > 0) {
    root.style.setProperty("--ad-safe-top", `${insets.top}px`);
    applied = true;
  }
  if (insets && insets.bottom !== null && insets.bottom > 0) {
    root.style.setProperty("--ad-safe-bottom", `${insets.bottom}px`);
    applied = true;
  }
  return applied;
}

/** 启动时取一次（窗口未就绪则延迟重试几次），之后旋转 / 回前台时刷新；返回卸载函数 */
export function installSafeArea(): () => void {
  let disposed = false;
  let fullHeight = window.innerHeight;
  let lastWidth = window.innerWidth;
  const refresh = () => void applySafeArea();
  // 软键盘弹起时 WebView 变矮（MainActivity 把输入法高度设为内边距）；宽度变了是旋转，重新取基准
  const onResize = () => {
    if (window.innerWidth !== lastWidth) {
      lastWidth = window.innerWidth;
      fullHeight = window.innerHeight;
    } else {
      fullHeight = Math.max(fullHeight, window.innerHeight);
    }
    if (fullHeight - window.innerHeight > KEYBOARD_MIN_PX) document.documentElement.setAttribute("data-keyboard", "open");
    else document.documentElement.removeAttribute("data-keyboard");
    refresh();
  };
  const timers = RETRY_DELAYS_MS.map((delay) => setTimeout(() => !disposed && refresh(), delay));
  refresh();
  window.addEventListener("resize", onResize);
  return () => {
    disposed = true;
    timers.forEach(clearTimeout);
    window.removeEventListener("resize", onResize);
  };
}
