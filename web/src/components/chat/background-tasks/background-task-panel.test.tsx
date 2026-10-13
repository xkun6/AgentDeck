// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentBackgroundTask, AgentBackgroundTaskOutput } from "@agentdeck/protocol";
import { stubRadixGlobals } from "@/test-utils/radix";

const backgroundTaskOutput =
  vi.fn<(agentId: string, taskId: string, maxBytes?: number) => Promise<AgentBackgroundTaskOutput>>();
const stopBackgroundTask = vi.fn<(agentId: string, taskId: string) => Promise<void>>();

vi.mock("@/hooks/use-agent-session", () => {
  const actions = {
    backgroundTaskOutput: (...args: [string, string, number?]) => backgroundTaskOutput(...args),
    stopBackgroundTask: (...args: [string, string]) => stopBackgroundTask(...args),
  };
  return {
    useAgentSession: () => actions,
    humanizeSidecarError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  };
});

const { BackgroundTaskPanel, OUTPUT_POLL_INTERVAL_MS } = await import("./background-task-panel");

stubRadixGlobals();
beforeEach(() => {
  vi.useFakeTimers();
  backgroundTaskOutput.mockReset();
  stopBackgroundTask.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function task(patch: Partial<AgentBackgroundTask> = {}): AgentBackgroundTask {
  return { taskId: "t1", kind: "command", description: "pnpm build", status: "running", startedAt: 1, hasOutput: true, ...patch };
}

function output(text: string, truncated = false): AgentBackgroundTaskOutput {
  return { text, truncated, size: text.length };
}

/** 让挂起的 Promise 回调与 React 状态更新落地 */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function bodyText(): string {
  return screen.getByLabelText("命令输出").textContent ?? "";
}

describe("BackgroundTaskPanel", () => {
  it("标题、状态 / 耗时 / 退出码与完整命令（长命令保留全文）", async () => {
    backgroundTaskOutput.mockResolvedValue(output("ok"));
    const command = "cd J:/proj && pnpm release --target x86_64-pc-windows-msvc --verbose --long-argument-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    render(
      <BackgroundTaskPanel
        agentId="a1"
        task={task({ description: "跑 release 构建", command, status: "failed", endedAt: 66_000, startedAt: 1_000, exitCode: 2 })}
        onClose={() => {}}
      />,
    );
    await flush();
    expect(screen.getByText("跑 release 构建")).toBeTruthy();
    const meta = screen.getByTestId("background-task-meta").textContent ?? "";
    expect(meta).toContain("失败");
    expect(meta).toContain("01:05");
    expect(meta).toContain("退出码 2");
    expect(screen.getByLabelText("执行的命令").textContent).toContain(command);
    // 已结束：没有「停止」按钮
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
  });

  it("没有 command 时不渲染命令区；运行中「停止」调用 agent.tasks.stop，关闭按钮触发 onClose", async () => {
    backgroundTaskOutput.mockResolvedValue(output(""));
    stopBackgroundTask.mockReturnValue(new Promise(() => {}));
    const onClose = vi.fn();
    render(<BackgroundTaskPanel agentId="a1" task={task()} onClose={onClose} />);
    await flush();
    expect(screen.queryByLabelText("执行的命令")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(stopBackgroundTask).toHaveBeenCalledWith("a1", "t1");
    expect(screen.getByRole("button", { name: "停止中…" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭后台任务面板" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("task 为 null 时不渲染", () => {
    const { container } = render(<BackgroundTaskPanel agentId="a1" task={null} onClose={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("打开即拉取；运行中每 2 秒轮询刷新", async () => {
    backgroundTaskOutput.mockResolvedValueOnce(output("第一行\n")).mockResolvedValueOnce(output("第一行\n第二行\n"));
    render(<BackgroundTaskPanel agentId="a1" task={task()} onClose={() => {}} />);
    await flush();
    expect(backgroundTaskOutput).toHaveBeenCalledTimes(1);
    expect(backgroundTaskOutput).toHaveBeenCalledWith("a1", "t1", 65536);
    expect(bodyText()).toBe("第一行\n");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(OUTPUT_POLL_INTERVAL_MS);
    });
    expect(backgroundTaskOutput).toHaveBeenCalledTimes(2);
    expect(bodyText()).toBe("第一行\n第二行\n");
  });

  it("任务结束后再拉一次最终输出，随后停止轮询", async () => {
    backgroundTaskOutput.mockResolvedValue(output("done\n"));
    const { rerender } = render(<BackgroundTaskPanel agentId="a1" task={task()} onClose={() => {}} />);
    await flush();
    expect(backgroundTaskOutput).toHaveBeenCalledTimes(1);

    rerender(
      <BackgroundTaskPanel agentId="a1" task={task({ status: "completed", endedAt: 9 })} onClose={() => {}} />,
    );
    await flush();
    expect(backgroundTaskOutput).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(OUTPUT_POLL_INTERVAL_MS * 3);
    });
    expect(backgroundTaskOutput).toHaveBeenCalledTimes(2);
  });

  it("已结束的任务只拉一次，不轮询", async () => {
    backgroundTaskOutput.mockResolvedValue(output("x"));
    render(
      <BackgroundTaskPanel agentId="a1" task={task({ status: "failed", endedAt: 9 })} onClose={() => {}} />,
    );
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OUTPUT_POLL_INTERVAL_MS * 3);
    });
    expect(backgroundTaskOutput).toHaveBeenCalledTimes(1);
  });

  it("truncated 时提示「已截断，仅显示最后 64 KB」", async () => {
    backgroundTaskOutput.mockResolvedValue(output("tail\n", true));
    render(<BackgroundTaskPanel agentId="a1" task={task({ status: "completed" })} onClose={() => {}} />);
    await flush();
    expect(screen.getByText("已截断，仅显示最后 64 KB")).toBeTruthy();
  });

  it("没有输出显示占位；「刷新」按钮重新拉取；失败显示错误", async () => {
    backgroundTaskOutput.mockResolvedValueOnce(output("")).mockRejectedValueOnce(new Error("会话进程未运行"));
    render(<BackgroundTaskPanel agentId="a1" task={task({ status: "completed" })} onClose={() => {}} />);
    await flush();
    expect(bodyText()).toBe("（暂无输出）");
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await flush();
    expect(backgroundTaskOutput).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert").textContent).toBe("会话进程未运行");
  });

  it("用户上滚后不再自动滚到底；回到底部后恢复", async () => {
    backgroundTaskOutput.mockResolvedValue(output("a\n"));
    render(<BackgroundTaskPanel agentId="a1" task={task()} onClose={() => {}} />);
    await flush();
    const body = screen.getByLabelText("命令输出");
    let scrollHeight = 500;
    Object.defineProperty(body, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(body, "clientHeight", { configurable: true, get: () => 100 });

    // 初始在底部：新输出到达后保持在底部
    backgroundTaskOutput.mockResolvedValue(output("a\nb\n"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OUTPUT_POLL_INTERVAL_MS);
    });
    expect(body.scrollTop).toBe(500);

    // 用户上滚：新输出不再把滚动位置拉回底部
    body.scrollTop = 50;
    fireEvent.scroll(body);
    scrollHeight = 800;
    backgroundTaskOutput.mockResolvedValue(output("a\nb\nc\n"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OUTPUT_POLL_INTERVAL_MS);
    });
    expect(body.scrollTop).toBe(50);

    // 回到底部后恢复跟随
    body.scrollTop = 700;
    fireEvent.scroll(body);
    scrollHeight = 900;
    backgroundTaskOutput.mockResolvedValue(output("a\nb\nc\nd\n"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OUTPUT_POLL_INTERVAL_MS);
    });
    expect(body.scrollTop).toBe(900);
  });
});
