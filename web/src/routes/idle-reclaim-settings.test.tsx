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

import { IdleReclaimSettingsSection } from "./idle-reclaim-settings";

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
  computerUse: { enabled: false, allowSelfTargeting: false, approval: "ask", callTimeoutSec: 120 },
};

function renderPage(connected = true) {
  const store = createStore();
  store.set(sidecarConnectionAtom, connected ? "open" : "closed");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <JotaiProvider store={store}>
        <IdleReclaimSettingsSection />
      </JotaiProvider>
    </QueryClientProvider>,
  );
}

describe("IdleReclaimSettingsSection", () => {
  it("点「关闭」只提交 idleReclaim.enabled，且关闭后时长输入禁用", async () => {
    getSidecarSettings.mockResolvedValue(SETTINGS);
    setSidecarSettings.mockImplementation(async (patch) => ({
      ...SETTINGS,
      idleReclaim: { ...SETTINGS.idleReclaim, ...patch.idleReclaim },
    }));
    renderPage();
    fireEvent.click(await screen.findByText("关闭"));
    await waitFor(() => expect(setSidecarSettings).toHaveBeenCalledWith({ idleReclaim: { enabled: false } }));
    await waitFor(() =>
      expect((screen.getByLabelText("空闲时长（分钟）") as HTMLInputElement).disabled).toBe(true),
    );
  });

  it("时长输入：合法值回车保存；越界值还原并提示", async () => {
    getSidecarSettings.mockResolvedValue(SETTINGS);
    setSidecarSettings.mockImplementation(async (patch) => ({
      ...SETTINGS,
      idleReclaim: { ...SETTINGS.idleReclaim, ...patch.idleReclaim },
    }));
    renderPage();
    const input = (await screen.findByLabelText("空闲时长（分钟）")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "30" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(setSidecarSettings).toHaveBeenCalledWith({ idleReclaim: { idleMinutes: 30 } }));

    fireEvent.change(input, { target: { value: "1441" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText(/空闲时长需为 1–1440/)).toBeTruthy();
    expect(input.value).toBe("30");
    expect(setSidecarSettings).toHaveBeenCalledTimes(1);
  });

  it("未连接时给出提示", () => {
    renderPage(false);
    expect(screen.getByText(/Agent 服务未连接/)).toBeTruthy();
  });
});
