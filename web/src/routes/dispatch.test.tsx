// @vitest-environment jsdom
// 派单页（design.md 4.26）：总览、详情与跳转。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { Provider, createStore } from "jotai";
import type { AgentSnapshot } from "@agentdeck/protocol";
import { stubRadixGlobals } from "@/test-utils/radix";
import { ConfirmProvider } from "@/lib/use-confirm";
import { agentListLoadedAtom, replaceAgentSnapshotsAtom } from "@/stores/agents";
import { DelegatedFromLink } from "@/components/chat/delegated-from";
import { DispatchDetailRoute, DispatchOverviewRoute } from "./dispatch";

stubRadixGlobals();

vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => ({
    updateSession: vi.fn(async () => ({})),
    fetchAllTimelineEntries: vi.fn(async () => []),
    forkSession: vi.fn(),
    deleteSession: vi.fn(),
  }),
  humanizeSidecarError: (error: unknown) => String(error),
  isInactiveAgent: (agent: { status?: string } | null | undefined) =>
    agent?.status === "dormant" || agent?.status === "closed",
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
    lastSeq: 1,
    resumable: false,
    createdAt: 1000,
    updatedAt: 2000,
    ...patch,
  };
}

function Location() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderAt(path: string, agents: AgentSnapshot[], loaded = true) {
  const store = createStore();
  store.set(replaceAgentSnapshotsAtom, agents);
  store.set(agentListLoadedAtom, loaded);
  return render(
    <Provider store={store}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[path]}>
          <Location />
          <Routes>
            <Route path="/dispatch" element={<DispatchOverviewRoute />} />
            <Route path="/dispatch/:agentId" element={<DispatchDetailRoute />} />
            <Route path="*" element={null} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </Provider>,
  );
}

const pathname = () => screen.getByTestId("location").textContent;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("派单总览", () => {
  it("没有派单时显示空状态", () => {
    renderAt("/dispatch", [agent("plain")]);
    expect(screen.getByText(/还没有派单/)).toBeTruthy();
    expect(screen.queryByText("会话-plain")).toBeNull();
  });

  it("列出主会话与状态汇总，有工作中或需要处理的排前面；点行进入详情", () => {
    renderAt("/dispatch", [
      agent("calm"),
      agent("calmChild", { parentAgentId: "calm", lastTurnOutcome: "completed" }),
      agent("busy"),
      agent("busyChild", { parentAgentId: "busy", status: "running" }),
    ]);
    expect(screen.getAllByText(/^会话-/).map((node) => node.textContent)).toEqual(["会话-busy", "会话-calm"]);
    expect(screen.getByText("1 运行中")).toBeTruthy();
    expect(screen.getByText("1 已完成")).toBeTruthy();
    fireEvent.click(screen.getByText("会话-busy"));
    expect(pathname()).toBe("/dispatch/busy");
  });

  it("主会话已删除的子会话单独列出，点行打开对话", () => {
    renderAt("/dispatch", [agent("orphan", { parentAgentId: "gone" })]);
    expect(screen.getByText("主会话已删除")).toBeTruthy();
    fireEvent.click(screen.getByText("会话-orphan"));
    expect(pathname()).toBe("/tasks/orphan");
  });
});

describe("派单详情", () => {
  const agents = [
    agent("master"),
    agent("c1", { parentAgentId: "master", lastTurnOutcome: "completed", model: "opus" }),
    agent("c2", { parentAgentId: "master", lastTurnOutcome: "failed" }),
    agent("nested", { parentAgentId: "c1", lastTurnOutcome: "canceled" }),
    agent("other"),
  ];

  it("显示主会话和全部子会话及各自状态，不显示无关会话", () => {
    renderAt("/dispatch/master", agents);
    expect(screen.getByRole("heading", { name: "会话-master" })).toBeTruthy();
    expect(screen.getByText("会话-c1")).toBeTruthy();
    expect(screen.getByText("会话-c2")).toBeTruthy();
    expect(screen.getByText("会话-nested")).toBeTruthy();
    expect(screen.queryByText("会话-other")).toBeNull();
    expect(screen.getByText("失败")).toBeTruthy();
    expect(screen.getByText("已中断")).toBeTruthy();
    expect(screen.getByText("1 失败 · 1 已中断 · 1 已完成")).toBeTruthy();
    expect(screen.getByText(/opus/)).toBeTruthy();
  });

  it("点子会话行打开对话，「打开对话」打开主会话，面包屑返回总览", () => {
    renderAt("/dispatch/master", agents);
    fireEvent.click(screen.getByText("会话-nested"));
    expect(pathname()).toBe("/tasks/nested");
    cleanup();
    renderAt("/dispatch/master", agents);
    fireEvent.click(screen.getByRole("button", { name: "打开对话" }));
    expect(pathname()).toBe("/tasks/master");
    cleanup();
    renderAt("/dispatch/master", agents);
    fireEvent.click(screen.getByRole("button", { name: "派单" }));
    expect(pathname()).toBe("/dispatch");
  });

  it("已归档的主会话：总览不列，详情仍能看子会话，不提示「没有派发」", () => {
    const archived = [agent("master", { archived: true }), agent("c1", { parentAgentId: "master", lastTurnOutcome: "completed" })];
    renderAt("/dispatch", archived);
    expect(screen.queryByText("会话-master")).toBeNull();
    cleanup();
    renderAt("/dispatch/master", archived);
    expect(screen.getByText("会话-c1")).toBeTruthy();
    expect(screen.getByText("已归档")).toBeTruthy();
    expect(screen.queryByText(/没有派发子会话/)).toBeNull();
  });

  it("不是主会话时提示并可返回总览；未加载完不提示", () => {
    renderAt("/dispatch/other", agents);
    expect(screen.getByText(/没有派发子会话/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "返回派单总览" }));
    expect(pathname()).toBe("/dispatch");
    cleanup();
    renderAt("/dispatch/other", [], false);
    expect(screen.queryByText(/没有派发子会话/)).toBeNull();
  });
});

describe("对话页的「派单页」入口", () => {
  function renderLink(parentAgentId: string, agents: AgentSnapshot[]) {
    const store = createStore();
    store.set(replaceAgentSnapshotsAtom, agents);
    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={["/tasks/x"]}>
          <Location />
          <DelegatedFromLink parentAgentId={parentAgentId} />
        </MemoryRouter>
      </Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "派单页" }));
  }

  it("多层派单：上一级不是主会话时进所属主会话的详情", () => {
    renderLink("c1", [
      agent("master"),
      agent("c1", { parentAgentId: "master" }),
      agent("nested", { parentAgentId: "c1" }),
    ]);
    expect(pathname()).toBe("/dispatch/master");
  });

  it("上一级已删除：进总览", () => {
    renderLink("gone", [agent("orphan", { parentAgentId: "gone" })]);
    expect(pathname()).toBe("/dispatch");
  });
});
