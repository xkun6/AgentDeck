// @vitest-environment jsdom
import type { ReactNode } from "react";
import ReactDOMServer from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CodingAgentStatus } from "@agentdeck/protocol";

import { useSaveCodingAgentPath } from "@/hooks/use-coding-agents";
import { AGENT_QUERY_KEYS } from "@/lib/agent-query-keys";
import { AgentPathField, CodingAgentToolbar } from "./settings-coding-agents";

const previousBridge = window.hermesDesktop;
afterEach(() => {
  cleanup();
  window.hermesDesktop = previousBridge;
});

describe("CodingAgentToolbar", () => {
  it("为两个顶部操作使用同一按钮规格", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <CodingAgentToolbar
        isFetching={false}
        hasBridge
        onRefresh={() => undefined}
        diagnostics={() => "{}"}
      />,
    );

    expect(html).toContain('role="toolbar"');
    expect(html.match(/data-coding-agent-action="true"/g)).toHaveLength(2);
    expect(html).toContain("刷新检测");
    expect(html).toContain("复制诊断 JSON");
  });
});

function agent(overrides: Partial<CodingAgentStatus> = {}): CodingAgentStatus {
  return {
    id: "claude-code",
    label: "Claude Code",
    installed: true,
    version: "2.1.296",
    path: "C:\\auto\\claude.exe",
    configuredPath: null,
    loginState: "logged_in",
    configDir: "C:\\Users\\u\\.claude",
    skillName: "claude-code",
    installHint: "npm install -g @anthropic-ai/claude-code",
    loginHint: "运行 claude",
    ...overrides,
  };
}

function pathInput(): HTMLInputElement {
  return screen.getByLabelText("Claude Code 可执行文件路径") as HTMLInputElement;
}

describe("AgentPathField", () => {
  it("未配置：显示自动查找与当前生效路径，留空占位；浏览后保存去空白的路径", async () => {
    const pickExecutableFile = vi.fn(async () => ({ canceled: false, paths: ["  D:\\tools\\claude.exe "] }));
    window.hermesDesktop = { windowType: "tauri", pickExecutableFile, codingAgentPathsSet: vi.fn() };
    const onSave = vi.fn(async () => undefined);
    render(<AgentPathField agent={agent()} onSave={onSave} />);

    expect(screen.getAllByText(/自动查找/).length).toBeGreaterThan(0);
    expect(screen.getByText("C:\\auto\\claude.exe")).toBeTruthy();
    expect(pathInput().placeholder).toBe("留空则自动查找");
    expect((screen.getByRole("button", { name: /恢复自动查找/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /保存/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /浏览/ }));
    await waitFor(() => expect(pathInput().value).toBe("  D:\\tools\\claude.exe "));
    expect(pickExecutableFile).toHaveBeenCalledWith({ title: "选择 Claude Code 可执行文件" });

    fireEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("D:\\tools\\claude.exe"));
    expect(await screen.findByText(/已保存/)).toBeTruthy();
  });

  it("已手动配置：显示手动配置，恢复自动查找时以 null 保存；失败时就地显示中文错误", async () => {
    window.hermesDesktop = { windowType: "tauri", codingAgentPathsSet: vi.fn() };
    const onSave = vi.fn(async (value: string | null) => {
      if (value === null) throw new Error("写入配置失败：拒绝访问");
    });
    render(
      <AgentPathField
        agent={agent({ installed: false, path: undefined, configuredPath: "D:\\gone\\claude.exe" })}
        onSave={onSave}
      />,
    );

    expect(screen.getByText("手动配置")).toBeTruthy();
    expect(pathInput().value).toBe("D:\\gone\\claude.exe");
    expect(screen.getByText("未找到可用的可执行文件")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /恢复自动查找/ }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
    expect(await screen.findByText("保存失败：写入配置失败：拒绝访问")).toBeTruthy();
  });
});

describe("useSaveCodingAgentPath", () => {
  it("读出当前配置后整份写回，并让检测与 sidecar provider 查询失效", async () => {
    const codingAgentPathsGet = vi.fn(async () => ({ claude: "C:\\a\\claude.exe" }));
    const codingAgentPathsSet = vi.fn(async (paths: object) => paths);
    window.hermesDesktop = { windowType: "tauri", codingAgentPathsGet, codingAgentPathsSet };
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useSaveCodingAgentPath(), { wrapper });

    await act(async () => {
      await result.current("codex", "C:\\b\\codex.exe");
    });
    expect(codingAgentPathsSet).toHaveBeenCalledWith({ claude: "C:\\a\\claude.exe", codex: "C:\\b\\codex.exe" });
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toContainEqual(["desktop-coding-agents-check"]);
    expect(keys).toContainEqual(AGENT_QUERY_KEYS.providers);

    await act(async () => {
      await result.current("claude", null);
    });
    expect(codingAgentPathsSet).toHaveBeenLastCalledWith({ claude: null });
  });
});
