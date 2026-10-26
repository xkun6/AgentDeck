// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider as JotaiProvider, createStore } from "jotai";
import type { SidecarSettings } from "@agentdeck/protocol";
import { sidecarConnectionAtom } from "@/stores/agents";

const getSidecarSettings = vi.fn<() => Promise<SidecarSettings>>();
const setSidecarSettings = vi.fn();
vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => ({ getSidecarSettings, setSidecarSettings }),
  humanizeSidecarError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { InteropSettingsSection } from "./interop-settings";

afterEach(() => {
  cleanup();
  getSidecarSettings.mockReset();
  setSidecarSettings.mockReset();
});

const SETTINGS: SidecarSettings = {
  snapshots: { enabled: true, maxFiles: 20_000, maxFileBytes: 5 * 1024 * 1024 },
  interop: { enabled: true },
  remote: { enabled: false, port: 47_631 },
  idleReclaim: { enabled: true, idleMinutes: 15 },
  translation: { userLanguage: "简体中文", agentLanguage: "English", translateReasoning: false, enabledByDefault: false },
  computerUse: { enabled: false, allowSelfTargeting: false },
};

function renderPage(connected = true) {
  const store = createStore();
  store.set(sidecarConnectionAtom, connected ? "open" : "closed");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <JotaiProvider store={store}>
        <InteropSettingsSection />
      </JotaiProvider>
    </QueryClientProvider>,
  );
}

describe("InteropSettingsSection", () => {
  it("显示当前开关；点「关闭」通过 settings.set 只提交 interop.enabled", async () => {
    getSidecarSettings.mockResolvedValue(SETTINGS);
    setSidecarSettings.mockImplementation(async (patch) => ({ ...SETTINGS, interop: { ...SETTINGS.interop, ...patch.interop } }));
    renderPage();
    const off = await screen.findByText("关闭");
    expect(screen.getByText("开启").getAttribute("data-active")).toBe("true");
    fireEvent.click(off);
    await waitFor(() => expect(setSidecarSettings).toHaveBeenCalledWith({ interop: { enabled: false } }));
    await waitFor(() => expect(screen.getByText("关闭").getAttribute("data-active")).toBe("true"));
  });

  it("保存失败时提示错误；未连接时给出提示", async () => {
    getSidecarSettings.mockResolvedValue(SETTINGS);
    setSidecarSettings.mockRejectedValue(new Error("磁盘已满"));
    renderPage();
    fireEvent.click(await screen.findByText("关闭"));
    expect(await screen.findByText(/保存失败：磁盘已满/)).toBeTruthy();
    cleanup();

    renderPage(false);
    expect(screen.getByText(/Agent 服务未连接/)).toBeTruthy();
  });
});
