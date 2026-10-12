import { useEffect, useState } from "react";
import type { WindowType } from "@agentdeck/protocol";

function readPlatform(): WindowType {
  if (typeof document === "undefined") return "web";
  const runtime = (window as Window & { __HERMES_RUNTIME__?: { platform?: WindowType } })
    .__HERMES_RUNTIME__;
  return (
    document.body?.dataset.hermesWindowType ||
    document.documentElement.dataset.hermesWindowType ||
    runtime?.platform ||
    "web"
  ) as WindowType;
}

export function applyPlatformToDOM(platform: WindowType): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.hermesWindowType = platform;
  if (document.body) document.body.dataset.hermesWindowType = platform;
}

export function usePlatform(): WindowType {
  const [platform, setPlatform] = useState<WindowType>(() => readPlatform());

  useEffect(() => {
    const next = readPlatform();
    applyPlatformToDOM(next);
    setPlatform(next);

    if (!document.body) return;
    const observer = new MutationObserver(() => setPlatform(readPlatform()));
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-hermes-window-type"],
    });
    return () => observer.disconnect();
  }, []);

  return platform;
}
