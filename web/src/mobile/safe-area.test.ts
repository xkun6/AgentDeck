// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applySafeArea } from "./safe-area";
import { setNativeBackend } from "./native/native-plugin";

afterEach(() => {
  setNativeBackend(null);
  document.documentElement.style.removeProperty("--ad-safe-top");
  document.documentElement.style.removeProperty("--ad-safe-bottom");
});

describe("安全区", () => {
  it("原生给出系统栏高度：写入 --ad-safe-top 与 --ad-safe-bottom", async () => {
    setNativeBackend({ invoke: async () => ({ top: 30.5, bottom: 16 }) });
    expect(await applySafeArea()).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--ad-safe-top")).toBe("30.5px");
    expect(document.documentElement.style.getPropertyValue("--ad-safe-bottom")).toBe("16px");
  });

  it("取不到或为 0：不设置变量，样式退回 env()", async () => {
    setNativeBackend({ invoke: async () => ({ top: 0, bottom: 0 }) });
    expect(await applySafeArea()).toBe(false);
    setNativeBackend(null);
    expect(await applySafeArea()).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--ad-safe-top")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--ad-safe-bottom")).toBe("");
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
    // 底部导航、输入区都要避开系统手势条
    for (const selector of [".nav", ".inputBar", ".footerBar"]) {
      expect(rule(selector)).toContain("var(--ad-safe-bottom, env(safe-area-inset-bottom))");
    }
  });
});
