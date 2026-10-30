// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installMobileTheme } from "./theme";

function stubColorScheme(initialDark: boolean) {
  const listeners = new Set<() => void>();
  const media = {
    matches: initialDark,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", () => media);
  return {
    listeners,
    setDark(dark: boolean) {
      media.matches = dark;
      for (const listener of listeners) listener();
    },
  };
}

describe("installMobileTheme", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("标记手机设计语言，明暗跟随系统变化，卸载后不再跟随", () => {
    const scheme = stubColorScheme(true);
    const root = document.documentElement;
    const uninstall = installMobileTheme(root);
    expect(root.getAttribute("data-surface")).toBe("mobile");
    expect(root.getAttribute("data-theme")).toBe("dark-modern");

    scheme.setDark(false);
    expect(root.getAttribute("data-theme")).toBe("light-modern");

    uninstall();
    expect(scheme.listeners.size).toBe(0);
  });
});
