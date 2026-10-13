// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Provider as JotaiProvider, createStore } from "jotai";
import type { Board, BoardTask } from "@agentdeck/protocol";
import { agentSnapshotsAtom } from "@/stores/agents";
import { ConfirmProvider } from "@/lib/use-confirm";

const actions = {
  upsertBoardTask: vi.fn(),
  deleteBoardTask: vi.fn(),
  mergeBoardTask: vi.fn(),
};
vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => actions,
  humanizeSidecarError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock("@/hooks/use-agent-catalog", () => ({
  useAgentProviders: () => ({
    data: [{ id: "claude", kind: "claude", label: "Claude Code", available: true }],
  }),
  useAgentCatalog: () => ({ data: { models: [], modes: [] }, isLoading: false }),
}));
vi.mock("@/components/chat/preview-rail/review-tab", () => ({
  ReviewTab: ({ workspaceRoot }: { workspaceRoot: string }) => <div data-testid="review-tab">{workspaceRoot}</div>,
}));

import { TaskDrawer } from "./task-drawer";

const PROJECT = "/work/proj";

afterEach(() => {
  cleanup();
  for (const fn of Object.values(actions)) fn.mockReset();
});

function task(patch: Partial<BoardTask> & Pick<BoardTask, "id" | "title" | "status">): BoardTask {
  return { description: "", attempts: 0, maxAttempts: 2, order: 1, createdAt: 1, updatedAt: 1, ...patch };
}

const board: Board = {
  projectPath: PROJECT,
  settings: { worktreePerTask: true, autoDispatch: false, maxConcurrent: 2, defaultAssignee: { provider: "claude" } },
  tasks: [
    task({ id: "a", title: "前置任务", status: "done" }),
    task({ id: "b", title: "审阅中的任务", status: "review", description: "原描述", agentId: "ag1", worktree: { path: "/wt/b", branch: "agentdeck/task-b" } }),
    task({ id: "c", title: "受阻任务", status: "blocked", blockedReason: "缺少数据库密码", attempts: 2 }),
  ],
};

function renderDrawer(taskId: string | null, onClose = vi.fn(), onNotice = vi.fn()) {
  const store = createStore();
  store.set(agentSnapshotsAtom, {
    ag1: {
      id: "ag1", provider: "claude", cwd: "/wt/b", status: "idle", pendingPermissions: [],
      lastSeq: 0, resumable: true, createdAt: 1, updatedAt: 1,
    },
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <JotaiProvider store={store}>
        <ConfirmProvider>
          <MemoryRouter initialEntries={["/"]}>
            <Routes>
              <Route path="/" element={<TaskDrawer projectPath={PROJECT} board={board} taskId={taskId} onClose={onClose} onNotice={onNotice} />} />
              <Route path="/tasks/:id" element={<div>会话页</div>} />
            </Routes>
          </MemoryRouter>
        </ConfirmProvider>
      </JotaiProvider>
    </QueryClientProvider>,
  );
  return { onClose, onNotice };
}

describe("TaskDrawer", () => {
  it("编辑标题 / 描述 / 依赖后保存：带 id 调用 upsertBoardTask", async () => {
    actions.upsertBoardTask.mockResolvedValue(board.tasks[1]);
    renderDrawer("b");
    expect((screen.getByLabelText("标题") as HTMLInputElement).value).toBe("审阅中的任务");
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "改名后" } });
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "新描述" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /前置任务/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(actions.upsertBoardTask).toHaveBeenCalledWith(PROJECT, {
        id: "b",
        title: "改名后",
        description: "新描述",
        assignee: null,
        dependsOn: ["a"],
      }),
    );
  });

  it("标题为空时不能保存并提示", () => {
    renderDrawer("b");
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: " " } });
    expect(screen.getByText("标题不能为空")).toBeTruthy();
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("保存失败（如依赖成环）显示服务端错误", async () => {
    actions.upsertBoardTask.mockRejectedValue(new Error("依赖关系不能成环"));
    renderDrawer("b");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect((await screen.findByRole("alert")).textContent).toContain("依赖关系不能成环");
  });

  it("阻塞任务显示阻塞原因与尝试次数", () => {
    renderDrawer("c");
    expect(screen.getByText(/阻塞原因：缺少数据库密码/)).toBeTruthy();
    expect(screen.getByText("已尝试 2/2")).toBeTruthy();
  });

  it("查看会话跳转到会话页；查看 diff 指向任务 worktree", async () => {
    renderDrawer("b");
    fireEvent.click(screen.getByRole("button", { name: "查看 diff" }));
    expect(screen.getByTestId("review-tab").textContent).toBe("/wt/b");
    fireEvent.click(screen.getByRole("button", { name: /查看会话/ }));
    expect(await screen.findByText("会话页")).toBeTruthy();
  });

  it("合并成功：默认勾选删除 worktree，展示成功提示", async () => {
    actions.mergeBoardTask.mockResolvedValue({ ok: true });
    renderDrawer("b");
    fireEvent.click(screen.getByRole("button", { name: /合并到当前分支/ }));
    await waitFor(() => expect(actions.mergeBoardTask).toHaveBeenCalledWith(PROJECT, "b", true));
    expect(await screen.findByText(/已合并到当前分支，任务已完成/)).toBeTruthy();
  });

  it("取消勾选后合并：removeWorktree 为 false", async () => {
    actions.mergeBoardTask.mockResolvedValue({ ok: true });
    renderDrawer("b");
    fireEvent.click(screen.getByRole("checkbox", { name: /合并成功后删除/ }));
    fireEvent.click(screen.getByRole("button", { name: /合并到当前分支/ }));
    await waitFor(() => expect(actions.mergeBoardTask).toHaveBeenCalledWith(PROJECT, "b", false));
  });

  it("合并冲突：展示冲突文件列表与已中止说明", async () => {
    actions.mergeBoardTask.mockResolvedValue({ ok: false, conflicts: ["src/a.ts", "README.md"] });
    renderDrawer("b");
    fireEvent.click(screen.getByRole("button", { name: /合并到当前分支/ }));
    const alert = await screen.findByText(/合并冲突，已自动中止合并/);
    expect(alert).toBeTruthy();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("README.md")).toBeTruthy();
  });

  it("合并被拒（工作区有未提交改动）显示错误", async () => {
    actions.mergeBoardTask.mockRejectedValue(new Error("项目工作区有未提交改动，请先提交或暂存后再合并"));
    renderDrawer("b");
    fireEvent.click(screen.getByRole("button", { name: /合并到当前分支/ }));
    expect((await screen.findByText(/项目工作区有未提交改动/)).textContent).toContain("请先提交或暂存");
  });

  it("非待评审任务不显示合并区", () => {
    renderDrawer("c");
    expect(screen.queryByRole("button", { name: /合并到当前分支/ })).toBeNull();
  });

  it("删除任务：确认后调用 deleteBoardTask 并关闭；勾选同时删除 worktree", async () => {
    actions.deleteBoardTask.mockResolvedValue({});
    const { onClose } = renderDrawer("b");
    fireEvent.click(screen.getByRole("checkbox", { name: /删除时同时删除 worktree/ }));
    fireEvent.click(screen.getByRole("button", { name: "删除任务" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    await waitFor(() => expect(actions.deleteBoardTask).toHaveBeenCalledWith(PROJECT, "b", true));
    expect(onClose).toHaveBeenCalled();
  });

  it("删除时 worktree 清理失败：把警告交给 onNotice", async () => {
    actions.deleteBoardTask.mockResolvedValue({ warning: "目录被占用" });
    const { onNotice } = renderDrawer("b");
    fireEvent.click(screen.getByRole("button", { name: "删除任务" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("目录被占用")));
  });
});
