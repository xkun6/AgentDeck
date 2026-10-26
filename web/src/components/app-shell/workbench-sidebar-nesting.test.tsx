// @vitest-environment jsdom
// 侧栏子会话嵌套与「允许被其它会话调用」「复制会话 ID」菜单项（design.md 4.26）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Provider, createStore } from "jotai";
import type { AgentSnapshot } from "@agentdeck/protocol";
import { stubRadixGlobals } from "@/test-utils/radix";
import { ConfirmProvider } from "@/lib/use-confirm";
import { replaceAgentSnapshotsAtom } from "@/stores/agents";
import { WorkbenchSidebar } from "./workbench-sidebar";

stubRadixGlobals();

const updateSession = vi.fn(async (_id: string, _patch: unknown) => ({}));
vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => ({
    updateSession,
    fetchAllTimelineEntries: vi.fn(async () => []),
    forkSession: vi.fn(),
    deleteSession: vi.fn(),
  }),
  humanizeSidecarError: (error: unknown) => String(error),
  isInactiveAgent: (agent: { status?: string } | null | undefined) =>
    agent?.status === "dormant" || agent?.status === "closed",
}));
vi.mock("@/hooks/use-agent-catalog", () => ({ useAgentProviders: () => ({ data: undefined }) }));

function agent(id: string, patch: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id,
    provider: "claude",
    cwd: "C:/work/demo",
    title: `会话-${id}`,
    status: "idle",
    pendingPermissions: [],
    lastSeq: 0,
    resumable: false,
    createdAt: 1000,
    updatedAt: 2000,
    ...patch,
  };
}

function renderSidebar(agents: AgentSnapshot[]) {
  const store = createStore();
  store.set(replaceAgentSnapshotsAtom, agents);
  return render(
    <Provider store={store}>
      <ConfirmProvider>
        <MemoryRouter>
          <WorkbenchSidebar />
        </MemoryRouter>
      </ConfirmProvider>
    </Provider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("子会话嵌套", () => {
  it("子会话缩进显示在父会话下，不在顶层重复出现；父会话行可折叠 / 展开", () => {
    renderSidebar([
      agent("child1", { parentAgentId: "parent", updatedAt: 4000 }),
      agent("other", { updatedAt: 3000 }),
      agent("parent", { updatedAt: 2000 }),
      agent("child2", { parentAgentId: "parent", updatedAt: 1000 }),
    ]);
    // 顺序：other（根）、parent（根）、其下 child1、child2
    expect(screen.getAllByText(/^会话-/).map((node) => node.textContent)).toEqual([
      "会话-other",
      "会话-parent",
      "会话-child1",
      "会话-child2",
    ]);
    expect(screen.getByText("会话-child1").closest("[data-depth]")?.getAttribute("data-depth")).toBe("1");
    expect(screen.getByText("会话-parent").closest("[data-depth]")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "折叠子会话：会话-parent" }));
    expect(screen.queryByText("会话-child1")).toBeNull();
    expect(screen.queryByText("会话-child2")).toBeNull();
    expect(screen.getByText("+2")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "展开子会话：会话-parent" }));
    expect(screen.getByText("会话-child1")).toBeTruthy();
  });

  it("子会话在运行时整块排在前面；父会话已归档的子会话当作顶层显示", () => {
    renderSidebar([
      agent("parent", { updatedAt: 3000 }),
      agent("child", { parentAgentId: "parent", status: "running", updatedAt: 2000 }),
      agent("orphan", { parentAgentId: "gone", updatedAt: 1000 }),
      agent("gone", { archived: true }),
    ]);
    const labels = screen.getAllByText(/^会话-/).map((node) => node.textContent);
    // 运行中的块：parent + child；其后 orphan（父会话已归档，退化为顶层）
    expect(labels).toEqual(["会话-parent", "会话-child", "会话-orphan"]);
    expect(screen.getByText("会话-orphan").closest("[data-depth]")).toBeNull();
    expect(screen.queryByText("会话-gone")).toBeNull();
  });
});

describe("右键菜单「允许被其它会话调用」", () => {
  it("点击切换 interopTarget", async () => {
    renderSidebar([agent("a"), agent("b", { interopTarget: true })]);
    fireEvent.contextMenu(screen.getByText("会话-a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "允许被其它会话调用" }));
    await waitFor(() => expect(updateSession).toHaveBeenCalledWith("a", { interopTarget: true }));

    fireEvent.contextMenu(screen.getByText("会话-b"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "允许被其它会话调用" }));
    await waitFor(() => expect(updateSession).toHaveBeenCalledWith("b", { interopTarget: false }));
  });

  it("「缓存保活」只对 Claude 会话显示，点击切换 cacheKeepAlive（design.md 4.36）", async () => {
    renderSidebar([
      agent("a"),
      agent("b", { cacheKeepAlive: true }),
      agent("c", { provider: "codex" }),
    ]);
    fireEvent.contextMenu(screen.getByText("会话-a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "缓存保活" }));
    await waitFor(() => expect(updateSession).toHaveBeenCalledWith("a", { cacheKeepAlive: true }));

    fireEvent.contextMenu(screen.getByText("会话-b"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "缓存保活" }));
    await waitFor(() => expect(updateSession).toHaveBeenCalledWith("b", { cacheKeepAlive: false }));

    fireEvent.contextMenu(screen.getByText("会话-c"));
    await screen.findByRole("menuitem", { name: "复制会话 ID" });
    expect(screen.queryByRole("menuitem", { name: "缓存保活" })).toBeNull();
  });

  it("「复制会话 ID」把 agentId 写入剪贴板", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderSidebar([agent("a")]);
    fireEvent.contextMenu(screen.getByText("会话-a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "复制会话 ID" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("a"));
  });
});
