// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentBackgroundTask, AgentBackgroundTaskOutput } from "@agentdeck/protocol";
import { stubRadixGlobals } from "@/test-utils/radix";

const stopBackgroundTask = vi.fn<(agentId: string, taskId: string) => Promise<void>>();
const backgroundTaskOutput =
  vi.fn<(agentId: string, taskId: string, maxBytes?: number) => Promise<AgentBackgroundTaskOutput>>();

vi.mock("@/hooks/use-agent-session", () => {
  const actions = {
    stopBackgroundTask: (...args: [string, string]) => stopBackgroundTask(...args),
    backgroundTaskOutput: (...args: [string, string, number?]) => backgroundTaskOutput(...args),
  };
  return {
    useAgentSession: () => actions,
    humanizeSidecarError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  };
});

const { BackgroundTaskTrack } = await import("./background-task-track");

stubRadixGlobals();
beforeEach(() => {
  stopBackgroundTask.mockReset();
  backgroundTaskOutput.mockReset();
  backgroundTaskOutput.mockResolvedValue({ text: "", truncated: false, size: 0 });
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
    expect(container.firstChild).toBeNull();
  });

  it("有运行中显示「N 运行中」，全部结束显示「N 个已结束」", () => {
    const { rerender } = render(
      <BackgroundTaskTrack agentId="a1" tasks={[task("t1"), task("t2"), task("t3", { status: "completed" })]} />,
    );
    const pill = screen.getByRole("button", { name: /后台任务/ });
    expect(pill.textContent).toContain("后台任务");
    expect(pill.textContent).toContain("2 运行中");
    rerender(
      <BackgroundTaskTrack
        agentId="a1"
        tasks={[task("t1", { status: "completed" }), task("t2", { status: "failed" }), task("t3", { status: "stopped" })]}
      />,
    );
    expect(screen.getByRole("button", { name: /后台任务/ }).textContent).toContain("3 个已结束");
  });
});

describe("BackgroundTaskTrack 列表", () => {
  it("展开后每行显示描述、状态文字、耗时；子代理附 token 与工具次数；按钮按状态与输出出现", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000 + 65_000);
    render(
      <BackgroundTaskTrack
        agentId="a1"
        tasks={[
          task("c1", { hasOutput: true }),
          task("a1", {
            kind: "agent",
            description: "读文件",
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
    expect(screen.getByText("任务 c1").getAttribute("title")).toBe("任务 c1");
    const rows = Array.from(document.querySelectorAll("li"));
    expect(rows).toHaveLength(4);
    expect(rows[0]!.textContent).toContain("运行中");
    expect(rows[0]!.textContent).toContain("01:05");
    expect(rows[0]!.querySelector("[data-status='running']")).not.toBeNull();
    expect(rows[1]!.textContent).toContain("已完成");
    expect(rows[1]!.textContent).toContain("1:02:03");
    expect(rows[1]!.textContent).toContain("12.3k tokens · 5 次工具");
    expect(rows[2]!.textContent).toContain("失败");
    expect(rows[2]!.textContent).toContain("exit code 1");
    expect(rows[3]!.textContent).toContain("已停止");
    expect(rows[3]!.textContent).toContain("会话已结束");
    // 运行中且有输出：两个按钮；其余没有按钮
    expect(Array.from(rows[0]!.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["输出", "停止"]);
    expect(rows[1]!.querySelectorAll("button")).toHaveLength(0);
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

describe("BackgroundTaskTrack 停止", () => {
  it("点击停止调用 agent.tasks.stop，按钮显示「停止中…」并禁用", async () => {
    stopBackgroundTask.mockReturnValue(new Promise(() => {}));
    render(<BackgroundTaskTrack agentId="a1" tasks={[task("t1")]} />);
    openList();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(stopBackgroundTask).toHaveBeenCalledWith("a1", "t1");
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

describe("BackgroundTaskTrack 输出对话框", () => {
  it("点击「输出」打开对话框并按 64KB 拉取输出", async () => {
    backgroundTaskOutput.mockResolvedValue({ text: "构建完成\n", truncated: false, size: 12 });
    render(<BackgroundTaskTrack agentId="a1" tasks={[task("t1", { status: "completed", hasOutput: true })]} />);
    openList();
    fireEvent.click(screen.getByRole("button", { name: "输出" }));
    await waitFor(() => expect(screen.getByLabelText("命令输出").textContent).toBe("构建完成\n"));
    expect(backgroundTaskOutput).toHaveBeenCalledWith("a1", "t1", 65536);
  });
});
