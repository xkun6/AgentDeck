// M0 验证用的页内帧探针：补充 gfxinfo 看不到的 WebView 主线程卡顿。
// - 持续用 requestAnimationFrame 采样帧间隔；
// - 某个 2 秒窗口里发生了滚动 / 流式更新 / 长任务时，才打一行汇总（logcat 里 grep `[m0-raf]`）。
import { m0Log } from "./m0-log";

const WINDOW_MS = 2_000;

export function installPerfProbe(): void {
  let deltas: number[] = [];
  let last = performance.now();
  let activity = 0;
  let longTasks = 0;
  let longTaskMax = 0;

  const markActivity = () => {
    activity += 1;
  };
  document.addEventListener("scroll", markActivity, { capture: true, passive: true });
  document.addEventListener("touchmove", markActivity, { capture: true, passive: true });

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks += 1;
        longTaskMax = Math.max(longTaskMax, entry.duration);
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    // 不支持 longtask 的 WebView 忽略
  }

  const tick = (now: number) => {
    deltas.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  setInterval(() => {
    const sample = deltas;
    deltas = [];
    // 流式更新期间没有滚动事件，但 DOM 在变；这里用「有长任务或有滚动」或「帧间隔异常」来触发。
    const sorted = [...sample].sort((a, b) => a - b);
    const max = sorted[sorted.length - 1] ?? 0;
    if (activity === 0 && longTasks === 0 && max < 50) return;
    const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    const over33 = sample.filter((d) => d > 33).length;
    m0Log(
      `[m0-raf] frames=${sample.length} p50=${pick(0.5).toFixed(1)} p90=${pick(0.9).toFixed(1)} p99=${pick(0.99).toFixed(1)} max=${max.toFixed(0)} over33=${over33} scrollEv=${activity} longTasks=${longTasks} longMax=${longTaskMax.toFixed(0)}`,
    );
    activity = 0;
    longTasks = 0;
    longTaskMax = 0;
  }, WINDOW_MS);
}
