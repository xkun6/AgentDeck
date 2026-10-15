// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applySafeAreaTop } from "./safe-area";
import { setNativeBackend } from "./native/native-plugin";

afterEach(() => {
  setNativeBackend(null);
  document.documentElement.style.removeProperty("--ad-safe-top");
});

describe("顶部安全区", () => {
  it("原生给出状态栏高度：写入 --ad-safe-top", async () => {
    setNativeBackend({ invoke: async () => ({ top: 30.5 }) });
    expect(await applySafeAreaTop()).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--ad-safe-top")).toBe("30.5px");
  });

  it("取不到或为 0：不设置变量，样式退回 env(safe-area-inset-top)", async () => {
    setNativeBackend({ invoke: async () => ({ top: 0 }) });
    expect(await applySafeAreaTop()).toBe(false);
    setNativeBackend(null);
    expect(await applySafeAreaTop()).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--ad-safe-top")).toBe("");
  });

  it("手机根容器（含承载提示条的 .app）顶部内边距都使用该偏移", () => {
    const css = readFileSync(resolve(__dirname, "mobile.module.css"), "utf8");
    const rule = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      expect(start).toBeGreaterThanOrEqual(0);
      return css.slice(start, css.indexOf("}", start));
    };
    for (const selector of [".app", ":global(#root) > .page"]) {
      expect(rule(selector)).toContain("padding-top: var(--ad-safe-top, env(safe-area-inset-top))");
    }
  });
});
