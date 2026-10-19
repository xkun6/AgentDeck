// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const translateText = vi.fn<(direction: string, text: string) => Promise<string>>();
vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => ({ translateText }),
  humanizeSidecarError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { MessageTimeline } from "./message-timeline";
import type { ChatMessage } from "./chat-types";

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
});

afterEach(() => {
  cleanup();
  translateText.mockReset();
});

const ON = { enabled: true, translateReasoning: false };

function assistant(text: string, status: ChatMessage["status"] = "complete", id = "a1"): ChatMessage {
  return { id, role: "assistant", createdAt: 1, status, blocks: [{ type: "text", text }], text };
}

function renderTimeline(messages: ChatMessage[], translation = ON) {
  return render(
    <MemoryRouter>
      <MessageTimeline messages={messages} translation={translation} />
    </MemoryRouter>,
  );
}

describe("时间线翻译显示（design.md 4.35）", () => {
  it("已完成的助手文本显示译文，可切换原文", async () => {
    translateText.mockResolvedValue("全部完成。");
    renderTimeline([assistant("All done.")]);
    expect(await screen.findByText("全部完成。")).toBeTruthy();
    expect(translateText).toHaveBeenCalledWith("agent-to-user", "All done.");
    fireEvent.click(screen.getByText("显示原文"));
    expect(await screen.findByText("All done.")).toBeTruthy();
    fireEvent.click(screen.getByText("显示译文"));
    expect(await screen.findByText("全部完成。")).toBeTruthy();
  });

  it("流式中的最后一个文本块与未开启翻译的会话不请求翻译", () => {
    renderTimeline([assistant("Working on it", "streaming", "a2")]);
    cleanup();
    renderTimeline([assistant("Not translated", "complete", "a3")], { enabled: false, translateReasoning: false });
    expect(translateText).not.toHaveBeenCalled();
  });

  it("失败时保留原文并可重试", async () => {
    translateText.mockRejectedValueOnce(new Error("HTTP 502")).mockResolvedValueOnce("第二次成功");
    renderTimeline([assistant("Retry me.", "complete", "a4")]);
    expect(await screen.findByText("翻译失败：HTTP 502")).toBeTruthy();
    expect(screen.getByText("Retry me.")).toBeTruthy();
    fireEvent.click(screen.getByText("重试"));
    expect(await screen.findByText("第二次成功")).toBeTruthy();
    expect(translateText).toHaveBeenCalledTimes(2);
  });

  it("用户消息显示原文，可展开查看发送的译文", async () => {
    renderTimeline([
      { id: "u1", role: "user", createdAt: 1, status: "complete", text: "修复登录", translatedText: "Fix login" },
    ]);
    expect(screen.queryByText("Fix login")).toBeNull();
    fireEvent.click(screen.getByText("查看发送的译文"));
    await waitFor(() => expect(screen.getByText("Fix login")).toBeTruthy());
    expect(translateText).not.toHaveBeenCalled();
  });
});
