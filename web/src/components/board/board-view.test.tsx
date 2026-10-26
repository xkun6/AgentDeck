// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Provider as JotaiProvider, createStore } from "jotai";
import type { AgentSnapshot, Board, BoardTask } from "@agentdeck/protocol";
import { agentSnapshotsAtom, sidecarConnectionAtom } from "@/stores/agents";
import { replaceBoardAtom } from "@/stores/boards";
import { ConfirmProvider } from "@/lib/use-confirm";

const actions = {
  getBoard: vi.fn(),
  moveBoardTask: vi.fn(),
  upsertBoardTask: vi.fn(),
  deleteBoardTask: vi.fn(),
  mergeBoardTask: vi.fn(),
  updateBoardSettings: vi.fn(),
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

import { BoardView } from "./board-view";

const PROJECT = "C:/work/proj";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const fn of Object.values(actions)) fn.mockReset();
});

function task(patch: Partial<BoardTask> & Pick<BoardTask, "id" | "title" | "status" | "order">): BoardTask {
  return { description: "", attempts: 0, maxAttempts: 2, createdAt: 1, updatedAt: 1, ...patch };
}

const board: Board = {
  projectPath: PROJECT,
  settings: { worktreePerTask: true, autoDispatch: false, maxConcurrent: 2, defaultAssignee: { provider: "claude" } },
  tasks: [
    task({ id: "t1", title: "写登录", status: "todo", order: 1 }),
    task({ id: "t2", title: "写注册", status: "todo", order: 2, dependsOn: ["t1"], assignee: { provider: "claude", model: "opus" } }),
    task({ id: "t3", title: "跑测试", status: "running", order: 1, agentId: "a1" }),
    task({ id: "t4", title: "部署", status: "blocked", order: 1, blockedReason: "缺少密钥" }),
    task({ id: "t5", title: "改文档", status: "review", order: 1, worktree: { path: "/wt/t5", branch: "agentdeck/task-t5" } }),
    task({ id: "t6", title: "初始化", status: "done", order: 1 }),
  ],
};

const agent = (patch: Partial<AgentSnapshot> = {}): AgentSnapshot => ({
  id: "a1", provider: "claude", cwd: PROJECT, status: "running", pendingPermissions: [],
  lastSeq: 0, resumable: true, createdAt: 1, updatedAt: 1, ...patch,
});

function renderBoard(options: { agents?: AgentSnapshot[]; board?: Board } = {}) {
  actions.getBoard.mockResolvedValue(options.board ?? board);
  const store = createStore();
  store.set(sidecarConnectionAtom, "open");
  store.set(agentSnapshotsAtom, Object.fromEntries((options.agents ?? [agent()]).map((item) => [item.id, item])));
  store.set(replaceBoardAtom, options.board ?? board);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <JotaiProvider store={store}>
        <ConfirmProvider>
          <MemoryRouter>
            <BoardView projectPath={PROJECT} />
          </MemoryRouter>
        </ConfirmProvider>
      </JotaiProvider>
    </QueryClientProvider>,
  );
  return store;
}

/** jsdom 的拖拽事件不带 clientY，手动补上 */
function dropAt(element: Element, clientY: number) {
  const event = createEvent.drop(element);
  Object.defineProperty(event, "clientY", { value: clientY });
  fireEvent(element, event);
}

const column = (name: string) => screen.getByRole("region", { name });

describe("BoardView", () => {
  it("进入时拉取看板；渲染五列与各列卡片", async () => {
    renderBoard();
    await waitFor(() => expect(actions.getBoard).toHaveBeenCalledWith(PROJECT));
    for (const name of ["待办", "运行中", "待评审", "完成", "阻塞"]) {
      expect(column(name)).toBeTruthy();
    }
    expect(within(column("待办")).getAllByRole("article").map((card) => card.textContent)).toEqual([
      expect.stringContaining("写登录"),
      expect.stringContaining("写注册"),
    ]);
    expect(within(column("运行中")).getByText("跑测试")).toBeTruthy();
    expect(within(column("待评审")).getByText("改文档")).toBeTruthy();
    expect(within(column("完成")).getByText("初始化")).toBeTruthy();
  });

  it("卡片显示指派 Agent、关联会话状态与阻塞原因", () => {
    renderBoard();
    const running = within(column("运行中")).getByRole("article");
    expect(running.textContent).toContain("Claude Code");
    expect(within(running).getByText("运行中")).toBeTruthy();
    const todo2 = within(column("待办")).getAllByRole("article")[1]!;
    expect(todo2.textContent).toContain("Claude Code（opus）");
    expect(within(column("阻塞")).getByText("缺少密钥")).toBeTruthy();
  });

  it("会话等待审批时卡片显示「等待审批」", () => {
    renderBoard({
      agents: [agent({ pendingPermissions: [{ id: "p1", kind: "tool", title: "x" } as never] })],
    });
    expect(within(column("运行中")).getByText("等待审批")).toBeTruthy();
  });

  it("拖到另一列：以该列末尾的 order 调用 moveBoardTask", async () => {
    actions.moveBoardTask.mockResolvedValue(board);
    renderBoard();
    const card = screen.getByTestId("task-t2");
    fireEvent.dragStart(card);
    fireEvent.dragOver(column("运行中"));
    fireEvent.drop(column("运行中"));
    await waitFor(() => expect(actions.moveBoardTask).toHaveBeenCalledWith(PROJECT, "t2", "running", 2));
  });

  it("列内排序：放到某张卡片上半部分 → 排在它前面", async () => {
    actions.moveBoardTask.mockResolvedValue(board);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 100, height: 40, bottom: 140, left: 0, right: 100, width: 100, x: 0, y: 100, toJSON: () => ({}),
    });
    renderBoard();
    fireEvent.dragStart(screen.getByTestId("task-t2"));
    dropAt(screen.getByTestId("task-t1"), 105);
    await waitFor(() => expect(actions.moveBoardTask).toHaveBeenCalledWith(PROJECT, "t2", "todo", 0));
  });

  it("列内排序：放到卡片下半部分 → 排在它后面（与下一张取中点）", async () => {
    actions.moveBoardTask.mockResolvedValue(board);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 100, height: 40, bottom: 140, left: 0, right: 100, width: 100, x: 0, y: 100, toJSON: () => ({}),
    });
    const withThree: Board = {
      ...board,
      tasks: [...board.tasks, task({ id: "t7", title: "第三个", status: "todo", order: 3 })],
    };
    renderBoard({ board: withThree });
    fireEvent.dragStart(screen.getByTestId("task-t7"));
    dropAt(screen.getByTestId("task-t1"), 130);
    await waitFor(() => expect(actions.moveBoardTask).toHaveBeenCalledWith(PROJECT, "t7", "todo", 1.5));
  });

  it("运行中的任务移出 running 前先确认；取消则不调用", async () => {
    actions.moveBoardTask.mockResolvedValue(board);
    renderBoard();
    fireEvent.dragStart(screen.getByTestId("task-t3"));
    fireEvent.drop(column("待办"));
    const dialog = await screen.findByRole("alertdialog").catch(() => screen.findByRole("dialog"));
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByText("中断运行中的任务")).toBeNull());
    expect(actions.moveBoardTask).not.toHaveBeenCalled();

    fireEvent.dragStart(screen.getByTestId("task-t3"));
    fireEvent.drop(column("待办"));
    fireEvent.click(await screen.findByRole("button", { name: "中断并移动" }));
    await waitFor(() => expect(actions.moveBoardTask).toHaveBeenCalledWith(PROJECT, "t3", "todo", 3));
  });

  it("移动失败时显示错误", async () => {
    actions.moveBoardTask.mockRejectedValue(new Error("派发失败"));
    renderBoard();
    fireEvent.dragStart(screen.getByTestId("task-t1"));
    fireEvent.drop(column("完成"));
    expect((await screen.findByRole("alert")).textContent).toContain("派发失败");
  });

  it("新建任务：打开抽屉，填标题后创建", async () => {
    actions.upsertBoardTask.mockResolvedValue(board.tasks[0]);
    renderBoard();
    fireEvent.click(screen.getByRole("button", { name: /新建任务/ }));
    const input = await screen.findByLabelText("标题");
    fireEvent.change(input, { target: { value: "  新任务  " } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() =>
      expect(actions.upsertBoardTask).toHaveBeenCalledWith(PROJECT, {
        title: "新任务",
        description: "",
        assignee: null,
        dependsOn: [],
      }),
    );
  });

  it("点击卡片打开详情抽屉；看板设置按钮打开设置弹窗", async () => {
    renderBoard();
    fireEvent.click(screen.getByTestId("task-t1"));
    expect(await screen.findByText("任务详情")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "关闭" })[0]!);
    fireEvent.click(await screen.findByRole("button", { name: /看板设置/ }));
    expect(await screen.findByLabelText("并发上限")).toBeTruthy();
  });
});
