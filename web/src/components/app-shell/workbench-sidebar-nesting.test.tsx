// @vitest-environment jsdom
// 侧栏与派单页的拆分，以及「允许被其它会话调用」「复制会话 ID」菜单项（design.md 4.26）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Provider, createStore } from "jotai";
import type { AgentSnapshot } from "@agentdeck/protocol";
import { stubRadixGlobals } from "@/test-utils/radix";
import { ConfirmProvider } from "@/lib/use-confirm";
import { __resetUiStoreForTests } from "@/lib/ui-store";
import { rememberWorkspaceProject } from "@/lib/workspaces";
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

describe("派单与项目列表拆分（4.26）", () => {
  it("子会话不进项目列表，也不把 worktree 目录变成项目或进「其他对话」", () => {
    __resetUiStoreForTests();
    rememberWorkspaceProject("C:/work/demo");
    renderSidebar([
      agent("master"),
      agent("task", { cwd: "C:/data/worktrees/delegate-906423a5", parentAgentId: "master", reportToAgentId: "master" }),
      agent("legacy", { reportToAgentId: "master" }),
      agent("orphan", { origin: "delegate" }),
    ]);
    expect(screen.getAllByText(/^会话-/).map((node) => node.textContent)).toEqual(["会话-master"]);
    expect(screen.queryByText("其他对话")).toBeNull();
    expect(screen.queryByText("delegate-906423a5")).toBeNull();
  });

  it("没有派单关系的会话仍进「其他对话」", () => {
    __resetUiStoreForTests();
    rememberWorkspaceProject("C:/work/demo");
    renderSidebar([agent("master"), agent("task", { cwd: "C:/data/worktrees/delegate-906423a5" })]);
    expect(screen.getByText("其他对话")).toBeTruthy();
  });

  it("主会话行显示进度徽标，有未完成的高亮；普通会话没有徽标", () => {
    renderSidebar([
      agent("master"),
      agent("plain"),
      agent("ok", { parentAgentId: "master", lastTurnOutcome: "completed" }),
      agent("bad", { parentAgentId: "master", lastTurnOutcome: "failed" }),
    ]);
    const badge = screen.getByRole("button", { name: "查看派单进度：会话-master" });
    expect(badge.textContent).toBe("1/2");
    expect(badge.getAttribute("data-attention")).toBe("true");
    expect(badge.getAttribute("title")).toBe("派单：1 失败 · 1 已完成");
    expect(screen.queryByRole("button", { name: "查看派单进度：会话-plain" })).toBeNull();
  });

  it("「派单」入口统计工作中与需要处理的子会话，待审批不重复计数；都已完成时不显示", () => {
    renderSidebar([
      agent("master"),
      agent("run", { parentAgentId: "master", status: "running" }),
      agent("ask", {
        parentAgentId: "master",
        pendingPermissions: [{ id: "p" } as AgentSnapshot["pendingPermissions"][number]],
      }),
      agent("bad", { parentAgentId: "master", lastTurnOutcome: "failed" }),
    ]);
    const entry = screen.getByRole("button", { name: /^派单/ });
    expect(entry.textContent).toContain("3");
    cleanup();
    renderSidebar([agent("master"), agent("ok", { parentAgentId: "master", lastTurnOutcome: "completed" })]);
    expect(screen.getByRole("button", { name: "派单" }).textContent).toBe("派单");
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
