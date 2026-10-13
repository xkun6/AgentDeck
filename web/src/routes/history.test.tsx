// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Provider, createStore } from "jotai";
import type { AgentSnapshot } from "@agentdeck/protocol";
import { stubRadixGlobals } from "@/test-utils/radix";
import { ConfirmProvider } from "@/lib/use-confirm";
import { replaceAgentSnapshotsAtom } from "@/stores/agents";
import { HistoryRoute } from "./history";

stubRadixGlobals();

const updateSession = vi.fn(async (_id: string, _patch: unknown) => ({}));
const deleteSession = vi.fn(async (_id: string) => {});
vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => ({ updateSession, deleteSession }),
  humanizeSidecarError: (error: unknown) => String(error),
}));
vi.mock("@/hooks/use-agent-catalog", () => ({ useAgentProviders: () => ({ data: undefined }) }));

function agent(id: string, patch: Partial<AgentSnapshot> = {}): AgentSnapshot {
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
    ...patch,
  };
}

function renderHistory(agents: AgentSnapshot[]) {
  const store = createStore();
  store.set(replaceAgentSnapshotsAtom, agents);
  return render(
    <Provider store={store}>
      <ConfirmProvider>
        <MemoryRouter>
          <HistoryRoute />
        </MemoryRouter>
      </ConfirmProvider>
    </Provider>,
  );
}

const AGENTS = [
  agent("a"),
  agent("b", { pinned: true }),
  agent("c", { archived: true }),
  agent("d", { status: "running" }),
];

beforeEach(() => {
  updateSession.mockClear();
  deleteSession.mockClear();
});
afterEach(cleanup);

describe("历史页：全部会话 / 已归档视图与置顶分组", () => {
  it("默认视图不含归档；置顶会话单列「置顶」分组放最前", () => {
    renderHistory(AGENTS);
    expect(screen.queryByText("会话-c")).toBeNull();
    const titles = screen.getAllByText(/^会话-/).map((node) => node.textContent);
    expect(titles[0]).toBe("会话-b");
    expect(screen.getByText("置顶")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /已归档/ }).textContent).toContain("1");
  });

  it("切到「已归档」只显示归档会话，且没有置顶分组", () => {
    renderHistory([...AGENTS, agent("e", { archived: true, pinned: true })]);
    fireEvent.click(screen.getByRole("tab", { name: /已归档/ }));
    expect(screen.getByText("会话-c")).toBeTruthy();
    expect(screen.getByText("会话-e")).toBeTruthy();
    expect(screen.queryByText("会话-a")).toBeNull();
    expect(screen.queryByText("置顶")).toBeNull();
  });
});

describe("历史页：选择模式与批量操作", () => {
  function enterSelect() {
    fireEvent.click(screen.getByRole("button", { name: "选择" }));
  }

  it("全选当前筛选结果，批量置顶逐个调用并汇总；退出选择模式清空选择", async () => {
    renderHistory(AGENTS);
    enterSelect();
    fireEvent.click(screen.getByRole("button", { name: "全选当前筛选结果" }));
    expect(screen.getByText("已选 3 个")).toBeTruthy();

    updateSession.mockImplementationOnce(async () => ({})).mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    fireEvent.click(screen.getByRole("button", { name: "置顶" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("置顶：成功 2 个，失败 1 个"));
    expect(updateSession).toHaveBeenCalledTimes(3);
    expect(updateSession.mock.calls.every(([, patch]) => (patch as { pinned?: boolean }).pinned === true)).toBe(true);
    // 失败的保持选中
    expect(screen.getByText("已选 1 个")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "退出选择" }));
    expect(screen.queryByRole("toolbar", { name: "批量操作" })).toBeNull();
    enterSelect();
    expect(screen.getByText("已选 0 个")).toBeTruthy();
  });

  it("批量归档：运行中的会话不会调用 RPC，计入失败", async () => {
    renderHistory(AGENTS);
    enterSelect();
    fireEvent.click(screen.getByRole("button", { name: "全选当前筛选结果" }));
    fireEvent.click(screen.getByRole("button", { name: "归档" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("归档：成功 2 个，失败 1 个"));
    expect(updateSession).toHaveBeenCalledTimes(2);
    expect(updateSession.mock.calls.every(([id]) => id !== "d")).toBe(true);
  });

  it("已归档视图提供「取消归档」", async () => {
    renderHistory(AGENTS);
    fireEvent.click(screen.getByRole("tab", { name: /已归档/ }));
    enterSelect();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择会话：会话-c" }));
    fireEvent.click(screen.getByRole("button", { name: "取消归档" }));
    await waitFor(() => expect(updateSession).toHaveBeenCalledWith("c", { archived: false }));
  });

  it("批量删除先弹确认（写明数量），确认后逐个 agent.delete", async () => {
    renderHistory(AGENTS);
    enterSelect();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择会话：会话-a" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择会话：会话-b" }));
    const bar = screen.getByRole("toolbar", { name: "批量操作" });
    fireEvent.click(within(bar).getByRole("button", { name: "删除" }));
    expect(deleteSession).not.toHaveBeenCalled();
    expect(await screen.findByText(/确定删除选中的 2 个会话/)).toBeTruthy();
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(deleteSession).toHaveBeenCalledTimes(2));
    expect(deleteSession.mock.calls.map(([id]) => id).sort()).toEqual(["a", "b"]);
  });
});
