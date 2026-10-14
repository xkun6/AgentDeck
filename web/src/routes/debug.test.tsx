// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider as JotaiProvider, createStore } from "jotai";

vi.mock("@/hooks/use-agent-catalog", () => ({
  useAgentProviders: () => ({
    data: [
      { id: "claude", kind: "claude", label: "Claude Code", available: true },
      { id: "codex", kind: "codex", label: "Codex", available: false, unavailableReason: "未安装" },
    ],
    isLoading: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-coding-agents", () => ({
  useCodingAgentsCheck: () => ({
    data: {
      generatedAtMs: 0,
      platform: "win32",
      agents: [
        { id: "claude-code", label: "Claude Code", installed: true, version: "2.1.0", path: "C:/claude.exe" },
        { id: "codex", label: "Codex", installed: false },
      ],
    },
    refetch: vi.fn(),
  }),
}));

import { debugBus } from "@/lib/debug-bus";
import { DebugSection } from "./debug";

const previousBridge = window.agentdeckDesktop;
afterEach(() => {
  cleanup();
  window.agentdeckDesktop = previousBridge;
  debugBus.clear();
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <JotaiProvider store={createStore()}>
        <DebugSection />
      </JotaiProvider>
    </QueryClientProvider>,
  );
}

describe("DebugSection", () => {
  it("渲染各分区，显示 sidecar 日志与端口但不显示 token", async () => {
    window.agentdeckDesktop = {
      windowType: "tauri",
      sidecarStatus: async () => ({ wsUrl: "ws://127.0.0.1:8123/ws", token: "SECRET-TOKEN", version: "1.2.3", status: "ready", error: null, pid: 4242 }),
      debugPaths: async () => ({ dataDir: "D:/data", logDir: "D:/data/logs" }),
      logTail: async () => ({ path: "D:/data/logs/sidecar.log", text: "t [info] hello\nt [error] bad thing", truncated: false, size: 30 }),
      openWorkspacePath: vi.fn(async () => ({ ok: true, status: 200, body: "" })),
    } as never;
    debugBus.push({ type: "console", level: "error", summary: "前端坏了" });

    renderPage();

    for (const title of ["运行状态", "路径", "Agent 可用性", "前端事件", "sidecar 日志", "操作"]) {
      expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    }
    expect(screen.getByText("重启 sidecar")).toBeTruthy();
    expect(screen.getByText("导出诊断包")).toBeTruthy();
    expect(screen.getByText("未安装")).toBeTruthy();
    expect(screen.getByText(/前端坏了/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText("D:/data/logs", { selector: "span" })).toBeTruthy());
    await waitFor(() => expect(screen.getByText("8123")).toBeTruthy());
    expect(screen.getByText("4242")).toBeTruthy();
    expect(document.body.textContent).not.toContain("SECRET-TOKEN");

    await waitFor(() => expect(screen.getByLabelText("sidecar 日志").textContent).toContain("hello"));
    fireEvent.change(screen.getByLabelText("日志级别"), { target: { value: "error" } });
    expect(screen.getByLabelText("sidecar 日志").textContent).not.toContain("hello");
    expect(screen.getByLabelText("sidecar 日志").textContent).toContain("bad thing");
  });

  it("provider 与编程 Agent 检测合并为一行", () => {
    window.agentdeckDesktop = { windowType: "tauri" } as never;
    renderPage();
    expect(screen.getAllByText("Claude Code")).toHaveLength(1);
    expect(screen.getAllByText("Codex")).toHaveLength(1);
    expect(screen.getByText("2.1.0 · C:/claude.exe")).toBeTruthy();
    expect(screen.queryByText("已安装")).toBeNull();
  });

  it("清空按钮清除前端事件", () => {
    window.agentdeckDesktop = { windowType: "tauri" } as never;
    debugBus.push({ type: "console", level: "warn", summary: "待清除事件" });
    renderPage();
    expect(screen.getByText(/待清除事件/)).toBeTruthy();
    fireEvent.click(screen.getByText("清空"));
    return waitFor(() => expect(screen.queryByText(/待清除事件/)).toBeNull());
  });
});
