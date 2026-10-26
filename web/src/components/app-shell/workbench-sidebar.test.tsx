// @vitest-environment jsdom
// 侧栏会话列表：不显示归档、置顶在前；右键菜单的重命名 / 置顶 / 归档 / 导出（design.md 4.17）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Provider, createStore } from "jotai";
import type { AgentSnapshot } from "@agentdeck/protocol";
import { AGENT_STATUS_LABELS } from "@/lib/agent-session-display";
import { stubRadixGlobals } from "@/test-utils/radix";
import { ConfirmProvider } from "@/lib/use-confirm";
import { replaceAgentSnapshotsAtom } from "@/stores/agents";
import { __resetUiStoreForTests } from "@/lib/ui-store";
import { GeneralSection } from "@/routes/settings";
import { WorkbenchSidebar } from "./workbench-sidebar";

stubRadixGlobals();

const updateSession = vi.fn(async (_id: string, _patch: unknown) => ({}));
const fetchAllTimelineEntries = vi.fn(async (_id: string) => [] as unknown[]);
const forkSession = vi.fn(async (id: string, _options?: unknown) => ({ id: `${id}-fork` }));
const reclaimSession = vi.fn(async (id: string) => ({ id }));
vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => ({ updateSession, fetchAllTimelineEntries, forkSession, reclaimSession, deleteSession: vi.fn() }),
  humanizeSidecarError: (error: unknown) => String(error),
  isInactiveAgent: (agent: { status?: string } | null | undefined) =>
    agent?.status === "dormant" || agent?.status === "closed",
}));
vi.mock("@/hooks/use-agent-catalog", () => ({ useAgentProviders: () => ({ data: undefined }) }));
vi.mock("@/routes/idle-reclaim-settings", () => ({ IdleReclaimSettingsSection: () => null }));

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

const exportSessionFile = vi.fn();

beforeEach(() => {
  window.agentdeckDesktop = { windowType: "tauri", exportSessionFile } as never;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.agentdeckDesktop = undefined;
  __resetUiStoreForTests();
});

describe("侧栏会话列表", () => {
  it("不显示归档的会话；置顶排在最前，组内按 updatedAt 倒序", () => {
    renderSidebar([
      agent("new", { updatedAt: 5000 }),
      agent("pin-old", { pinned: true, updatedAt: 1000 }),
      agent("gone", { archived: true, updatedAt: 9000 }),
      agent("pin-new", { pinned: true, updatedAt: 3000 }),
    ]);
    expect(screen.queryByText("会话-gone")).toBeNull();
    const order = screen.getAllByText(/^会话-/).map((node) => node.textContent);
    expect(order).toEqual(["会话-pin-new", "会话-pin-old", "会话-new"]);
  });
});

describe("侧栏按项目分组", () => {
  const project = (path: string, updatedAt: number) => ({ path, name: path.split("/").pop(), createdAt: 1, updatedAt });

  it("会话归到 cwd 所在项目；置顶项目在前，其余按最近活动；项目内运行中的在前；未归入项目的放在「其他对话」", () => {
    __resetUiStoreForTests({
      "agentdeck-cn-ui.workspaceProjects": [project("C:/work/alpha", 1), project("C:/work/beta", 1), project("C:/work/empty", 1)],
      "agentdeck-cn-ui.pinnedWorkspaceProjects": ["C:/work/empty"],
    });
    renderSidebar([
      agent("b1", { cwd: "C:/work/beta", updatedAt: 6000 }),
      agent("a1", { cwd: "C:/work/alpha", updatedAt: 5000 }),
      agent("loose", { cwd: "C:/elsewhere", updatedAt: 4000 }),
      agent("a2", { cwd: "C:/work/alpha", status: "running", updatedAt: 3000 }),
    ]);
    const labels = screen.getAllByText(/^(会话-|alpha|beta|empty|其他对话|暂无对话)/).map((node) => node.textContent);
    expect(labels).toEqual(["empty", "暂无对话", "beta", "会话-b1", "alpha", "会话-a2", "会话-a1", "其他对话", "会话-loose"]);
  });

  it("项目可折叠，折叠状态记住", () => {
    __resetUiStoreForTests({ "agentdeck-cn-ui.workspaceProjects": [project("C:/work/demo", 1)] });
    renderSidebar([agent("a", { status: "running" })]);
    fireEvent.click(screen.getByRole("button", { name: "折叠项目：demo" }));
    expect(screen.queryByText("会话-a")).toBeNull();
    cleanup();
    renderSidebar([agent("a")]);
    expect(screen.queryByText("会话-a")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开项目：demo" }));
    expect(screen.getByText("会话-a")).toBeTruthy();
  });

  it("cwd 在项目 git worktree 里的会话按仓库归回该项目；查不到所属仓库的留在「其他对话」", async () => {
    __resetUiStoreForTests({ "agentdeck-cn-ui.workspaceProjects": [project("C:/work/alpha", 1)] });
    const list = vi.fn(async ({ repoPath }: { repoPath: string }) =>
      repoPath === "C:/work/alpha"
        ? [
            { path: "C:/work/alpha", branch: "main", isMain: true, detached: false, locked: false },
            { path: "D:/data/worktrees/task-1", branch: "agentdeck/t1", isMain: false, detached: false, locked: false },
          ]
        : [],
    );
    window.agentdeckDesktop = { windowType: "tauri", exportSessionFile, git: { worktree: { list } } } as never;
    renderSidebar([
      agent("wt", { cwd: "D:\\data\\worktrees\\task-1", updatedAt: 3000 }),
      agent("gone", { cwd: "D:\\data\\worktrees\\task-2", updatedAt: 2000 }),
    ]);
    await waitFor(() =>
      expect(screen.getAllByText(/^(会话-|alpha|其他对话)/).map((node) => node.textContent)).toEqual([
        "alpha",
        "会话-wt",
        "其他对话",
        "会话-gone",
      ]),
    );
    expect(list).toHaveBeenCalledWith({ repoPath: "C:/work/alpha" });
  });

  it("worktree 查询结果会缓存：重挂载不重查，出现新的未归属 cwd 才重查", async () => {
    __resetUiStoreForTests({ "agentdeck-cn-ui.workspaceProjects": [project("C:/work/alpha", 1)] });
    const list = vi.fn(async () => [
      { path: "D:/data/worktrees/task-1", branch: "agentdeck/t1", isMain: false, detached: false, locked: false },
    ]);
    window.agentdeckDesktop = { windowType: "tauri", exportSessionFile, git: { worktree: { list } } } as never;
    const first = renderSidebar([agent("wt", { cwd: "D:\\data\\worktrees\\task-1" })]);
    await waitFor(() => expect(screen.queryByText("其他对话")).toBeNull());
    first.unmount();

    renderSidebar([agent("wt", { cwd: "D:\\data\\worktrees\\task-1" })]);
    expect(screen.queryByText("其他对话")).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
    cleanup();

    renderSidebar([
      agent("wt", { cwd: "D:\\data\\worktrees\\task-1" }),
      agent("other", { cwd: "D:\\elsewhere" }),
    ]);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it("超过 8 个会话时收进「显示更多」", () => {
    __resetUiStoreForTests({ "agentdeck-cn-ui.workspaceProjects": [project("C:/work/demo", 1)] });
    renderSidebar(Array.from({ length: 10 }, (_, index) => agent(`s${index}`, { updatedAt: 100 - index })));
    expect(screen.getAllByText(/^会话-/)).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: "显示更多（2）" }));
    expect(screen.getAllByText(/^会话-/)).toHaveLength(10);
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(screen.getAllByText(/^会话-/)).toHaveLength(8);
  });
});

describe("侧栏会话状态（backgroundActive）", () => {
  it("idle 且 backgroundActive 的悬停提示为「运行中」；普通 idle 为「空闲」", () => {
    renderSidebar([agent("bg", { backgroundActive: true }), agent("plain")]);
    const tooltip = (title: string) => screen.getByText(title).closest("[title]")?.getAttribute("title") ?? "";
    expect(tooltip("会话-bg")).toContain(AGENT_STATUS_LABELS.running);
    expect(tooltip("会话-plain")).toContain(AGENT_STATUS_LABELS.idle);
  });
});

describe("会话右键菜单（4.17）", () => {
  it("菜单含重命名 / 置顶 / 归档 / 导出；点置顶与归档调用 agent.update", async () => {
    renderSidebar([agent("a")]);
    fireEvent.contextMenu(screen.getByText("会话-a"));
    for (const label of ["重命名", "置顶会话", "归档会话", "导出为 JSON", "导出为 Markdown"]) {
      expect(await screen.findByRole("menuitem", { name: label })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("menuitem", { name: "置顶会话" }));
    await waitFor(() => expect(updateSession).toHaveBeenCalledWith("a", { pinned: true }));

    fireEvent.contextMenu(screen.getByText("会话-a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "归档会话" }));
    await waitFor(() => expect(updateSession).toHaveBeenCalledWith("a", { archived: true }));
  });

  it("分叉会话（4.23）：调用 agent.fork（整会话，不带 throughSeq）；运行中的会话禁用", async () => {
    renderSidebar([agent("a")]);
    fireEvent.contextMenu(screen.getByText("会话-a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "分叉会话" }));
    await waitFor(() => expect(forkSession).toHaveBeenCalledWith("a", {}));
    cleanup();

    renderSidebar([agent("b", { status: "running" })]);
    fireEvent.contextMenu(screen.getByText("会话-b"));
    const item = await screen.findByRole("menuitem", { name: "分叉会话" });
    expect(item.getAttribute("aria-disabled") === "true" || item.hasAttribute("data-disabled")).toBe(true);
  });

  it("回收后台进程（4.34）：已加载会话可回收；有后台活动先确认；运行中 / 不可恢复禁用；未加载不显示", async () => {
    renderSidebar([agent("a", { resumable: true })]);
    fireEvent.contextMenu(screen.getByText("会话-a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "回收后台进程" }));
    await waitFor(() => expect(reclaimSession).toHaveBeenCalledWith("a"));
    cleanup();

    reclaimSession.mockClear();
    renderSidebar([agent("b", { resumable: true, backgroundActive: true })]);
    fireEvent.contextMenu(screen.getByText("会话-b"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "回收后台进程" }));
    expect(await screen.findByText(/回收会将其结束/)).toBeTruthy();
    expect(reclaimSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "回收" }));
    await waitFor(() => expect(reclaimSession).toHaveBeenCalledWith("b"));
    cleanup();

    for (const patch of [{ status: "running" as const, resumable: true }, { resumable: false }]) {
      renderSidebar([agent("c", patch)]);
      fireEvent.contextMenu(screen.getByText("会话-c"));
      const item = await screen.findByRole("menuitem", { name: "回收后台进程" });
      expect(item.getAttribute("aria-disabled") === "true" || item.hasAttribute("data-disabled")).toBe(true);
      cleanup();
    }

    renderSidebar([agent("d", { status: "dormant", resumable: true })]);
    fireEvent.contextMenu(screen.getByText("会话-d"));
    await screen.findByRole("menuitem", { name: "分叉会话" });
    expect(screen.queryByRole("menuitem", { name: "回收后台进程" })).toBeNull();
  });

  it("回收失败时用提示框反馈", async () => {
    reclaimSession.mockRejectedValueOnce(new Error("该会话不支持恢复"));
    renderSidebar([agent("a", { resumable: true })]);
    fireEvent.contextMenu(screen.getByText("会话-a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "回收后台进程" }));
    expect(await screen.findByText(/该会话不支持恢复/)).toBeTruthy();
  });

  it("分叉失败时用提示框反馈", async () => {
    forkSession.mockRejectedValueOnce(new Error("原生分叉会话失败：炸了"));
    renderSidebar([agent("a")]);
    fireEvent.contextMenu(screen.getByText("会话-a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "分叉会话" }));
    expect(await screen.findByText(/原生分叉会话失败：炸了/)).toBeTruthy();
  });

  it("已置顶显示「取消置顶会话」；运行中的会话不提供归档", async () => {
    renderSidebar([agent("a", { pinned: true, status: "running" })]);
    fireEvent.contextMenu(screen.getByText("会话-a"));
    expect(await screen.findByRole("menuitem", { name: "取消置顶会话" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "归档会话" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "取消归档" })).toBeNull();
  });

  it("重命名：保存新标题；恢复自动标题以 null 提交；取消不调用", async () => {
    renderSidebar([agent("a")]);
    fireEvent.contextMenu(screen.getByText("会话-a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));
    const input = (await screen.findByLabelText("会话标题")) as HTMLInputElement;
    expect(input.value).toBe("会话-a");
    fireEvent.change(input, { target: { value: "新名字" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(updateSession).toHaveBeenCalledWith("a", { title: "新名字" }));

    fireEvent.contextMenu(screen.getByText("会话-a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));
    fireEvent.click(await screen.findByRole("button", { name: "恢复自动标题" }));
    await waitFor(() => expect(updateSession).toHaveBeenLastCalledWith("a", { title: null }));

    updateSession.mockClear();
    fireEvent.contextMenu(screen.getByText("会话-a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("没有自定义标题时重命名弹窗不提供「恢复自动标题」", async () => {
    renderSidebar([agent("a", { title: undefined, preview: "首条消息" })]);
    fireEvent.contextMenu(screen.getByText("首条消息"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));
    expect(await screen.findByLabelText("会话标题")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "恢复自动标题" })).toBeNull();
  });

  it("导出：取全量时间线、调用桥并提示成功；取消保存对话框不提示", async () => {
    exportSessionFile.mockResolvedValueOnce({ ok: true, canceled: false, path: "C:/out/a.md", bytes: 10 });
    renderSidebar([agent("a")]);
    fireEvent.contextMenu(screen.getByText("会话-a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "导出为 Markdown" }));
    await waitFor(() => expect(exportSessionFile).toHaveBeenCalledTimes(1));
    expect(fetchAllTimelineEntries).toHaveBeenCalledWith("a");
    const input = exportSessionFile.mock.calls[0]![0] as { fileName: string; content: string; format: string };
    expect(input.format).toBe("markdown");
    expect(input.fileName).toMatch(/^会话-a-\d{8}-\d{4}$/);
    expect(input.content.startsWith("# 会话-a\n")).toBe(true);
    expect(await screen.findByText(/已导出到 C:\/out\/a\.md/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));

    exportSessionFile.mockResolvedValueOnce({ ok: false, canceled: true, bytes: 0 });
    fireEvent.contextMenu(screen.getByText("会话-a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "导出为 JSON" }));
    await waitFor(() => expect(exportSessionFile).toHaveBeenCalledTimes(2));
    expect((exportSessionFile.mock.calls[1]![0] as { format: string }).format).toBe("json");
    expect(screen.queryByText(/导出失败|导出成功/)).toBeNull();
  });

  it("导出失败时提示错误", async () => {
    exportSessionFile.mockResolvedValueOnce({ ok: false, canceled: false, bytes: 0, error: "拒绝访问" });
    renderSidebar([agent("a")]);
    fireEvent.contextMenu(screen.getByText("会话-a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "导出为 JSON" }));
    expect(await screen.findByText("拒绝访问")).toBeTruthy();
  });
});

describe("侧栏快捷入口开关", () => {
  it("设置里关掉的入口从侧栏消失、再打开恢复；「新建对话」不可关", () => {
    const store = createStore();
    render(
      <Provider store={store}>
        <ConfirmProvider>
          <MemoryRouter>
            <WorkbenchSidebar />
            <GeneralSection />
          </MemoryRouter>
        </ConfirmProvider>
      </Provider>,
    );
    const nav = within(screen.getByRole("navigation", { name: "主导航" }));
    const toggle = (name: string) => screen.getByRole("button", { name, pressed: true });
    expect(nav.getByRole("button", { name: "终端" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "新建对话", pressed: true })).toBeNull();

    fireEvent.click(toggle("终端"));
    expect(nav.queryByRole("button", { name: "终端" })).toBeNull();
    expect(nav.getByRole("button", { name: "新建对话" })).toBeTruthy();
    expect(nav.getByRole("button", { name: "对话历史" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "终端", pressed: false }));
    expect(nav.getByRole("button", { name: "终端" })).toBeTruthy();
  });
});
