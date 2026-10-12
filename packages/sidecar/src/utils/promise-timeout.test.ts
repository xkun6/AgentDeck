import { describe, expect, test } from "vitest";

import { withTimeout } from "./promise-timeout.js";

describe("withTimeout", () => {
  test("resolves with the wrapped promise value", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "should not time out")).resolves.toBe(42);
  });

  test("rejects with the given message on timeout", async () => {
    const never = new Promise<number>(() => undefined);
    await expect(withTimeout(never, 20, "超时了")).rejects.toThrow("超时了");
  });

  test("options form builds a labelled message", async () => {
    const never = new Promise<number>(() => undefined);
    await expect(withTimeout({ promise: never, timeoutMs: 10, label: "close" })).rejects.toThrow(
      "Timed out after 10ms (close)",
    );
  });

  test("propagates rejection from the wrapped promise", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1000, "x")).rejects.toThrow("boom");
  });
});
