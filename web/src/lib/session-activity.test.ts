import { describe, expect, it } from "vitest";
import { createEmptyChatRuntime } from "@/stores/chat";
import {
  STALL_WATCHDOG_THRESHOLD_MS,
  hasRunningTool,
  isRuntimeRunning,
  streamSilenceMs,
} from "./session-activity";
import type { ChatSessionRuntime } from "@/stores/chat";

describe("session activity", () => {
  it("treats streaming and reconnecting runtimes as running", () => {
    expect(isRuntimeRunning({ ...createEmptyChatRuntime(1), streamStatus: "streaming" })).toBe(true);
    expect(isRuntimeRunning({ ...createEmptyChatRuntime(1), streamStatus: "connecting" })).toBe(true);
    expect(isRuntimeRunning({ ...createEmptyChatRuntime(1), streamStatus: "complete" })).toBe(false);
  });

  it("does not keep completed or errored runtimes running because of stale live parts", () => {
    const runtime = {
      ...createEmptyChatRuntime(1),
      streamStatus: "complete" as const,
      pendingApprovals: [{ requestId: "r1", sessionId: "s1", command: "approve" }],
      messages: [
        {
          id: "a1",
          sessionId: "s1",
          role: "assistant" as const,
          createdAt: 1,
          status: "complete" as const,
          parts: [
            {
              type: "tool" as const,
              toolCallId: "tool-1",
              name: "read_file",
              state: "running" as const,
            },
          ],
        },
      ],
    };

    expect(isRuntimeRunning(runtime)).toBe(false);
    expect(isRuntimeRunning({ ...runtime, streamStatus: "error" })).toBe(false);
  });
});

describe("streamSilenceMs (stall watchdog input)", () => {
  function runningRuntime(overrides: Partial<ChatSessionRuntime> = {}): ChatSessionRuntime {
    return {
      ...createEmptyChatRuntime(0),
      streamStatus: "streaming",
      ...overrides,
    };
  }

  it("returns null when the turn is not running", () => {
    const idle = createEmptyChatRuntime(0); // streamStatus "idle"
    expect(streamSilenceMs(idle, 10_000)).toBeNull();
    expect(streamSilenceMs(undefined, 10_000)).toBeNull();
  });

  it("measures elapsed since the last backend activity while running", () => {
    const runtime = runningRuntime({ lastActivityAt: 1_000, turnStartedAt: 500 });
    expect(streamSilenceMs(runtime, 4_000)).toBe(3_000);
  });

  it("pauses while waiting on a pending approval (not a stall)", () => {
    const runtime = runningRuntime({
      lastActivityAt: 1_000,
      pendingApprovals: [
        { requestId: "r1", sessionId: "s1", command: "ls" },
      ],
    });
    expect(streamSilenceMs(runtime, 999_000)).toBeNull();
  });

  it("falls back to turnStartedAt when no activity has been recorded yet", () => {
    const runtime = runningRuntime({ lastActivityAt: undefined, turnStartedAt: 2_000 });
    expect(streamSilenceMs(runtime, 5_000)).toBe(3_000);
  });

  it("never reports negative silence for clock skew", () => {
    const runtime = runningRuntime({ lastActivityAt: 10_000 });
    expect(streamSilenceMs(runtime, 1_000)).toBe(0);
  });

  it("pauses while a tool is still running (long terminal task is not a stall)", () => {
    const runtime = runningRuntime({
      lastActivityAt: 1_000,
      messages: [
        {
          id: "a1",
          sessionId: "s1",
          role: "assistant" as const,
          createdAt: 0,
          status: "streaming" as const,
          parts: [
            {
              type: "tool" as const,
              toolCallId: "tool-1",
              name: "terminal",
              state: "running" as const,
            },
          ],
        },
      ],
    });
    // Even far past the stall threshold the clock stays paused: the tool is
    // legitimately doing work while the backend is silent.
    expect(hasRunningTool(runtime)).toBe(true);
    expect(streamSilenceMs(runtime, 999_000)).toBeNull();
  });

  it("resumes measuring silence once the running tool completes", () => {
    const runtime = runningRuntime({
      lastActivityAt: 1_000,
      messages: [
        {
          id: "a1",
          sessionId: "s1",
          role: "assistant" as const,
          createdAt: 0,
          status: "streaming" as const,
          parts: [
            {
              type: "tool" as const,
              toolCallId: "tool-1",
              name: "terminal",
              state: "done" as const,
              completedAt: 1_000,
            },
          ],
        },
      ],
    });
    expect(hasRunningTool(runtime)).toBe(false);
    expect(streamSilenceMs(runtime, 4_000)).toBe(3_000);
  });

  it("hasRunningTool ignores finished and non-tool parts", () => {
    const runtime = runningRuntime({
      messages: [
        {
          id: "a1",
          sessionId: "s1",
          role: "assistant" as const,
          createdAt: 0,
          status: "streaming" as const,
          parts: [
            { type: "text" as const, text: "done" },
            { type: "tool" as const, toolCallId: "t1", name: "read_file", state: "done" as const },
            { type: "tool" as const, toolCallId: "t2", name: "write_file", state: "error" as const },
          ],
        },
      ],
    });
    expect(hasRunningTool(runtime)).toBe(false);
    expect(streamSilenceMs(runtime, 5_000)).toBe(5_000);
  });

  it("exposes a generous default threshold", () => {
    // A sanity bound: long enough to outlast normal pre-first-token thinking,
    // short enough to be useful. Keep it in the tens-of-seconds range.
    expect(STALL_WATCHDOG_THRESHOLD_MS).toBeGreaterThanOrEqual(30_000);
    expect(STALL_WATCHDOG_THRESHOLD_MS).toBeLessThanOrEqual(180_000);
  });
});
