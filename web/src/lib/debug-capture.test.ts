// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { debugBus } from "./debug-bus";
import { installDebugCapture } from "./debug-capture";

describe("installDebugCapture", () => {
  afterEach(() => debugBus.clear());

  it("采集 console.error / warn 且保留原输出，重复安装只生效一次", () => {
    const originalError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const originalWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    debugBus.clear();
    installDebugCapture();
    installDebugCapture();

    console.error("boom", { api_key: "sk-leak" });
    console.warn("careful");

    expect(originalError).toHaveBeenCalledTimes(1);
    expect(originalWarn).toHaveBeenCalledTimes(1);
    const entries = debugBus.snapshot().filter((entry) => entry.type === "console");
    expect(entries.map((entry) => entry.level)).toEqual(["error", "warn"]);
    expect(entries[0]?.summary).toContain("boom");
    expect(entries[0]?.summary).not.toContain("sk-leak");
  });

  it("采集 window error 与 unhandledrejection", () => {
    debugBus.clear();
    window.dispatchEvent(new ErrorEvent("error", { message: "kaput", filename: "a.js" }));
    const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
    rejection.reason = new Error("rejected!");
    window.dispatchEvent(rejection);
    const summaries = debugBus.snapshot().map((entry) => entry.summary);
    expect(summaries.some((text) => text.includes("kaput"))).toBe(true);
    expect(summaries.some((text) => text.includes("rejected!"))).toBe(true);
  });
});
