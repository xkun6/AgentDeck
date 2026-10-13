// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentBackgroundTask } from "@agentdeck/protocol";

const stopBackgroundTask = vi.fn<(agentId: string, taskId: string) => Promise<void>>();

vi.mock("@/hooks/use-agent-session", () => {
  const actions = {
    stopBackgroundTask: (...args: [string, string]) => stopBackgroundTask(...args),
  };
  return {
    useAgentSession: () => actions,
    humanizeSidecarError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  };
});

const { BackgroundTaskTrack } = await import("./background-task-track");

beforeEach(() => {
  stopBackgroundTask.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function task(taskId: string, patch: Partial<AgentBackgroundTask> = {}): AgentBackgroundTask {
  return {
    taskId,
    kind: "command",
    description: `任务 ${taskId}`,
    status: "running",
    startedAt: 1_000_000,
    ...patch,
  };
}

function openList() {
  fireEvent.click(screen.getByRole("button", { name: /后台任务/ }));
}

describe("BackgroundTaskTrack 药丸", () => {
  it("没有任务时不渲染", () => {
    const { container } = render(<BackgroundTaskTrack agentId="a1" tasks={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("有运行中显示「后台任务 N 运行中」，全部结束显示「N 个已结束」", () => {
    const { rerender } = render(
      <BackgroundTaskTrack agentId="a1" tasks={[task("t1"), task("t2"), task("t3", { status: "completed" })]} />,
    );
    expect(screen.getByRole("button", { name: /后台任务/ }).textContent).toContain("后台任务");
    expect(screen.getByRole("button", { name: /后台任务/ }).textContent).toContain("2 运行中");
    rerender(
      <BackgroundTaskTrack
        agentId="a1"
        tasks={[task("t1", { status: "completed" }), task("t2", { status: "failed" })]}
      />,
    );
    expect(screen.getByRole("button", { name: /后台任务/ }).textContent).toContain("2 个已结束");
  });

  it("展开后每行是 button：显示描述（无描述取命令首行）、状态、耗时；不显示 token / 工具次数 / 输出按钮", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000 + 65_000);
    render(
      <BackgroundTaskTrack
        agentId="a1"
        tasks={[
          task("c1", { hasOutput: true }),
          task("c2", {
            description: "",
            command: "cd x && pnpm build\nnext",
            status: "completed",
            endedAt: 1_000_000 + 3_723_000,
            usage: { totalTokens: 12_345, toolUses: 5 },
          }),
          task("f1", { status: "failed", endedAt: 1_000_000 + 2_000, error: "exit code 1" }),
          task("s1", { status: "stopped", endedAt: 1_000_000, error: "会话已结束" }),
        ]}
      />,
    );
    openList();
    const items = Array.from(document.querySelectorAll("li"));
    expect(items).toHaveLength(4);
    const rowOf = (index: number) => items[index]!.querySelector("button[data-status]") as HTMLElement;
    expect(rowOf(0).textContent).toContain("任务 c1");
    expect(rowOf(0).textContent).toContain("运行中");
    expect(rowOf(0).textContent).toContain("01:05");
    expect(rowOf(0).querySelector("[data-status='running']")).not.toBeNull();
    expect(rowOf(1).textContent).toContain("cd x && pnpm build");
    expect(rowOf(1).textContent).toContain("已完成");
    expect(rowOf(1).textContent).toContain("1:02:03");
    expect(rowOf(1).textContent).not.toContain("tokens");
    expect(items[2]!.textContent).toContain("失败");
    expect(items[2]!.textContent).toContain("exit code 1");
    expect(items[3]!.textContent).toContain("已停止");
    expect(items[3]!.textContent).toContain("会话已结束");
    expect(screen.queryByRole("button", { name: "输出" })).toBeNull();
    // 只有运行中的行带「停止」
    expect(screen.getAllByRole("button", { name: "停止" })).toHaveLength(1);
  });

  it("运行中耗时每秒刷新", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    render(<BackgroundTaskTrack agentId="a1" tasks={[task("t1")]} />);
    openList();
    expect(screen.getByText("00:00")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText("00:03")).toBeTruthy();
  });

  it("「清除已结束」只隐藏已结束项，运行中保留；全部隐藏后药丸消失", () => {
    const { rerender } = render(
      <BackgroundTaskTrack agentId="a1" tasks={[task("t1"), task("t2", { status: "completed" })]} />,
    );
    openList();
    fireEvent.click(screen.getByRole("button", { name: "清除已结束" }));
    expect(screen.queryByText("任务 t2")).toBeNull();
    expect(screen.getByText("任务 t1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "清除已结束" })).toBeNull();
    rerender(<BackgroundTaskTrack agentId="a1" tasks={[task("t2", { status: "completed" })]} />);
    expect(screen.queryByRole("button", { name: /后台任务/ })).toBeNull();
  });
});

describe("BackgroundTaskTrack 选中", () => {
  it("点击一行调用 onOpen(taskId)，当前打开项 data-active 高亮", () => {
    const onOpen = vi.fn();
    const tasks = [task("t1"), task("t2", { status: "completed" })];
    const { rerender } = render(<BackgroundTaskTrack agentId="a1" tasks={tasks} onOpen={onOpen} activeTaskId={null} />);
    openList();
    fireEvent.click(screen.getByText("任务 t2"));
    expect(onOpen).toHaveBeenCalledWith("t2");

    rerender(<BackgroundTaskTrack agentId="a1" tasks={tasks} onOpen={onOpen} activeTaskId="t2" />);
    const rows = Array.from(document.querySelectorAll("button[data-status]"));
    expect(rows.map((row) => row.getAttribute("data-active"))).toEqual([null, "true"]);
  });

  it("点击「停止」只发停止请求，不触发选中", () => {
    const onOpen = vi.fn();
    stopBackgroundTask.mockReturnValue(new Promise(() => {}));
    render(<BackgroundTaskTrack agentId="a1" tasks={[task("t1")]} onOpen={onOpen} />);
    openList();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(stopBackgroundTask).toHaveBeenCalledWith("a1", "t1");
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("BackgroundTaskTrack 停止", () => {
  it("点击停止调用 agent.tasks.stop，按钮显示「停止中…」并禁用", async () => {
    stopBackgroundTask.mockReturnValue(new Promise(() => {}));
    render(<BackgroundTaskTrack agentId="a1" tasks={[task("t1")]} />);
    openList();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    const pending = await screen.findByRole("button", { name: "停止中…" });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
  });

  it("停止失败：在行内显示错误并恢复按钮", async () => {
    stopBackgroundTask.mockRejectedValue(new Error("会话进程未运行"));
    render(<BackgroundTaskTrack agentId="a1" tasks={[task("t1")]} />);
    openList();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect((await screen.findByRole("alert")).textContent).toBe("会话进程未运行");
    const button = screen.getByRole("button", { name: "停止" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});
