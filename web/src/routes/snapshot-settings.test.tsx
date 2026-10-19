// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider as JotaiProvider, createStore } from "jotai";
import type { SidecarSettings } from "@agentdeck/protocol";
import { sidecarConnectionAtom } from "@/stores/agents";
import { ConfirmProvider } from "@/lib/use-confirm";

const getSidecarSettings = vi.fn<() => Promise<SidecarSettings>>();
const setSidecarSettings = vi.fn();
const snapshotStorage = vi.fn();
const pruneSnapshots = vi.fn();
vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => ({ getSidecarSettings, setSidecarSettings, snapshotStorage, pruneSnapshots }),
  humanizeSidecarError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { SnapshotSettingsSection } from "./snapshot-settings";

afterEach(() => {
  cleanup();
  for (const mock of [getSidecarSettings, setSidecarSettings, snapshotStorage, pruneSnapshots]) {
    mock.mockReset();
  }
});

const SETTINGS: SidecarSettings = {
  snapshots: { enabled: true, maxFiles: 20_000, maxFileBytes: 5 * 1024 * 1024 },
  interop: { enabled: true },
  remote: { enabled: false, port: 47_631 },
  idleReclaim: { enabled: true, idleMinutes: 15 },
  translation: { userLanguage: "简体中文", agentLanguage: "English", translateReasoning: false, enabledByDefault: false },
};

function renderPage() {
  const store = createStore();
  store.set(sidecarConnectionAtom, "open");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <JotaiProvider store={store}>
        <ConfirmProvider>
          <SnapshotSettingsSection />
        </ConfirmProvider>
      </JotaiProvider>
    </QueryClientProvider>,
  );
}

describe("SnapshotSettingsSection", () => {
  it("显示当前设置与各工作目录占用", async () => {
    getSidecarSettings.mockResolvedValue(SETTINGS);
    snapshotStorage.mockResolvedValue([{ cwd: "D:/work/proj", bytes: 3 * 1024 * 1024 }]);
    renderPage();
    expect(await screen.findByDisplayValue("20000")).toBeTruthy();
    expect(screen.getByDisplayValue("5")).toBeTruthy();
    expect(await screen.findByText("D:/work/proj")).toBeTruthy();
    expect(screen.getByText("3.0 MB")).toBeTruthy();
  });

  it("开关与上限通过 settings.set 保存，非法输入还原并提示", async () => {
    getSidecarSettings.mockResolvedValue(SETTINGS);
    snapshotStorage.mockResolvedValue([]);
    setSidecarSettings.mockImplementation(async (patch) => ({
      ...SETTINGS,
      snapshots: { ...SETTINGS.snapshots, ...patch.snapshots },
    }));
    renderPage();
    await screen.findByDisplayValue("20000");

    fireEvent.click(screen.getByText("关闭"));
    await waitFor(() =>
      expect(setSidecarSettings).toHaveBeenCalledWith({ snapshots: { enabled: false } }),
    );

    const files = screen.getByLabelText("文件数上限");
    fireEvent.change(files, { target: { value: "500" } });
    fireEvent.blur(files);
    await waitFor(() =>
      expect(setSidecarSettings).toHaveBeenCalledWith({ snapshots: { maxFiles: 500 } }),
    );

    const size = screen.getByLabelText("单文件大小上限");
    fireEvent.change(size, { target: { value: "abc" } });
    fireEvent.blur(size);
    expect(await screen.findByText("单文件大小上限需为正整数（MB）。")).toBeTruthy();
    expect((size as HTMLInputElement).value).toBe("5");
  });

  it("清理需确认，确认后调用 snapshot.prune", async () => {
    getSidecarSettings.mockResolvedValue(SETTINGS);
    snapshotStorage.mockResolvedValue([{ cwd: "D:/work/proj", bytes: 1024 }]);
    pruneSnapshots.mockResolvedValue(undefined);
    renderPage();
    fireEvent.click(await screen.findByText("清理"));
    expect(pruneSnapshots).not.toHaveBeenCalled();
    const buttons = await screen.findAllByText("清理");
    fireEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(pruneSnapshots).toHaveBeenCalledWith("D:/work/proj"));
  });
});
