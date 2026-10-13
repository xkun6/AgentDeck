// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { Provider, createStore } from "jotai";
import type { AgentSearchHit, AgentSnapshot } from "@agentdeck/protocol";
import { stubRadixGlobals } from "@/test-utils/radix";
import { ConfirmProvider } from "@/lib/use-confirm";
import { replaceAgentSnapshotsAtom } from "@/stores/agents";
import { HistoryRoute } from "./history";

stubRadixGlobals();

const searchSessions = vi.fn<(query: string) => Promise<{ hits: AgentSearchHit[]; truncated: boolean }>>();
const actions = { updateSession: vi.fn(), deleteSession: vi.fn(), searchSessions };
vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => actions,
  humanizeSidecarError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock("@/hooks/use-agent-catalog", () => ({ useAgentProviders: () => ({ data: undefined }) }));

function agent(id: string): AgentSnapshot {
  return {
    id,
    provider: "claude",
    cwd: "C:/work/demo",
    title: `会话-${id}`,
    status: "idle",
    pendingPermissions: [],
    lastSeq: 0,
    resumable: false,
    createdAt: 1000,
    updatedAt: 2000,
  };
}

function Probe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderHistory() {
  const store = createStore();
  store.set(replaceAgentSnapshotsAtom, [agent("a"), agent("b")]);
  return render(
    <Provider store={store}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={["/history"]}>
          <Routes>
            <Route path="/history" element={<HistoryRoute />} />
            <Route path="/tasks/:id" element={<Probe />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </Provider>,
  );
}

function type(value: string) {
  fireEvent.change(screen.getByPlaceholderText(/搜索标题/), { target: { value } });
}

beforeEach(() => {
  searchSessions.mockReset();
});
afterEach(cleanup);

describe("历史页：内容匹配（design.md 4.19）", () => {
  it("输入为空不搜索；非空 300ms 防抖后只搜最后一次输入，显示高亮 snippet", async () => {
    searchSessions.mockResolvedValue({
      hits: [
        { agentId: "a", seq: 7, timestamp: 5000, role: "assistant", snippet: "前文关键词后文", matchStart: 2, matchLength: 3 },
        { agentId: "ghost", seq: 1, timestamp: 5000, role: "user", snippet: "不存在的会话", matchStart: 0, matchLength: 1 },
      ],
      truncated: false,
    });
    renderHistory();
    expect(searchSessions).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("内容匹配")).toBeNull();

    type("关");
    type("关键词");
    // 防抖窗口内不应请求
    expect(searchSessions).not.toHaveBeenCalled();
    await waitFor(() => expect(searchSessions).toHaveBeenCalledTimes(1));
    expect(searchSessions).toHaveBeenCalledWith("关键词");

    const group = await screen.findByLabelText("内容匹配");
    // 已不存在的会话（不在列表里）不显示
    expect(group.textContent).not.toContain("不存在的会话");
    const mark = group.querySelector("mark");
    expect(mark?.textContent).toBe("关键词");
    expect(group.textContent).toContain("助手");
    expect(group.textContent).toContain("会话-a");
  });

  it("点击命中跳转到 /tasks/:id?seq=<seq>", async () => {
    searchSessions.mockResolvedValue({
      hits: [{ agentId: "b", seq: 42, timestamp: 5000, role: "user", snippet: "hello", matchStart: 0, matchLength: 5 }],
      truncated: false,
    });
    renderHistory();
    type("hello");
    const group = await screen.findByLabelText("内容匹配");
    await waitFor(() => expect(group.querySelector("mark")).not.toBeNull());
    fireEvent.click(group.querySelector("button")!);
    expect((await screen.findByTestId("location")).textContent).toBe("/tasks/b?seq=42");
  });

  it("没有命中显示提示；搜索失败显示错误", async () => {
    searchSessions.mockResolvedValueOnce({ hits: [], truncated: false });
    renderHistory();
    type("zzz");
    expect(await screen.findByText("没有匹配的会话内容")).toBeTruthy();

    searchSessions.mockRejectedValueOnce(new Error("搜索炸了"));
    type("yyy");
    expect(await screen.findByText("搜索炸了")).toBeTruthy();
  });
});
