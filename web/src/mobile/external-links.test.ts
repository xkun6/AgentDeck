// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openExternalUrl } from "@/lib/external-links";
import { externalHttpUrl, installMobileExternalLinks } from "./external-links";

let uninstall: (() => void) | null = null;
const originalOpen = window.open;

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  window.open = originalOpen;
});

function setup() {
  const open = vi.fn().mockResolvedValue(true);
  const notify = vi.fn();
  uninstall = installMobileExternalLinks({ open, notify });
  return { open, notify };
}

function anchor(href: string, attrs: Record<string, string> = {}): HTMLAnchorElement {
  const a = document.createElement("a");
  a.setAttribute("href", href);
  for (const [key, value] of Object.entries(attrs)) a.setAttribute(key, value);
  a.textContent = "link";
  document.body.appendChild(a);
  return a;
}

/** 点击并返回是否被 preventDefault（即没有交给 WebView 导航） */
function click(el: Element, button = 0): boolean {
  let prevented = false;
  // 冒泡阶段最后记录是否已被拦截，再统一 preventDefault，避免 jsdom 真的去做导航
  const probe = (event: Event) => {
    prevented = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener("click", probe);
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button }));
  document.removeEventListener("click", probe);
  return prevented;
}

describe("externalHttpUrl", () => {
  it("外部 http(s) 返回绝对地址；站内 / hash / 其它协议返回 null", () => {
    const base = "http://tauri.localhost/index.html";
    expect(externalHttpUrl("https://example.com/a?b=1", base)).toBe("https://example.com/a?b=1");
    expect(externalHttpUrl("http://example.com", base)).toBe("http://example.com/");
    expect(externalHttpUrl("#/sessions", base)).toBeNull();
    expect(externalHttpUrl("/sessions", base)).toBeNull();
    expect(externalHttpUrl("http://tauri.localhost/x", base)).toBeNull();
    expect(externalHttpUrl("https://tauri.localhost/x", base)).toBeNull();
    expect(externalHttpUrl("mailto:a@b.c", base)).toBeNull();
    expect(externalHttpUrl("javascript:alert(1)", base)).toBeNull();
    expect(externalHttpUrl("", base)).toBeNull();
    expect(externalHttpUrl(undefined, base)).toBeNull();
  });
});

describe("手机端全局外链拦截", () => {
  it("点击外部 http(s) 链接：阻止 WebView 导航并走原生打开", () => {
    const { open } = setup();
    expect(click(anchor("https://example.com/doc", { target: "_blank" }))).toBe(true);
    expect(open).toHaveBeenCalledWith("https://example.com/doc");
  });

  it("点到链接内部的子元素也能拦截", () => {
    const { open } = setup();
    const a = anchor("https://example.com/");
    const inner = document.createElement("span");
    a.appendChild(inner);
    expect(click(inner)).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("站内 hash / 相对路径 / 同源链接不拦截", () => {
    const { open } = setup();
    expect(click(anchor("#/session/a1"))).toBe(false);
    expect(click(anchor("/local/path"))).toBe(false);
    expect(click(anchor(`${window.location.origin}/x`))).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("非 http(s) 协议、非左键点击不走原生打开", () => {
    const { open } = setup();
    click(anchor("mailto:a@b.c"));
    const a = anchor("https://example.com/");
    click(a, 1);
    expect(open).not.toHaveBeenCalled();
  });

  it("原生打开失败时给出提示", async () => {
    const open = vi.fn().mockResolvedValue(false);
    const notify = vi.fn();
    uninstall = installMobileExternalLinks({ open, notify });
    click(anchor("https://example.com/"));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0][0]).toContain("无法打开链接");
  });

  it("window.open：外部地址走原生并返回 null，其余一律返回 null 且不导航", () => {
    const { open } = setup();
    expect(window.open("https://example.com/x", "_blank")).toBeNull();
    expect(open).toHaveBeenCalledWith("https://example.com/x");
    open.mockClear();
    expect(window.open("#/sessions")).toBeNull();
    expect(window.open()).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it("安装后 openExternalUrl 走原生打开器，失败时不退回 window.open", async () => {
    const open = vi.fn().mockResolvedValue(false);
    uninstall = installMobileExternalLinks({ open, notify: vi.fn() });
    const nativeOpen = vi.fn();
    await expect(openExternalUrl("https://example.com/", { nativeOpen })).resolves.toBe(false);
    expect(open).toHaveBeenCalledWith("https://example.com/");
    expect(nativeOpen).not.toHaveBeenCalled();
  });

  it("卸载后恢复 window.open 与点击行为", () => {
    const { open } = setup();
    uninstall?.();
    uninstall = null;
    expect(window.open).toBe(originalOpen);
    click(anchor("https://example.com/"));
    expect(open).not.toHaveBeenCalled();
  });
});
