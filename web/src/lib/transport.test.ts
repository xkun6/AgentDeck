import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fetchMediaDataUrl, raceAbort } from "./transport";

// runtime.ts 等读取 `window`；vitest 默认 node 环境没有 window，这里补一个最小桩。
let windowStubbed = false;
beforeAll(() => {
  if (typeof (globalThis as { window?: unknown }).window === "undefined") {
    (globalThis as { window?: unknown }).window = {};
    windowStubbed = true;
  }
});
afterAll(() => {
  if (windowStubbed) {
    delete (globalThis as { window?: unknown }).window;
  }
});

describe("transport", () => {
  afterEach(() => {
    delete window.__AGENTDECK_RUNTIME__;
    delete window.agentdeckDesktop;
  });

  it("fetchMediaDataUrl 通过桌面桥读取本机图片", async () => {
    const readFileDataUrl = vi.fn(async () => "data:image/png;base64,REVT");
    window.agentdeckDesktop = { windowType: "tauri", readFileDataUrl };

    await expect(fetchMediaDataUrl("C:/Users/me/out.png")).resolves.toBe("data:image/png;base64,REVT");
    expect(readFileDataUrl).toHaveBeenCalledWith("C:/Users/me/out.png");
  });

  it("fetchMediaDataUrl 在没有桌面桥或结果不是图片时报错", async () => {
    await expect(fetchMediaDataUrl("/tmp/a.png")).rejects.toThrow(/无法读取/);
    window.agentdeckDesktop = { windowType: "tauri", readFileDataUrl: vi.fn(async () => "https://example.com/a.png") };
    await expect(fetchMediaDataUrl("/tmp/a.png")).rejects.toThrow(/data URL/);
  });

  it("raceAbort 在信号中止时以 AbortError 结束", async () => {
    const controller = new AbortController();
    const pending = raceAbort(new Promise<string>(() => {}), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
