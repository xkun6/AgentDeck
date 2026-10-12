import ReactDOMServer from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

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

describe("PanelComposer", () => {
  it("新任务工具栏显示 Agent / 模型 / 模式选择器", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MemoryRouter>
        <PanelComposer />
      </MemoryRouter>,
    );

    expect(html).toContain('aria-label="Agent"');
    expect(html).toContain('aria-label="模型"');
    expect(html).toContain('aria-label="模式"');
    expect(html).toContain("Codex（不可用：未找到 codex）");
    expect(html).not.toContain("思考强度");
  });

  it("未选择工作区时提示必须先选工作区", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MemoryRouter>
        <PanelComposer />
      </MemoryRouter>,
    );
    expect(html).toContain("请先选择工作区");
  });

  it("URL 带 workspace 时不再提示", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MemoryRouter initialEntries={["/?workspace=%2Ftmp%2Fproj"]}>
        <PanelComposer />
      </MemoryRouter>,
    );
    expect(html).not.toContain("请先选择工作区");
  });
});
