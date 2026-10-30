// @vitest-environment jsdom
// 委派卡片（design.md 4.26）：目标会话标题、实时状态、跳转；结果 / 错误展开；父会话链接。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { Provider, createStore } from "jotai";
import type { AgentSnapshot } from "@agentdeck/protocol";
import { replaceAgentSnapshotsAtom } from "@/stores/agents";
import type { ChatToolItem } from "./chat-types";
import { DelegatedFromLink } from "./delegated-from";
import { DelegateCard, OpenSessionContext } from "./delegate-card";

vi.mock("@/hooks/use-agent-catalog", () => ({ useAgentProviders: () => ({ data: undefined }) }));

afterEach(cleanup);

function agent(id: string, patch: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id,
    provider: "codex",
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

function tool(delegate: ChatToolItem["delegate"], status: ChatToolItem["status"] = "done"): ChatToolItem {
  return { tool_id: "c1", name: "mcp__agentdeck__delegate", status, startedAt: 1, delegate };
}

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderWith(agents: AgentSnapshot[], node: React.ReactElement) {
  const store = createStore();
  store.set(replaceAgentSnapshotsAtom, agents);
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={["/tasks/main"]}>
        <Routes>
          <Route path="*" element={<>{node}<LocationProbe /></>} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

describe("DelegateCard", () => {
  it("显示目标会话标题与实时状态，点「查看会话」跳到该会话", () => {
    renderWith(
      [agent("child-1", { status: "running" })],
      <DelegateCard
        tool={tool({ tool: "delegate", agentId: "child-1", provider: "codex", request: "写测试", result: { status: "running" } })}
      />,
    );
    expect(screen.getByText("委派")).toBeTruthy();
    expect(screen.getByText("会话-child-1")).toBeTruthy();
    expect(screen.getByText("运行中")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /查看会话/ }));
    expect(screen.getByTestId("location").textContent).toBe("/tasks/child-1");
  });

  it("目标会话已不在列表时退回工具结果里的状态，且不提供跳转；详情展开请求与回复", () => {
    renderWith(
      [],
      <DelegateCard
        tool={tool({
          tool: "delegate",
          agentId: "gone",
          request: "把登录改成 OAuth",
          result: { status: "completed", reply: "已改完" },
        })}
      />,
    );
    expect(screen.getByText("已删除的会话")).toBeTruthy();
    expect(screen.getByText("已完成")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /查看会话/ })).toBeNull();
    expect(screen.queryByText("已改完")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    expect(screen.getByText("把登录改成 OAuth")).toBeTruthy();
    expect(screen.getByText("已改完")).toBeTruthy();
  });

  it("工具失败时显示错误文本；委派尚未返回时显示「进行中」与 provider 子会话占位标题", () => {
    renderWith(
      [],
      <DelegateCard
        tool={tool({ tool: "delegate", agentId: undefined, errorText: "委派深度已达上限（3 层）", request: "x" }, "error")}
      />,
    );
    expect(screen.getByText("子会话")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    expect(screen.getByText("委派深度已达上限（3 层）")).toBeTruthy();
    cleanup();

    renderWith([], <DelegateCard tool={tool({ tool: "delegate", provider: "claude", request: "x" }, "running")} />);
    expect(screen.getByText("进行中")).toBeTruthy();
    expect(screen.getByText(/子会话$/)).toBeTruthy();
  });

  it("send_to_agent / wait_agent 用对应动词，标题取目标会话", () => {
    renderWith(
      [agent("t1")],
      <DelegateCard tool={tool({ tool: "send_to_agent", agentId: "t1", request: "继续" })} />,
    );
    expect(screen.getByText("发送给")).toBeTruthy();
    expect(screen.getByText("会话-t1")).toBeTruthy();
    expect(screen.getByText("空闲")).toBeTruthy();
  });
});

describe("DelegatedFromLink", () => {
  it("显示「由 <父会话> 委派」，点击跳到父会话；父会话不存在时显示已删除提示", () => {
    renderWith([agent("p1", { title: "主会话" })], <DelegatedFromLink parentAgentId="p1" />);
    expect(screen.getByRole("button", { name: "主会话" })).toBeTruthy();
    expect(document.body.textContent).toContain("由主会话委派");
    fireEvent.click(screen.getByRole("button", { name: "主会话" }));
    expect(screen.getByTestId("location").textContent).toBe("/tasks/p1");
    cleanup();

    renderWith([], <DelegatedFromLink parentAgentId="gone" />);
    expect(screen.getByText("由已删除的会话委派")).toBeTruthy();
  });
});

describe("委派卡片：手机端没有 Router", () => {
  const delegate = { tool: "delegate", agentId: "child", request: "任务" } as ChatToolItem["delegate"];

  function renderCard(open: ((agentId: string) => void) | null) {
    const store = createStore();
    store.set(replaceAgentSnapshotsAtom, [agent("child")]);
    render(
      <Provider store={store}>
        <OpenSessionContext.Provider value={open}>
          <DelegateCard tool={tool(delegate)} />
        </OpenSessionContext.Provider>
      </Provider>,
    );
  }

  it("页面注入跳转时用注入的，不碰 Router", () => {
    const open = vi.fn();
    renderCard(open);
    fireEvent.click(screen.getByRole("button", { name: "查看会话" }));
    expect(open).toHaveBeenCalledWith("child");
  });

  it("既没有 Router 也没有注入：卡片照常显示，只是没有跳转按钮", () => {
    renderCard(null);
    expect(screen.getByTestId("delegate-card")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "查看会话" })).toBeNull();
  });
});
