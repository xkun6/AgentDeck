// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ProviderSubagentDescriptor, ProviderSubagentTimelineRow } from "@agentdeck/protocol";
import { stubRadixGlobals } from "@/test-utils/radix";
import { SubagentTrack } from "./subagent-track";
import { SubagentPanel, buildSubagentRuntime } from "./subagent-panel";

const ROWS: Record<string, ProviderSubagentTimelineRow[]> = {
  s1: [
    { seq: 1, timestamp: 1, item: { type: "user_message", text: "读取 package.json 的 name" } },
    {
      seq: 2,
      timestamp: 2,
      item: {
        type: "tool_call",
        callId: "t1",
        name: "Read",
        status: "completed",
        detail: { type: "read", filePath: "package.json", content: "{}" },
      },
    },
    { seq: 3, timestamp: 3, item: { type: "assistant_message", text: "name 是 agentdeck", messageId: "m1" } },
  ],
  s2: [{ seq: 1, timestamp: 1, item: { type: "assistant_message", text: "孙代理的回复", messageId: "m2" } }],
};

const loadOlder = vi.fn(async () => undefined);

vi.mock("@/hooks/use-agent-session", () => ({
  useSubagentTimeline: (_agentId: string, subagentId: string) => ({
    rows: ROWS[subagentId] ?? [],
    hasOlder: subagentId === "s1",
    loaded: true,
    loading: false,
    error: null,
    loadOlder,
  }),
}));

function sub(id: string, extra: Partial<ProviderSubagentDescriptor> = {}): ProviderSubagentDescriptor {
  return {
    id,
    parentAgentId: "a1",
    parentSubagentId: null,
    provider: "claude",
    title: "Explore",
    description: `任务 ${id}`,
    status: "completed",
    createdAt: 1,
    updatedAt: 1,
    toolCallId: id,
    cwd: null,
    subtitle: "Explore · Haiku 4.5 · 12.3k tokens",
    ...extra,
  };
}

const SUBAGENTS = [sub("s1"), sub("s2", { parentSubagentId: "s1", title: "General", description: "孙任务" })];

beforeAll(() => {
  stubRadixGlobals();
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => undefined;
});

afterEach(() => cleanup());

describe("SubagentTrack", () => {
  it("没有当前层级的子代理时不渲染；展开后点一行回调 onOpen", () => {
    const onOpen = vi.fn();
    const { container, rerender } = render(
      <SubagentTrack subagents={[]} parentSubagentId={null} onOpen={onOpen} />,
    );
    expect(container.innerHTML).toBe("");
    rerender(
      <SubagentTrack
        subagents={[...SUBAGENTS, sub("s3", { status: "running", description: "运行中的任务" })]}
        parentSubagentId={null}
        onOpen={onOpen}
      />,
    );
    // 只算父会话层级：s1（完成）+ s3（运行中），s2 是孙代理不计
    const pill = screen.getByRole("button", { name: /^子代理/ });
    expect(pill.textContent).toContain("1 运行中");
    fireEvent.click(pill);
    const list = screen.getByRole("list", { name: "子代理列表" });
    expect(within(list).getAllByRole("button")).toHaveLength(2);
    expect(within(list).queryByText("孙任务")).toBeNull();
    fireEvent.click(within(list).getByText("运行中的任务"));
    expect(onOpen).toHaveBeenCalledWith("s3");
  });
});

describe("SubagentPanel", () => {
  it("只读渲染子代理时间线（文本与工具卡），没有输入框；可进入孙代理并返回", () => {
    render(
      <MemoryRouter>
        <SubagentPanel agentId="a1" subagents={SUBAGENTS} rootSubagentId="s1" onClose={() => undefined} />
      </MemoryRouter>,
    );
    const panel = screen.getByRole("complementary", { name: "子代理面板" });
    expect(within(panel).getByText("任务 s1")).toBeTruthy();
    expect(within(panel).getByText("Explore · Haiku 4.5 · 12.3k tokens")).toBeTruthy();
    expect(panel.textContent).toContain("name 是 agentdeck");
    expect(panel.textContent).toContain("读取 package.json 的 name");
    expect(panel.textContent).toContain("Read");
    expect(panel.querySelector("textarea")).toBeNull();
    expect(within(panel).queryByRole("button", { name: "返回上一级" })).toBeNull();
    // 紧凑密度：时间线根元素带 data-density，不渲染头像列
    expect(within(panel).getByRole("log").getAttribute("data-density")).toBe("compact");
    expect(within(panel).queryByLabelText("Explore 头像")).toBeNull();

    fireEvent.click(within(panel).getByRole("button", { name: "加载更早记录" }));
    expect(loadOlder).toHaveBeenCalled();

    // 面板底部是 s1 层级的药丸：进入孙代理 s2
    fireEvent.click(within(panel).getByRole("button", { name: /^子代理/ }));
    fireEvent.click(within(panel).getByText("孙任务"));
    expect(panel.textContent).toContain("孙代理的回复");
    expect(panel.textContent).not.toContain("name 是 agentdeck");

    fireEvent.click(within(panel).getByRole("button", { name: "返回上一级" }));
    expect(panel.textContent).toContain("name 是 agentdeck");
    expect(within(panel).queryByRole("button", { name: "返回上一级" })).toBeNull();
  });

  it("子代理运行中时「思考中」计时从 createdAt 起走；已完成时不显示计时", () => {
    vi.useFakeTimers();
    try {
      const running = [sub("s1", { status: "running", createdAt: Date.now() - 65_000 })];
      const { unmount } = render(
        <MemoryRouter>
          <SubagentPanel agentId="a1" subagents={running} rootSubagentId="s1" onClose={() => undefined} />
        </MemoryRouter>,
      );
      const timeline = screen.getByTestId("subagent-panel-timeline");
      const progress = within(timeline).getByRole("status");
      expect(progress.textContent).toContain("1:05");
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(progress.textContent).toContain("1:06");
      unmount();

      render(
        <MemoryRouter>
          <SubagentPanel agentId="a1" subagents={SUBAGENTS} rootSubagentId="s1" onClose={() => undefined} />
        </MemoryRouter>,
      );
      expect(within(screen.getByTestId("subagent-panel-timeline")).queryByRole("status")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("buildSubagentRuntime", () => {
  it("子代理结束后残留的 streaming 消息收尾为 complete；运行中保持 streaming", () => {
    const rows = ROWS.s1!;
    const settled = buildSubagentRuntime("x", rows, true);
    expect(settled.messages.every((message) => message.status === "complete")).toBe(true);
    const live = buildSubagentRuntime("x", rows, false);
    expect(live.messages.some((message) => message.status === "streaming")).toBe(true);
  });
});
