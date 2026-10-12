import type { ChatSessionRuntime } from "@/stores/chat";

export function isRuntimeRunning(runtime: ChatSessionRuntime | undefined): boolean {
  if (!runtime) return false;
  if (
    runtime.streamStatus === "error" ||
    runtime.streamStatus === "complete" ||
    runtime.streamStatus === "idle"
  ) {
    return false;
  }
  return (
    runtime.streamStatus === "connecting" ||
    runtime.streamStatus === "streaming" ||
    runtime.pendingApprovals.length > 0 ||
    runtime.messages.some((message) =>
      message.parts.some((part) => part.type === "tool" && part.state === "running"),
    )
  );
}

/**
 * Default silence window (ms) after which a running turn is considered stalled.
 *
 * The connection-level heartbeat in `gateway-client.ts` only proves the
 * desktop↔gateway socket is alive — it cannot detect a turn wedged on a dead
 * model-provider call (the gateway keeps answering pings while the agent
 * thread is blocked). This task-level watchdog covers that gap. The threshold
 * is deliberately generous: legitimate pre-first-token thinking on large
 * contexts can be tens of seconds, and the backend itself surfaces a live
 * `provider_stalled` status around its own stale timeout — so this only fires
 * when the backend has gone *completely* silent.
 */
export const STALL_WATCHDOG_THRESHOLD_MS = 90_000;

/**
 * True while any tool part in the live runtime is still executing.
 *
 * A running tool is legitimate, expected work — a `terminal` tool can hold a
 * long task with the backend sending nothing the whole time. While a tool is
 * running the stall clock must be paused, otherwise the watchdog would
 * mislabel a busy tool as a wedged model-provider call and surface the
 * "模型服务已…无响应" notice mid-task.
 */
export function hasRunningTool(runtime: ChatSessionRuntime): boolean {
  return runtime.messages.some((message) =>
    message.parts.some((part) => part.type === "tool" && part.state === "running"),
  );
}

/**
 * Milliseconds since the backend last sent anything for a *running* turn, or
 * `null` when the turn is not running (so callers can stop their timer).
 *
 * Pending approvals pause the clock: the turn is legitimately waiting on the
 * user, not stalled. Awaiting-approval turns return `null`. So does a turn
 * with a tool still running (e.g. a long terminal command): the backend may
 * legitimately stay silent for the whole tool duration, so the stall
 * watchdog must not fire while a tool is busy.
 */
export function streamSilenceMs(
  runtime: ChatSessionRuntime | undefined,
  now: number = Date.now(),
): number | null {
  if (!runtime || !isRuntimeRunning(runtime)) return null;
  if (runtime.pendingApprovals.length > 0) return null;
  if (hasRunningTool(runtime)) return null;
  const last = runtime.lastActivityAt ?? runtime.turnStartedAt ?? runtime.updatedAt;
  if (typeof last !== "number" || !Number.isFinite(last)) return null;
  return Math.max(0, now - last);
}
