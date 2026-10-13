import { describe, expect, it } from "vitest";
import { debugBus } from "./debug-bus";

describe("debugBus 写入前脱敏", () => {
  it("summary 与 payload 中的密钥在入缓冲前就被遮蔽", () => {
    debugBus.clear();
    debugBus.push({
      type: "sidecar",
      level: "error",
      summary: "失败 Authorization: Bearer abcdefghijkl1234",
      payload: { token: "SECRET-TOKEN", nested: { apiKey: "sk-abc" }, ok: "plain" },
    });
    const [entry] = debugBus.snapshot();
    const text = JSON.stringify(entry);
    expect(text).not.toContain("abcdefghijkl1234");
    expect(text).not.toContain("SECRET-TOKEN");
    expect(text).not.toContain("sk-abc");
    expect(text).toContain("plain");
  });
});
