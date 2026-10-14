import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import { Provider as JotaiProvider, getDefaultStore } from "jotai";
import { QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_THEME_CONFIG, applyPlatformToDOM, applyThemeToDOM, normalizeThemeConfig, themeAtom, type ThemeConfig } from "@agentdeck/shared-ui";
import { queryClient } from "./lib/query-client";
import { applyHostOSToDOM, runtime } from "./lib/runtime";
import { installDebugCapture } from "./lib/debug-capture";
import { installExternalLinkHandling } from "./lib/external-links";
import { initUiStore, readUiValue } from "./lib/ui-store";
import { configureSidecarClient } from "./lib/sidecar-client";
import { createDesktopSidecarClient } from "./lib/sidecar-desktop";
import { ErrorBoundary } from "./components/error-boundary";
import { ConfirmProvider } from "./lib/use-confirm";
import "./styles/global.css";

configureSidecarClient({ create: createDesktopSidecarClient });
installDebugCapture();
applyPlatformToDOM(runtime.platform);
applyHostOSToDOM();

async function bootstrap() {
  if (!window.__TAURI_INTERNALS__ && !window.__AGENTDECK_RUNTIME__) {
    // 浏览器开发模式：直连 sidecar（VITE_AGENTDECK_SIDECAR_URL / VITE_AGENTDECK_SIDECAR_TOKEN）。
    window.__AGENTDECK_RUNTIME__ = { platform: "web" };
  }

  if (window.__TAURI_INTERNALS__ && !window.__AGENTDECK_RUNTIME__) {
    const { installTauriBridge } = await import("./lib/tauri-bridge");
    await installTauriBridge();
  }

  installExternalLinkHandling();
  await initUiStore();

  const initialTheme = normalizeThemeConfig(readUiValue<Partial<ThemeConfig>>("agentdeck-theme", DEFAULT_THEME_CONFIG));
  applyThemeToDOM(initialTheme);
  // Seed the shared jotai store so `useTheme()` (and the appearance controls)
  // start from the persisted theme/density/scale instead of the defaults.
  const jotaiStore = getDefaultStore();
  jotaiStore.set(themeAtom, initialTheme);

  const { App } = await import("./app");
  // Hydrate persisted atoms after UI store is initialized and App modules
  // are loaded. This is a safety net: in the normal flow, atoms are created
  // by the dynamic import above — after initUiStore() — so kvCache is already
  // populated and atoms get correct values. But if any code path imports
  // stores/ui before initUiStore() completes (module-import race), this
  // re-reads all persisted values from kvCache and updates the atoms.
  const { hydratePersistedUiAtoms } = await import("./stores/ui");
  hydratePersistedUiAtoms(jotaiStore);

  const Router = runtime.platform !== "web" ? HashRouter : BrowserRouter;

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <JotaiProvider store={jotaiStore}>
            <ConfirmProvider>
              <Router>
                <App />
              </Router>
            </ConfirmProvider>
          </JotaiProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </StrictMode>
  );
}

void bootstrap();
