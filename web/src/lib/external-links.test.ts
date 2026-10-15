import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeExternalUrl, openExternalUrl, setMobileExternalOpener } from "./external-links";

afterEach(() => {
  setMobileExternalOpener(null);
  delete (globalThis as any).window;
});

describe("external-links", () => {
  it("normalizes safe browser URLs", () => {
    expect(normalizeExternalUrl(" https://agentdeck.example/docs?q=1 ")).toBe(
      "https://agentdeck.example/docs?q=1",
    );
    expect(normalizeExternalUrl("http://example.com")).toBe("http://example.com/");
    expect(normalizeExternalUrl("mailto:hello@example.com")).toBe("mailto:hello@example.com");
    expect(normalizeExternalUrl("obsidian://open?vault=AgentDeck&file=Twitter%20%E6%97%B6%E9%97%B4%E7%BA%BF")).toBe(
      "obsidian://open?vault=AgentDeck&file=Twitter%20%E6%97%B6%E9%97%B4%E7%BA%BF",
    );
  });

  it("rejects non-browser schemes", () => {
    expect(normalizeExternalUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeExternalUrl("tauri://localhost")).toBeNull();
    expect(normalizeExternalUrl("obsidian:open")).toBeNull();
    expect(normalizeExternalUrl("/about")).toBeNull();
  });

  it("uses the desktop opener before falling back to window.open", async () => {
    const desktopOpen = vi.fn().mockResolvedValue({ ok: true });
    const fallbackOpen = vi.fn();
    (globalThis as any).window = {
      agentdeckDesktop: { openExternalUrl: desktopOpen },
      open: fallbackOpen,
    };

    await expect(openExternalUrl("https://agentdeck.example")).resolves.toBe(true);

    expect(desktopOpen).toHaveBeenCalledWith({ url: "https://agentdeck.example/" });
    expect(fallbackOpen).not.toHaveBeenCalled();
  });

  it("手机端：注册了原生打开器就只走它，失败也不退回 window.open / 桌面 opener", async () => {
    const mobileOpen = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("boom"));
    const fallbackOpen = vi.fn();
    const desktopOpen = vi.fn();
    (globalThis as any).window = { agentdeckDesktop: { openExternalUrl: desktopOpen }, open: fallbackOpen };
    setMobileExternalOpener(mobileOpen);

    await expect(openExternalUrl("https://agentdeck.example")).resolves.toBe(true);
    expect(mobileOpen).toHaveBeenCalledWith("https://agentdeck.example/");
    await expect(openExternalUrl("https://agentdeck.example")).resolves.toBe(false);
    await expect(openExternalUrl("https://agentdeck.example")).resolves.toBe(false);
    await expect(openExternalUrl("file:///etc/passwd")).resolves.toBe(false);

    expect(mobileOpen).toHaveBeenCalledTimes(3);
    expect(fallbackOpen).not.toHaveBeenCalled();
    expect(desktopOpen).not.toHaveBeenCalled();
  });
});
