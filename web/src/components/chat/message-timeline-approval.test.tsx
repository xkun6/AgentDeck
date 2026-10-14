// @vitest-environment jsdom
// 等待审批时进度块显示「等待审批」而不是「思考中」，并且等待时间不计入耗时（计时冻结，批准后继续）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { MessageTimeline } from "./message-timeline";
import type { ChatMessage } from "./chat-types";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const messages: ChatMessage[] = [
  { id: "u1", role: "user", createdAt: 1, text: "跑个命令" },
  { id: "a1", role: "assistant", createdAt: 2, status: "streaming", blocks: [{ type: "progress", text: "" }] },
];

function view(waiting: boolean) {
  return (
    <MemoryRouter>
      <MessageTimeline
        messages={messages}
        turnStartedAt={1_000_000}
        pendingApproval={waiting ? <div>审批卡片</div> : undefined}
      />
    </MemoryRouter>
  );
}

const timerText = () => screen.getByRole("status").lastElementChild?.textContent;

describe("等待审批", () => {
  it("没有待审批：显示思考中；有待审批：显示等待审批", () => {
    const { rerender } = render(view(false));
    expect(screen.getByText("思考中")).toBeTruthy();
    expect(screen.queryByText("等待审批")).toBeNull();
    rerender(view(true));
    expect(screen.getByText("等待审批")).toBeTruthy();
    expect(screen.queryByText("思考中")).toBeNull();
    rerender(view(false));
    expect(screen.getByText("思考中")).toBeTruthy();
  });

  it("等待审批期间计时冻结，批准后从冻结处继续（等待时间不计入）", () => {
    const { rerender } = render(view(false));
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    const before = timerText();
    expect(before).toBe("0:10");
    rerender(view(true));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(timerText()).toBe(before);
    rerender(view(false));
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    // 10 秒 + 5 秒 = 15 秒，而不是 75 秒
    expect(timerText()).toBe("0:15");
  });
});
