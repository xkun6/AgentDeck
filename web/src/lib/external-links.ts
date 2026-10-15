type NativeWindowOpen = typeof window.open;

const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "obsidian:"]);
let nativeWindowOpen: NativeWindowOpen | null = null;
let installed = false;
/** 手机端注册的原生打开器（web/src/mobile/external-links.ts）；已注册时 openExternalUrl 只走它，绝不退回 window.open */
let mobileOpener: ((url: string) => Promise<boolean>) | null = null;

export function setMobileExternalOpener(opener: ((url: string) => Promise<boolean>) | null): void {
  mobileOpener = opener;
}

function getNativeWindowOpen(): NativeWindowOpen | null {
  if (typeof window === "undefined") return null;
  if (!nativeWindowOpen) nativeWindowOpen = window.open.bind(window) as NativeWindowOpen;
  return nativeWindowOpen;
}

export function normalizeExternalUrl(raw: string | URL | null | undefined): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;

  try {
    const url = new URL(value);
    if (!SAFE_EXTERNAL_PROTOCOLS.has(url.protocol)) return null;
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.hostname) return null;
    if (url.protocol === "mailto:" && !url.pathname.trim()) return null;
    if (url.protocol === "obsidian:" && !url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

export async function openExternalUrl(
  raw: string | URL | null | undefined,
  options: { nativeOpen?: NativeWindowOpen | null } = {},
): Promise<boolean> {
  const url = normalizeExternalUrl(raw);
  if (!url) return false;

  // 手机端：Android WebView 的 window.open 会在本 WebView 内导航，把 App 页面替换掉，所以失败也不能退回去
  if (mobileOpener) {
    try {
      return await mobileOpener(url);
    } catch (error) {
      console.warn("mobile openExternalUrl failed", error);
      return false;
    }
  }

  const desktopOpen = typeof window !== "undefined" ? window.agentdeckDesktop?.openExternalUrl : undefined;
  if (desktopOpen) {
    try {
      const result = await desktopOpen({ url });
      if (result.ok) return true;
      console.warn("openExternalUrl returned false", result.message ?? url);
    } catch (error) {
      console.warn("openExternalUrl failed", error);
    }
  }

  const fallbackOpen = options.nativeOpen ?? getNativeWindowOpen();
  if (!fallbackOpen) return false;
  fallbackOpen(url, "_blank", "noopener,noreferrer");
  return true;
}

function patchWindowOpen() {
  if (typeof window === "undefined") return;
  const original = getNativeWindowOpen();
  if (!original) return;

  const current = window.open as NativeWindowOpen & { __agentdeckExternalLinkPatch?: boolean };
  if (current.__agentdeckExternalLinkPatch) return;

  const patched = ((url?: string | URL, target?: string, features?: string) => {
    const normalized = normalizeExternalUrl(url);
    if (normalized && window.agentdeckDesktop?.openExternalUrl) {
      void openExternalUrl(normalized, { nativeOpen: original });
      return null;
    }
    return original(url as string | URL | undefined, target, features);
  }) as NativeWindowOpen & { __agentdeckExternalLinkPatch?: boolean };

  patched.__agentdeckExternalLinkPatch = true;
  window.open = patched;
}

function handleExternalAnchorClick(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0) return;
  if (typeof window === "undefined" || !window.agentdeckDesktop?.openExternalUrl) return;
  if (!(event.target instanceof Element)) return;

  const anchor = event.target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return;

  const href = anchor.getAttribute("href");
  if (!normalizeExternalUrl(href)) return;

  event.preventDefault();
  void openExternalUrl(href);
}

export function installExternalLinkHandling() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  patchWindowOpen();

  if (typeof document !== "undefined") {
    document.addEventListener("click", handleExternalAnchorClick);
  }
}
