// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider as JotaiProvider, createStore } from "jotai";
import type {
  ComputerUseInstallCommand,
  ComputerUseInstallResult,
  ComputerUseStatus,
  SidecarSettings,
} from "@agentdeck/protocol";
import { sidecarConnectionAtom } from "@/stores/agents";

type ProgressListener = (event: { stream: "stdout" | "stderr"; line: string }) => void;

const getSidecarSettings = vi.fn<() => Promise<SidecarSettings>>();
const setSidecarSettings = vi.fn();
const getComputerUseStatus = vi.fn<() => Promise<ComputerUseStatus>>();
const getComputerUseInstallCommand = vi.fn<() => Promise<ComputerUseInstallCommand>>();
const installComputerUse = vi.fn<() => Promise<ComputerUseInstallResult>>();
const progressListeners = new Set<ProgressListener>();
vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => ({
    getSidecarSettings,
    setSidecarSettings,
    getComputerUseStatus,
    getComputerUseInstallCommand,
    installComputerUse,
    onComputerUseInstallProgress: (listener: ProgressListener) => {
      progressListeners.add(listener);
      return () => progressListeners.delete(listener);
    },
  }),
  humanizeSidecarError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { ComputerUseSettingsSection } from "./computer-use-settings";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  progressListeners.clear();
});

const SETTINGS: SidecarSettings = {
  snapshots: { enabled: true, maxFiles: 20_000, maxFileBytes: 5 * 1024 * 1024 },
  interop: { enabled: true },
  remote: { enabled: false, port: 47_631 },
  idleReclaim: { enabled: true, idleMinutes: 15 },
  translation: { userLanguage: "简体中文", agentLanguage: "English", translateReasoning: false, translateInput: true, enabledByDefault: false },
  computerUse: { enabled: false, allowSelfTargeting: false, approval: "ask", callTimeoutSec: 120 },
};

const INSTALLED: ComputerUseStatus = {
  supported: true,
  installed: true,
  path: "C:\\Users\\u\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe",
  version: "0.9.1",
  running: false,
};

const COMMAND: ComputerUseInstallCommand = {
  program: "pwsh.exe",
  args: ["-NoProfile", "-Command", "irm https://cua.ai/driver/install.ps1 | iex"],
  display: 'pwsh -NoProfile -Command "irm https://cua.ai/driver/install.ps1 | iex"',
  sourceUrl: "https://cua.ai/driver/install.ps1",
};

function renderPage() {
  const store = createStore();
  store.set(sidecarConnectionAtom, "open");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <JotaiProvider store={store}>
        <ComputerUseSettingsSection />
      </JotaiProvider>
    </QueryClientProvider>,
  );
}

/** 某个分段控件里的按钮 */
function rowButton(label: string, button: string): HTMLElement {
  return within(screen.getByRole("group", { name: label })).getByRole("button", { name: button });
}

describe("ComputerUseSettingsSection", () => {
  it("非 Windows 只提示不支持", async () => {
    getSidecarSettings.mockResolvedValue(SETTINGS);
    getComputerUseStatus.mockResolvedValue({ supported: false, installed: false, running: false });
    renderPage();
    expect(await screen.findByText("Computer Use 目前仅支持 Windows。")).toBeTruthy();
  });

  it("已安装：显示版本与路径；启用开关只提交 computerUse.enabled", async () => {
    getSidecarSettings.mockResolvedValue(SETTINGS);
    getComputerUseStatus.mockResolvedValue(INSTALLED);
    setSidecarSettings.mockImplementation(async (patch) => ({
      ...SETTINGS,
      computerUse: { ...SETTINGS.computerUse, ...patch.computerUse },
    }));
    renderPage();
    expect(await screen.findByText(INSTALLED.path!)).toBeTruthy();
    expect(screen.getByText(/版本 0\.9\.1/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "安装驱动" })).toBeNull();

    fireEvent.click(rowButton("启用 Computer Use", "开启"));
    await waitFor(() => expect(setSidecarSettings).toHaveBeenCalledWith({ computerUse: { enabled: true } }));
    await waitFor(() => expect(rowButton("启用 Computer Use", "开启").getAttribute("data-active")).toBe("true"));
  });

  it("审批策略与超时：分段控件只提交对应字段，说明随策略变化", async () => {
    getSidecarSettings.mockResolvedValue(SETTINGS);
    getComputerUseStatus.mockResolvedValue(INSTALLED);
    setSidecarSettings.mockImplementation(async (patch) => ({
      ...SETTINGS,
      computerUse: { ...SETTINGS.computerUse, ...patch.computerUse },
    }));
    renderPage();
    await screen.findByText(INSTALLED.path!);
    expect(rowButton("工具审批策略", "询问").getAttribute("data-active")).toBe("true");
    expect(rowButton("单次调用超时", "120s").getAttribute("data-active")).toBe("true");
    expect(screen.getByText(/每次调用都要审批/)).toBeTruthy();
    for (const label of ["窗口枚举与切换", "系统浏览器联动"]) expect(screen.getByText(label)).toBeTruthy();

    fireEvent.click(rowButton("工具审批策略", "拒绝"));
    await waitFor(() => expect(setSidecarSettings).toHaveBeenCalledWith({ computerUse: { approval: "deny" } }));
    expect(await screen.findByText(/所有 Computer Use 调用直接拒绝/)).toBeTruthy();

    fireEvent.click(rowButton("单次调用超时", "30s"));
    await waitFor(() => expect(setSidecarSettings).toHaveBeenCalledWith({ computerUse: { callTimeoutSec: 30 } }));
    await waitFor(() => expect(rowButton("单次调用超时", "30s").getAttribute("data-active")).toBe("true"));
  });

  it("未安装：不能启用；安装先展示完整命令，确认后才执行并显示输出", async () => {
    getSidecarSettings.mockResolvedValue(SETTINGS);
    getComputerUseStatus.mockResolvedValue({ supported: true, installed: false, running: false });
    getComputerUseInstallCommand.mockResolvedValue(COMMAND);
    let finish: (result: ComputerUseInstallResult) => void = () => {};
    installComputerUse.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    renderPage();

    const install = await screen.findByRole("button", { name: "安装驱动" });
    expect((rowButton("启用 Computer Use", "开启") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(install);

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(COMMAND.display)).toBeTruthy();
    expect(within(dialog).getByText(/将从 https:\/\/cua\.ai\/driver\/install\.ps1 下载并执行官方安装脚本/)).toBeTruthy();
    expect(installComputerUse).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "确认运行" }));
    await waitFor(() => expect(installComputerUse).toHaveBeenCalledTimes(1));
    for (const listener of progressListeners) listener({ stream: "stdout", line: "Downloading cua-driver" });
    expect(await within(dialog).findByText("Downloading cua-driver")).toBeTruthy();

    getComputerUseStatus.mockResolvedValue(INSTALLED);
    finish({ ok: true, exitCode: 0, output: "done" });
    expect(await within(dialog).findByText(/安装完成/)).toBeTruthy();
    await waitFor(() => expect(getComputerUseStatus).toHaveBeenCalledTimes(2));
    expect(progressListeners.size).toBe(0);
  });
});
