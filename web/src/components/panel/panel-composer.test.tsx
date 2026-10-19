import type { ReactNode } from "react";
import ReactDOMServer from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => ({ getSidecarSettings: vi.fn() }),
}));

vi.mock("@/hooks/use-create-and-send-session", () => ({
  useCreateAndSendSession: () => vi.fn(),
  WORKSPACE_REQUIRED_MESSAGE: "请先选择工作区：Agent 需要在一个工作目录中运行",
}));

vi.mock("@/hooks/use-agent-catalog", () => ({
  useAgentSessionSelection: () => ({
    selection: { provider: "mock", model: null, modeId: null },
    onChange: vi.fn(),
    providers: [
      { id: "mock", kind: "mock", label: "Mock Agent", available: true },
      { id: "codex", kind: "codex", label: "Codex", available: false, unavailableReason: "未找到 codex" },
    ],
    providersLoading: false,
    providersError: undefined,
    catalog: {
      models: [{ provider: "mock", id: "mock-fast", label: "Mock Fast", isDefault: true }],
      modes: [{ id: "default", label: "默认" }],
    },
    catalogLoading: false,
    catalogError: undefined,
  }),
}));

import { PanelComposer } from "./panel-composer";

function Providers({ children, initialEntries }: { children: ReactNode; initialEntries?: string[] }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe("PanelComposer", () => {
  it("新任务工具栏显示 Agent / 模型 / 模式选择器", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <Providers>
        <PanelComposer />
      </Providers>,
    );

    expect(html).toContain('aria-label="Agent：Mock Agent"');
    expect(html).toContain('aria-label="模型：默认模型"');
    expect(html).toContain('aria-label="模式：默认模式"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).not.toContain("思考强度");
    // 翻译开关：设置未加载时按关闭显示（design.md 4.35）
    expect(html).toContain('aria-label="翻译"');
    expect(html).toContain('aria-pressed="false"');
  });

  it("未选择工作区时提示必须先选工作区", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <Providers>
        <PanelComposer />
      </Providers>,
    );
    expect(html).toContain("请先选择工作区");
  });

  it("URL 带 workspace 时不再提示", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <Providers initialEntries={["/?workspace=%2Ftmp%2Fproj"]}>
        <PanelComposer />
      </Providers>,
    );
    expect(html).not.toContain("请先选择工作区");
  });
});
