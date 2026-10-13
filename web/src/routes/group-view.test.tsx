// @vitest-environment jsdom
// 协作视图（design.md 4.27）：成员列、状态、查看 diff、汇总结果、删除协作组。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { Provider as JotaiProvider, createStore } from "jotai";
import type { AgentGroup, AgentSnapshot, AgentUIMessage } from "@agentdeck/protocol";
import { agentSnapshotsAtom, sidecarConnectionAtom } from "@/stores/agents";
import { chatRuntimeBySessionAtom, createEmptyChatRuntime } from "@/stores/chat";
import { replaceGroupsAtom } from "@/stores/groups";
import { ConfirmProvider } from "@/lib/use-confirm";

const actions = {
  loadTimeline: vi.fn(async (_agentId: string) => {}),
  deleteGroup: vi.fn(async (_id: string, _removeWorktrees: boolean) => [] as string[]),
};
vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => actions,
  humanizeSidecarError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock("@/hooks/use-agent-catalog", () => ({
  useAgentProviders: () => ({
    data: [
      { id: "claude", kind: "claude", label: "Claude Code", available: true },
      { id: "codex", kind: "codex", label: "Codex", available: true },
    ],
  }),
}));
vi.mock("@/components/chat/message-timeline", () => ({
  MessageTimeline: ({ messages }: { messages: Array<{ id: string }> }) => (
    <div data-testid="timeline">{messages.length} 条消息</div>
  ),
}));
vi.mock("@/components/chat/message-text", () => ({
  MessageText: ({ text }: { text: string }) => <div data-testid="chair-text">{text}</div>,
}));
vi.mock("@/components/chat/preview-rail/review-tab", () => ({
  ReviewTab: ({ workspaceRoot }: { workspaceRoot: string }) => <div data-testid="review">{workspaceRoot}</div>,
}));

import { GroupViewRoute } from "./group-view";

afterEach(() => {
  cleanup();
  actions.loadTimeline.mockClear();
  actions.deleteGroup.mockClear();
});

function agent(id: string, patch: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id, provider: "claude", cwd: "/work", status: "idle", pendingPermissions: [], lastSeq: 0,
    resumable: true, createdAt: 1, updatedAt: 1, ...patch,
  };
}

function assistantMessage(text: string): AgentUIMessage {
  return {
    id: `m-${text}`, sessionId: "chair", role: "assistant", createdAt: 1, status: "complete",
    parts: [{ type: "text", text }],
  };
}

function makeGroup(patch: Partial<AgentGroup> = {}): AgentGroup {
  return {
    id: "g1",
    title: "排序对比",
    prompt: "实现一个排序函数",
    cwd: "/work",
    createdAt: 1,
    members: [
      { agentId: "m1", provider: "claude", model: "opus", worktree: { path: "/wt/1", branch: "agentdeck/g1/1" } },
      { agentId: "m2", provider: "codex", worktree: { path: "/wt/2", branch: "agentdeck/g1/2" } },
    ],
    status: "running",
    ...patch,
  };
}

function LocationProbe() {
  return <div data-testid="path">{useLocation().pathname}</div>;
}

function renderPage(group: AgentGroup | null, options: { chairMessages?: AgentUIMessage[] } = {}) {
  const store = createStore();
  store.set(sidecarConnectionAtom, "open");
  store.set(agentSnapshotsAtom, {
    m1: agent("m1", { status: "running" }),
    m2: agent("m2", { provider: "codex" }),
    chair: agent("chair"),
  });
  store.set(replaceGroupsAtom, group ? [group] : []);
  if (options.chairMessages) {
    store.set(chatRuntimeBySessionAtom, {
      chair: { ...createEmptyChatRuntime(), messages: options.chairMessages },
    });
  }
  render(
    <JotaiProvider store={store}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={["/groups/g1"]}>
          <Routes>
            <Route path="/groups/:groupId" element={<GroupViewRoute />} />
            <Route path="*" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </JotaiProvider>,
  );
  return store;
}

describe("GroupViewRoute", () => {
  it("顶部显示标题 / 状态 / 任务；每个成员一列，显示 Agent 名、模型、状态与分支", async () => {
    renderPage(makeGroup());
    expect(screen.getByRole("heading", { name: "排序对比" })).toBeTruthy();
    expect(screen.getByText("成员执行中")).toBeTruthy();
    expect(screen.getByText("实现一个排序函数")).toBeTruthy();
    const col1 = screen.getByRole("region", { name: "成员 1：Claude Code" });
    expect(col1.textContent).toContain("opus");
    expect(col1.textContent).toContain("运行中");
    expect(col1.textContent).toContain("agentdeck/g1/1");
    const col2 = screen.getByRole("region", { name: "成员 2：Codex" });
    expect(col2.textContent).toContain("空闲");
    await waitFor(() => expect(actions.loadTimeline).toHaveBeenCalledWith("m1"));
    expect(actions.loadTimeline).toHaveBeenCalledWith("m2");
    expect(screen.getAllByTestId("timeline")).toHaveLength(2);
  });

  it("per-member 列「查看 diff」切到审阅面板（cwd 指向成员 worktree），再点返回时间线；非 worktree 成员没有该按钮", () => {
    renderPage(makeGroup());
    fireEvent.click(within1("成员 1：Claude Code", "查看 diff"));
    expect(screen.getByTestId("review").textContent).toBe("/wt/1");
    expect(screen.getAllByTestId("timeline")).toHaveLength(1);
    fireEvent.click(within1("成员 1：Claude Code", "返回时间线"));
    expect(screen.queryByTestId("review")).toBeNull();
    cleanup();

    renderPage(makeGroup({ members: [{ agentId: "m1", provider: "claude" }, { agentId: "m2", provider: "codex" }] }));
    expect(screen.queryByRole("button", { name: /查看 diff/ })).toBeNull();
  });

  it("进入会话跳转到完整会话页", () => {
    renderPage(makeGroup());
    fireEvent.click(within1("成员 2：Codex", "进入会话"));
    expect(screen.getByTestId("path").textContent).toBe("/tasks/m2");
  });

  it("汇总结果区：显示 chair 会话最后一条助手消息与「进入会话」；未建出时提示等待", () => {
    renderPage(makeGroup({ status: "done", chair: { provider: "claude", mode: "review", agentId: "chair" } }), {
      chairMessages: [assistantMessage("方案 A 最优")],
    });
    const region = screen.getByRole("region", { name: "汇总结果" });
    expect(region.textContent).toContain("评审");
    expect(screen.getByTestId("chair-text").textContent).toBe("方案 A 最优");
    expect(region.querySelector("button")?.textContent).toContain("进入会话");
    cleanup();

    renderPage(makeGroup({ chair: { provider: "claude", mode: "synthesize" } }));
    expect(screen.getByText("等待全部成员完成后开始汇总…")).toBeTruthy();
  });

  it("没有 chair 配置时不显示汇总区", () => {
    renderPage(makeGroup());
    expect(screen.queryByRole("region", { name: "汇总结果" })).toBeNull();
  });

  it("删除协作组：先确认，再询问是否同时删除 worktree，调用 group.delete 后回首页", async () => {
    renderPage(makeGroup());
    fireEvent.click(screen.getByRole("button", { name: /删除协作组/ }));
    fireEvent.click((await screen.findAllByRole("button", { name: "删除协作组" })).at(-1)!);
    fireEvent.click(await screen.findByRole("button", { name: "同时删除" }));
    await waitFor(() => expect(actions.deleteGroup).toHaveBeenCalledWith("g1", true));
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/"));
  });

  it("删除时选择保留 worktree", async () => {
    renderPage(makeGroup());
    fireEvent.click(screen.getByRole("button", { name: /删除协作组/ }));
    fireEvent.click((await screen.findAllByRole("button", { name: "删除协作组" })).at(-1)!);
    fireEvent.click(await screen.findByRole("button", { name: "保留 worktree" }));
    await waitFor(() => expect(actions.deleteGroup).toHaveBeenCalledWith("g1", false));
  });

  it("协作组不存在时提示", () => {
    renderPage(null);
    expect(screen.getByText("协作组不存在或已被删除。")).toBeTruthy();
  });
});

function within1(regionName: string, buttonName: string): HTMLElement {
  const region = screen.getByRole("region", { name: regionName });
  const button = Array.from(region.querySelectorAll("button")).find((item) => item.textContent?.includes(buttonName));
  if (!button) throw new Error(`找不到按钮：${buttonName}`);
  return button;
}
