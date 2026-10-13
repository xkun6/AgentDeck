// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { MessageTimeline } from "./message-timeline";
import type { ChatMessage } from "./chat-types";

const scrollTo = vi.fn();

beforeEach(() => {
  scrollTo.mockClear();
  Element.prototype.scrollTo = scrollTo as unknown as typeof Element.prototype.scrollTo;
});
afterEach(cleanup);

const messages: ChatMessage[] = [
  { id: "u1", role: "user", createdAt: 1, text: "第一问", firstSeq: 1 },
  { id: "a1", role: "assistant", createdAt: 2, text: "第一答", firstSeq: 2 },
  { id: "u2", role: "user", createdAt: 3, text: "第二问", firstSeq: 10 },
  { id: "a2", role: "assistant", createdAt: 4, text: "第二答", firstSeq: 11 },
];

function renderTimeline(focusSeq?: number | null) {
  return render(
    <MemoryRouter>
      <MessageTimeline messages={messages} focusSeq={focusSeq ?? null} />
    </MemoryRouter>,
  );
}

function focused(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-focus="true"]')).map((node) => node.textContent ?? "");
}

describe("MessageTimeline：按 seq 定位（design.md 4.19）", () => {
  it("滚动到包含该 seq 的消息并高亮，超时后取消高亮", () => {
    vi.useFakeTimers();
    try {
      const { container } = renderTimeline(5);
      // seq 5 落在首个 seq 为 2 的助手消息里
      expect(focused(container)).toHaveLength(1);
      expect(focused(container)[0]).toContain("第一答");
      expect(scrollTo).toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(2100);
      });
      expect(focused(container)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("没有 focusSeq 或找不到对应消息时不高亮", () => {
    const none = renderTimeline(null);
    expect(focused(none.container)).toHaveLength(0);
    cleanup();
    const early = render(
      <MemoryRouter>
        <MessageTimeline messages={[{ id: "x", role: "user", createdAt: 1, text: "后面的消息", firstSeq: 50 }]} focusSeq={3} />
      </MemoryRouter>,
    );
    expect(focused(early.container)).toHaveLength(0);
  });
});
