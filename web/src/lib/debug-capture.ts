// 全局调试事件采集（design.md 4.18）：应用启动时安装一次，全部写入 debugBus（环形缓冲 + 写入前脱敏）。
// 采集 console.error / console.warn（保留原输出）、window error / unhandledrejection、
// sidecar-status 事件；RPC 失败与连接状态由 sidecar-client 直接写入 debugBus。
import { debugBus } from "./debug-bus";

let installed = false;

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.stack ?? arg.message;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

function describeError(value: unknown): string {
  if (value instanceof Error) return value.message;
  return typeof value === "string" ? value : formatArgs([value]);
}

/** sidecar-status 载荷里只取状态与错误，绝不记录 token / wsUrl。 */
async function watchSidecarStatus(): Promise<void> {
  const { listen } = await import("@tauri-apps/api/event");
  await listen<{ status?: string; version?: string | null; error?: string | null }>(
    "sidecar-status",
    (event) => {
      const { status, version, error } = event.payload ?? {};
      debugBus.push({
        type: "backend",
        level: status === "failed" ? "error" : "info",
        summary: `sidecar-status：${status ?? "unknown"}${error ? `（${error}）` : ""}`,
        payload: { status, version: version ?? null, error: error ?? null },
      });
    },
  );
}

export function installDebugCapture(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        debugBus.push({ type: "console", level, summary: formatArgs(args) });
      } catch {
        // 采集不能影响原输出
      }
    };
  }

  window.addEventListener("error", (event) => {
    debugBus.push({
      type: "exception",
      level: "error",
      summary: `window error：${event.message || describeError(event.error)}`,
      payload: { filename: event.filename, line: event.lineno, column: event.colno, stack: event.error?.stack },
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    debugBus.push({
      type: "exception",
      level: "error",
      summary: `unhandledrejection：${describeError(event.reason)}`,
      payload: { stack: event.reason instanceof Error ? event.reason.stack : undefined },
    });
  });

  if (window.__TAURI_INTERNALS__) {
    void watchSidecarStatus().catch(() => undefined);
  }
}
