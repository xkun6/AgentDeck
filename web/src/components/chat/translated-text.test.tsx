// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const translateText = vi.fn<(direction: string, text: string) => Promise<string>>();
vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => ({ translateText }),
  humanizeSidecarError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import type { AgentPermissionRequest } from "@agentdeck/protocol";
import { ApprovalDialog } from "./approval-dialog";
import { MessageTimeline } from "./message-timeline";
import { TimelineTranslationContext } from "./translated-text";
import type { ChatMessage } from "./chat-types";

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
});

afterEach(() => {
  cleanup();
  translateText.mockReset();
  vi.unstubAllGlobals();
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

describe("只翻可见内容与提问卡（design.md 4.35）", () => {
  it("文本块进入可见区域后才请求翻译", async () => {
    const observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          observers.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    translateText.mockResolvedValue("看见了");
    renderTimeline([assistant("Seen later.", "complete", "v1")]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(translateText).not.toHaveBeenCalled();
    observers.forEach((callback) => callback([{ isIntersecting: true }]));
    expect(await screen.findByText("看见了")).toBeTruthy();
    expect(translateText).toHaveBeenCalledWith("agent-to-user", "Seen later.");
  });

  it("提问卡显示题目 / 选项译文（悬停原文），提交的 answers 仍用原文", async () => {
    translateText.mockImplementation(async (_direction, text) => `译:${text}`);
    const request: AgentPermissionRequest = {
      id: "q1",
      provider: "claude",
      name: "AskUserQuestion",
      kind: "question",
      input: { questions: [] },
      detail: {
        type: "question",
        questions: [{ question: "Which DB?", multiSelect: false, options: [{ label: "SQLite", description: "Light" }] }],
      },
    };
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(
      <TimelineTranslationContext.Provider value={ON}>
        <ApprovalDialog
          approval={{ requestId: "q1", sessionId: "agent-1", command: "", permission: request }}
          onRespond={onRespond}
        />
      </TimelineTranslationContext.Provider>,
    );
    expect(await screen.findByText("译:Which DB?")).toBeTruthy();
    expect(await screen.findByText("译:Light")).toBeTruthy();
    const label = await screen.findByText("译:SQLite");
    expect(label.getAttribute("title")).toBe("SQLite");
    fireEvent.click(label);
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    await waitFor(() =>
      expect(onRespond).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: "q1" }),
        expect.objectContaining({
          behavior: "allow",
          updatedInput: expect.objectContaining({ answers: { "Which DB?": "SQLite" } }),
        }),
      ),
    );
  });

  it("计划审批的计划正文显示译文", async () => {
    translateText.mockResolvedValue("计划译文");
    const request: AgentPermissionRequest = {
      id: "plan1",
      provider: "claude",
      name: "ExitPlanMode",
      kind: "plan",
      detail: { type: "plan", text: "1. Do it" },
    };
    render(
      <TimelineTranslationContext.Provider value={ON}>
        <ApprovalDialog approval={{ requestId: "plan1", sessionId: "agent-1", command: "", permission: request }} onRespond={vi.fn()} />
      </TimelineTranslationContext.Provider>,
    );
    expect(await screen.findByText("计划译文")).toBeTruthy();
    expect(screen.getByText("显示原文")).toBeTruthy();
  });
});
