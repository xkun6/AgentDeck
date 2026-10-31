// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applySafeArea, installSafeArea } from "./safe-area";
import { setNativeBackend } from "./native/native-plugin";

afterEach(() => {
  setNativeBackend(null);
  document.documentElement.style.removeProperty("--ad-safe-top");
  document.documentElement.style.removeProperty("--ad-safe-bottom");
  document.documentElement.removeAttribute("data-keyboard");
});

describe("安全区", () => {
  it("原生给出系统栏高度：写入 --ad-safe-top 与 --ad-safe-bottom", async () => {
    setNativeBackend({ invoke: async () => ({ top: 30.5, bottom: 16 }) });
    expect(await applySafeArea()).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--ad-safe-top")).toBe("30.5px");
    expect(document.documentElement.style.getPropertyValue("--ad-safe-bottom")).toBe("16px");
  });

  it("软键盘状态以原生为准：窗口变化时重新读取，取不到时保持原状", async () => {
    let keyboardOpen = false;
    setNativeBackend({ invoke: async () => ({ top: 30, bottom: 16, keyboard: keyboardOpen }) });
    const flush = () => new Promise<void>((done) => setTimeout(done, 0));
    const attr = () => document.documentElement.getAttribute("data-keyboard");
    const dispose = installSafeArea();
    await flush();
    expect(attr()).toBeNull();

    keyboardOpen = true;
    window.dispatchEvent(new Event("resize"));
    await flush();
    expect(attr()).toBe("open");

    // 原生暂时取不到（窗口未就绪）：不能当成键盘收起
    setNativeBackend({
      invoke: async () => {
        throw new Error("窗口尚未就绪");
      },
    });
    window.dispatchEvent(new Event("resize"));
    await flush();
    expect(attr()).toBe("open");

    // 分屏让窗口变矮，但原生说没有键盘
    setNativeBackend({ invoke: async () => ({ top: 30, bottom: 16, keyboard: false }) });
    window.dispatchEvent(new Event("resize"));
    await flush();
    expect(attr()).toBeNull();
    dispose();
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
    // 底部导航、输入区、底部面板都要避开系统手势条
    // 没有底栏的页面（子页、新建会话），正文滚到底也要避开系统导航栏
    for (const selector of [".nav", ".inputBar", ".modalPanel", ".app:not(:has(> .nav)) .body", '.app:not(:has(> .nav)) .body[data-flush="true"]']) {
      expect(rule(selector)).toContain("var(--ad-safe-bottom, env(safe-area-inset-bottom))");
    }
  });
});
