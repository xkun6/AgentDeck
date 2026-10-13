// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentBackgroundTask, AgentBackgroundTaskOutput } from "@agentdeck/protocol";
import { stubRadixGlobals } from "@/test-utils/radix";

const backgroundTaskOutput =
  vi.fn<(agentId: string, taskId: string, maxBytes?: number) => Promise<AgentBackgroundTaskOutput>>();

vi.mock("@/hooks/use-agent-session", () => {
  const actions = { backgroundTaskOutput: (...args: [string, string, number?]) => backgroundTaskOutput(...args) };
  return {
    useAgentSession: () => actions,
    humanizeSidecarError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  };
});

const { BackgroundTaskOutputDialog, OUTPUT_POLL_INTERVAL_MS } = await import("./background-task-output-dialog");

stubRadixGlobals();
beforeEach(() => {
  vi.useFakeTimers();
  backgroundTaskOutput.mockReset();
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

describe("BackgroundTaskOutputDialog", () => {
  it("打开即拉取；运行中每 2 秒轮询刷新", async () => {
    backgroundTaskOutput.mockResolvedValueOnce(output("第一行\n")).mockResolvedValueOnce(output("第一行\n第二行\n"));
    render(<BackgroundTaskOutputDialog open agentId="a1" task={task()} onClose={() => {}} />);
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
    const { rerender } = render(<BackgroundTaskOutputDialog open agentId="a1" task={task()} onClose={() => {}} />);
    await flush();
    expect(backgroundTaskOutput).toHaveBeenCalledTimes(1);

    rerender(
      <BackgroundTaskOutputDialog open agentId="a1" task={task({ status: "completed", endedAt: 9 })} onClose={() => {}} />,
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
      <BackgroundTaskOutputDialog open agentId="a1" task={task({ status: "failed", endedAt: 9 })} onClose={() => {}} />,
    );
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OUTPUT_POLL_INTERVAL_MS * 3);
    });
    expect(backgroundTaskOutput).toHaveBeenCalledTimes(1);
  });

  it("truncated 时提示「已截断，仅显示最后 64 KB」", async () => {
    backgroundTaskOutput.mockResolvedValue(output("tail\n", true));
    render(<BackgroundTaskOutputDialog open agentId="a1" task={task({ status: "completed" })} onClose={() => {}} />);
    await flush();
    expect(screen.getByText("已截断，仅显示最后 64 KB")).toBeTruthy();
  });

  it("没有输出显示占位；「刷新」按钮重新拉取；失败显示错误", async () => {
    backgroundTaskOutput.mockResolvedValueOnce(output("")).mockRejectedValueOnce(new Error("会话进程未运行"));
    render(<BackgroundTaskOutputDialog open agentId="a1" task={task({ status: "completed" })} onClose={() => {}} />);
    await flush();
    expect(bodyText()).toBe("（暂无输出）");
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await flush();
    expect(backgroundTaskOutput).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert").textContent).toBe("会话进程未运行");
  });

  it("用户上滚后不再自动滚到底；回到底部后恢复", async () => {
    backgroundTaskOutput.mockResolvedValue(output("a\n"));
    render(<BackgroundTaskOutputDialog open agentId="a1" task={task()} onClose={() => {}} />);
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
