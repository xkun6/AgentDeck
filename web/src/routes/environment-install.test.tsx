// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { EnvironmentCheckItem, EnvironmentCheckResult, EnvironmentInstallResult } from "@agentdeck/protocol";
import type { ConfirmDialogSpec } from "@/components/ui/confirm-dialog";
import { EnvironmentSection } from "./environment";

const confirmMock = vi.hoisted(() => vi.fn(async (_spec: ConfirmDialogSpec) => true));
vi.mock("@/lib/use-confirm", () => ({
  useConfirm: () => ({ confirm: confirmMock }),
}));

function missing(id: string, label: string, install: EnvironmentCheckItem["install"]): EnvironmentCheckItem {
  return { id, category: "tools", label, status: "warning", required: false, summary: `${label} 未找到`, install };
}

const ITEMS: EnvironmentCheckItem[] = [
  { id: "git", category: "tools", label: "Git", status: "ok", required: false, summary: "Git 可用", version: "git version 2.54.0" },
  missing("ripgrep", "ripgrep (rg)", {
    command: "winget install --id BurntSushi.ripgrep.MSVC -e --silent",
    available: true,
  }),
  missing("ffmpeg", "ffmpeg", { command: "winget install --id Gyan.FFmpeg -e --silent", available: true }),
  missing("claude-code", "Claude Code CLI", { command: "npm install -g @anthropic-ai/claude-code", available: true }),
  missing("codex", "Codex CLI", {
    command: "npm install -g @openai/codex",
    available: false,
    unavailableReason: "需先安装 Node.js（含 npm）",
  }),
];

function checkResult(): EnvironmentCheckResult {
  return { generatedAtMs: 1, platform: "windows", arch: "x86_64", dataDir: "C:\\data", logDir: "C:\\data\\logs", items: ITEMS };
}

const previousBridge = window.agentdeckDesktop;
const previousRuntime = window.__AGENTDECK_RUNTIME__;
let environmentCheck: Mock<() => Promise<EnvironmentCheckResult>>;
let environmentInstall: Mock<(id: string) => Promise<EnvironmentInstallResult>>;

beforeEach(() => {
  environmentCheck = vi.fn(async () => checkResult());
  environmentInstall = vi.fn(async (_id: string): Promise<EnvironmentInstallResult> => ({ ok: true, exitCode: 0, output: "done" }));
  window.__AGENTDECK_RUNTIME__ = { platform: "tauri" };
  window.agentdeckDesktop = { windowType: "tauri", environmentCheck, environmentInstall };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.agentdeckDesktop = previousBridge;
  window.__AGENTDECK_RUNTIME__ = previousRuntime;
});

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<EnvironmentSection />, { wrapper });
}

function rowOf(label: string): HTMLElement {
  const row = screen.getByText(label).closest("[data-status]");
  if (!(row instanceof HTMLElement)) throw new Error(`未找到 ${label} 所在行`);
  return row;
}

function installButton(label: string): HTMLButtonElement {
  return within(rowOf(label)).getByRole("button", { name: /一键安装|安装中/ }) as HTMLButtonElement;
}

describe("EnvironmentSection 一键安装", () => {
  it("仅缺失且有方案的项显示按钮；前置不可用时禁用并给出原因", async () => {
    renderSection();
    await screen.findByText("ripgrep (rg)");

    expect(screen.getAllByRole("button", { name: /一键安装/ })).toHaveLength(4);
    expect(within(rowOf("Git")).queryByRole("button", { name: /一键安装/ })).toBeNull();
    expect(installButton("ripgrep (rg)").disabled).toBe(false);
    expect(installButton("Codex CLI").disabled).toBe(true);
    expect(within(rowOf("Codex CLI")).getByText("需先安装 Node.js（含 npm）")).toBeTruthy();
  });

  it("确认框展示完整命令；取消则不安装，确认后按 id 调用并显示安装完成、刷新检查", async () => {
    renderSection();
    await screen.findByText("ripgrep (rg)");

    confirmMock.mockResolvedValueOnce(false);
    fireEvent.click(installButton("ripgrep (rg)"));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    const spec = confirmMock.mock.calls[0]![0];
    expect(spec.title).toContain("ripgrep (rg)");
    const body = render(<div>{spec.body}</div>).container.textContent ?? "";
    expect(body).toContain("winget install --id BurntSushi.ripgrep.MSVC -e --silent");
    expect(body).toContain("管理员授权");
    expect(body).toContain("几分钟");
    expect(environmentInstall).not.toHaveBeenCalled();

    const checksBefore = environmentCheck.mock.calls.length;
    fireEvent.click(installButton("ripgrep (rg)"));
    await waitFor(() => expect(environmentInstall).toHaveBeenCalledWith("ripgrep"));
    expect(await within(rowOf("ripgrep (rg)")).findByText("安装完成")).toBeTruthy();
    await waitFor(() => expect(environmentCheck.mock.calls.length).toBeGreaterThan(checksBefore));
  });

  it("安装 Agent CLI 成功后提示重启 sidecar", async () => {
    renderSection();
    await screen.findByText("Claude Code CLI");

    fireEvent.click(installButton("Claude Code CLI"));
    await waitFor(() => expect(environmentInstall).toHaveBeenCalledWith("claude-code"));
    expect(await screen.findByText(/安装完成。如 Agent 仍显示不可用，请重启 sidecar/)).toBeTruthy();
  });

  it("安装中按钮 loading、其它安装按钮禁用；失败显示退出码与可折叠输出", async () => {
    let finish: (result: EnvironmentInstallResult) => void = () => undefined;
    environmentInstall.mockImplementationOnce(
      () => new Promise<EnvironmentInstallResult>((resolve) => { finish = resolve; }),
    );
    renderSection();
    await screen.findByText("ripgrep (rg)");

    fireEvent.click(installButton("ripgrep (rg)"));
    await waitFor(() => expect(installButton("ripgrep (rg)").getAttribute("aria-busy")).toBe("true"));
    expect(installButton("ripgrep (rg)").textContent).toContain("安装中");
    expect(installButton("ffmpeg").disabled).toBe(true);
    expect(installButton("Claude Code CLI").disabled).toBe(true);

    finish({ ok: false, exitCode: 1, output: "npm ERR! code EACCES" });
    const row = rowOf("ripgrep (rg)");
    expect(await within(row).findByText("安装失败（退出码 1）")).toBeTruthy();
    expect(within(row).getByText("查看输出")).toBeTruthy();
    expect(within(row).getByText("npm ERR! code EACCES")).toBeTruthy();
    expect(installButton("ffmpeg").disabled).toBe(false);
  });

  it("命令被拒绝（如已有安装任务）时显示中文错误", async () => {
    environmentInstall.mockRejectedValueOnce(new Error("已有安装任务在进行"));
    renderSection();
    await screen.findByText("ffmpeg");

    fireEvent.click(installButton("ffmpeg"));
    expect(await screen.findByText("安装失败：已有安装任务在进行")).toBeTruthy();
  });
});
