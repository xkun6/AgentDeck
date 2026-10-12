import { describe, expect, it, vi } from "vitest";
import { DEBUG_BUS_MAX_ENTRIES, debugBus } from "./debug-bus";

describe("debugBus", () => {
  it("retains at most DEBUG_BUS_MAX_ENTRIES, dropping oldest", () => {
    debugBus.clear();
    for (let i = 0; i < DEBUG_BUS_MAX_ENTRIES + 50; i += 1) {
      debugBus.push({ type: "console", level: "info", summary: `entry-${i}` });
    }
    const snap = debugBus.snapshot();
    expect(snap.length).toBe(DEBUG_BUS_MAX_ENTRIES);
    expect(snap[0]?.summary).toBe(`entry-50`);
    expect(snap[snap.length - 1]?.summary).toBe(`entry-${DEBUG_BUS_MAX_ENTRIES + 49}`);
  });

  it("snapshot returns a stable reference between writes", () => {
    debugBus.clear();
    debugBus.push({ type: "gateway", level: "info", summary: "hello" });
    const a = debugBus.snapshot();
    const b = debugBus.snapshot();
    expect(b).toBe(a);
    debugBus.push({ type: "gateway", level: "info", summary: "world" });
    const c = debugBus.snapshot();
    expect(c).not.toBe(a);
    expect(c.length).toBe(2);
  });

  it("notifies subscribers and unsubscribes cleanly", async () => {
    debugBus.clear();
    const seen: number[] = [];
    const off = debugBus.subscribe((entries) => seen.push(entries.length));
    debugBus.push({ type: "console", level: "warn", summary: "a" });
    debugBus.push({ type: "console", level: "warn", summary: "b" });

    // vi.waitFor is robust to scheduler swaps (microtask → setTimeout → etc.).
    // The previous single Promise.resolve() flush silently passed if the bus
    // ever stopped notifying.
    await vi.waitFor(() => {
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[seen.length - 1]).toBe(2);
    });

    off();
    const beforeUnsub = seen.length;
    debugBus.push({ type: "console", level: "warn", summary: "c" });
    // Give any pending notify scheduling a chance to drain; assert no further
    // calls landed after unsubscribe.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen.length).toBe(beforeUnsub);
  });

  it("setPaused suppresses pushes while paused", () => {
    debugBus.clear();
    debugBus.setPaused(true);
    debugBus.push({ type: "console", level: "info", summary: "blocked" });
    expect(debugBus.snapshot().length).toBe(0);
    debugBus.setPaused(false);
    debugBus.push({ type: "console", level: "info", summary: "ok" });
    expect(debugBus.snapshot().length).toBe(1);
  });
});
