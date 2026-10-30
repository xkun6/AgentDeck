// @vitest-environment jsdom
// 手机端与桌面的派单拆分（design.md 4.26）：会话列表、派单页、会话页入口。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Provider as JotaiProvider, createStore } from "jotai";
import type { AgentSnapshot } from "@agentdeck/protocol";
import { __resetUiStoreForTests } from "@/lib/ui-store";
import { agentListLoadedAtom, replaceAgentSnapshotsAtom } from "@/stores/agents";
import { DispatchDetail, DispatchOverview, SessionDispatchBar } from "./dispatch";
import { SessionList } from "./session-list";
import { agent } from "./test-fixtures";

vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => stableActions,
  humanizeSidecarError: (error: unknown) => String(error),
  isInactiveAgent: (entry: { status?: string } | null | undefined) =>
    entry?.status === "dormant" || entry?.status === "closed",
}));
vi.mock("@/hooks/use-agent-catalog", () => ({ useAgentProviders: () => ({ data: undefined }) }));

const stableActions = { listSessions: vi.fn(async () => []) };

function named(id: string, patch: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return agent(id, { title: `会话-${id}`, ...patch });
}

function wrap(node: React.ReactNode, agents: AgentSnapshot[]) {
  const store = createStore();
  store.set(replaceAgentSnapshotsAtom, agents);
  store.set(agentListLoadedAtom, true);
  return { store, ...render(<JotaiProvider store={store}>{node}</JotaiProvider>) };
}

const FIXTURE = [
  named("master"),
  named("plain"),
  named("c1", { parentAgentId: "master", origin: "delegate", lastTurnOutcome: "completed" }),
  named("c2", { parentAgentId: "master", origin: "delegate", lastTurnOutcome: "failed" }),
  named("nested", { parentAgentId: "c1", origin: "delegate", lastTurnOutcome: "completed" }),
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("手机会话列表", () => {
  it("不显示子会话；主会话带进度入口，点入口进派单详情、点行进会话", () => {
    const onOpen = vi.fn();
    const onOpenDispatch = vi.fn();
    wrap(<SessionList onOpen={onOpen} onOpenDispatch={onOpenDispatch} />, FIXTURE);
    expect(screen.getAllByText(/^会话-/).map((node) => node.textContent)).toEqual(["会话-master", "会话-plain"]);

    fireEvent.click(screen.getByRole("button", { name: "查看派单进度：会话-master" }));
    expect(onOpenDispatch).toHaveBeenCalledWith("master");
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("会话-master"));
    expect(onOpen).toHaveBeenCalledWith("master");
    expect(screen.queryByRole("button", { name: "查看派单进度：会话-plain" })).toBeNull();
  });

  it("「显示已归档」兜底：已归档的子会话和已归档主会话名下的子会话可以进入，并标注主会话", () => {
    wrap(
      <SessionList onOpen={vi.fn()} onOpenDispatch={vi.fn()} />,
      [
        named("master"),
        named("old", { parentAgentId: "master", archived: true }),
        named("gone", { archived: true }),
        named("left", { parentAgentId: "gone" }),
      ],
    );
    expect(screen.queryByText("会话-old")).toBeNull();
    expect(screen.queryByText("会话-left")).toBeNull();
    fireEvent.click(screen.getByLabelText("显示已归档（3）"));
    expect(screen.getByText("会话-old")).toBeTruthy();
    expect(screen.getByText("会话-left")).toBeTruthy();
    expect(screen.getByText("主会话 会话-master")).toBeTruthy();
    expect(screen.getByText("主会话 会话-gone")).toBeTruthy();
  });

  it("多层子会话标注真正的主会话，不是上一级", () => {
    wrap(
      <SessionList onOpen={vi.fn()} onOpenDispatch={vi.fn()} />,
      [
        named("master", { archived: true }),
        named("mid", { parentAgentId: "master" }),
        named("leaf", { parentAgentId: "mid" }),
      ],
    );
    fireEvent.click(screen.getByLabelText("显示已归档（3）"));
    expect(screen.getAllByText("主会话 会话-master")).toHaveLength(2);
    expect(screen.queryByText("主会话 会话-mid")).toBeNull();
  });
});

describe("手机会话列表按项目分组", () => {
  const projects = () =>
    screen.getAllByRole("button", { expanded: true }).map((head) => head.textContent);

  it("按工作目录分组，折叠后隐藏该组会话，重新进入页面仍保持折叠", () => {
    __resetUiStoreForTests();
    const agents = [
      named("a", { cwd: "J:/Program/Alpha" }),
      named("b", { cwd: "J:/Program/Beta" }),
      named("a2", { cwd: "j:\\program\\alpha" }),
    ];
    wrap(<SessionList onOpen={() => {}} />, agents);
    expect(projects()).toEqual(["Alpha2", "Beta1"]);

    fireEvent.click(screen.getByRole("button", { name: /^Alpha/ }));
    expect(screen.queryByText("会话-a")).toBeNull();
    expect(screen.getByText("会话-b")).toBeTruthy();

    cleanup();
    wrap(<SessionList onOpen={() => {}} />, agents);
    expect(screen.queryByText("会话-a")).toBeNull();
    expect(screen.getByRole("button", { name: /^Alpha/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("每组默认显示最近 5 个，运行中的不受限制，可展开其余", () => {
    __resetUiStoreForTests();
    const agents = Array.from({ length: 8 }, (_, index) =>
      named(`n${index}`, index === 7 ? { status: "running" } : {}),
    );
    wrap(<SessionList onOpen={() => {}} />, agents);
    expect(screen.getByText("会话-n4")).toBeTruthy();
    expect(screen.queryByText("会话-n5")).toBeNull();
    expect(screen.getByText("会话-n7")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "显示其余 2 个会话" }));
    expect(screen.getByText("会话-n5")).toBeTruthy();
    expect(screen.getByText("会话-n6")).toBeTruthy();
  });

  it("只有全部会话时不显示筛选；可按进行中筛选且不受每组行数限制，筛选项清空后回到全部", () => {
    __resetUiStoreForTests();
    const idle = Array.from({ length: 6 }, (_, index) => named(`i${index}`));
    const view = wrap(<SessionList onOpen={() => {}} />, idle);
    expect(screen.queryByRole("group", { name: "按状态筛选" })).toBeNull();
    view.unmount();

    const running = Array.from({ length: 6 }, (_, index) => named(`r${index}`, { status: "running" }));
    const { store } = wrap(<SessionList onOpen={() => {}} />, [...running, named("idle")]);
    const filter = () => screen.getByRole("button", { name: /^进行中/ });
    fireEvent.click(filter());
    expect(filter().getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("会话-idle")).toBeNull();
    expect(screen.getByText("会话-r5")).toBeTruthy();

    act(() => {
      store.set(replaceAgentSnapshotsAtom, [named("idle")]);
    });
    expect(screen.queryByRole("group", { name: "按状态筛选" })).toBeNull();
    expect(screen.getByText("会话-idle")).toBeTruthy();
  });

  it("主会话自身空闲但子会话在工作时显示「等待子任务」，项目头计入进行中", () => {
    __resetUiStoreForTests();
    wrap(<SessionList onOpen={() => {}} />, [
      named("master"),
      named("c1", { parentAgentId: "master", origin: "delegate", status: "running" }),
    ]);
    expect(screen.getByText("等待子任务")).toBeTruthy();
    expect(screen.getByText("1 进行中")).toBeTruthy();
  });
});

describe("手机派单总览", () => {
  it("列出主会话与汇总，有工作中或需要处理的排前面；主会话已删除的单独列出", () => {
    const onOpenDetail = vi.fn();
    const onOpenSession = vi.fn();
    wrap(
      <DispatchOverview onOpenDetail={onOpenDetail} onOpenSession={onOpenSession} />,
      [
        named("calm"),
        named("calmChild", { parentAgentId: "calm", lastTurnOutcome: "completed" }),
        named("busy"),
        named("busyChild", { parentAgentId: "busy", status: "running" }),
        named("orphan", { parentAgentId: "missing", lastTurnOutcome: "completed" }),
      ],
    );
    const list = screen.getByRole("list", { name: "主会话列表" });
    expect(within(list).getAllByText(/^会话-/).map((node) => node.textContent)).toEqual([
      "会话-busy",
      "会话-calm",
      "会话-orphan",
    ]);
    expect(screen.getByText("1 运行中")).toBeTruthy();
    expect(screen.getByText("主会话已删除")).toBeTruthy();
    fireEvent.click(screen.getByText("会话-busy"));
    expect(onOpenDetail).toHaveBeenCalledWith("busy");
    fireEvent.click(screen.getByText("会话-orphan"));
    expect(onOpenSession).toHaveBeenCalledWith("orphan");
  });

  it("没有派单时显示空状态", () => {
    wrap(<DispatchOverview onOpenDetail={vi.fn()} onOpenSession={vi.fn()} />, [named("plain")]);
    expect(screen.getByText(/还没有派单/)).toBeTruthy();
  });
});

describe("手机派单详情", () => {
  it("显示主会话和全部子会话及状态，点行打开会话", () => {
    const onOpenSession = vi.fn();
    wrap(<DispatchDetail agentId="master" onBack={vi.fn()} onOpenSession={onOpenSession} />, FIXTURE);
    const list = screen.getByRole("list", { name: "派单详情" });
    expect(within(list).getAllByText(/^会话-/).map((node) => node.textContent)).toEqual([
      "会话-master",
      "会话-c1",
      "会话-nested",
      "会话-c2",
    ]);
    expect(screen.getByText("失败")).toBeTruthy();
    expect(screen.getByText("1 失败 · 2 已完成")).toBeTruthy();
    fireEvent.click(screen.getByText("会话-nested"));
    expect(onOpenSession).toHaveBeenCalledWith("nested");
    fireEvent.click(within(list).getByText("会话-master"));
    expect(onOpenSession).toHaveBeenCalledWith("master");
  });

  it("不是主会话时提示", () => {
    wrap(<DispatchDetail agentId="plain" onBack={vi.fn()} onOpenSession={vi.fn()} />, FIXTURE);
    expect(screen.getByText(/没有派发子会话/)).toBeTruthy();
  });
});

describe("手机会话页入口", () => {
  function bar(id: string, agents = FIXTURE) {
    const onOpenSession = vi.fn();
    const onOpenDispatch = vi.fn();
    const target = agents.find((entry) => entry.id === id)!;
    const view = wrap(
      <SessionDispatchBar agent={target} onOpenSession={onOpenSession} onOpenDispatch={onOpenDispatch} />,
      agents,
    );
    return { onOpenSession, onOpenDispatch, view };
  }

  it("多层子会话：「由」指向上一级，「派单页」进所属主会话", () => {
    const { onOpenSession, onOpenDispatch } = bar("nested");
    fireEvent.click(screen.getByRole("button", { name: "会话-c1" }));
    expect(onOpenSession).toHaveBeenCalledWith("c1");
    fireEvent.click(screen.getByRole("button", { name: "派单页" }));
    expect(onOpenDispatch).toHaveBeenCalledWith("master");
  });

  it("已归档的子会话不在树里，「派单页」仍进所属主会话", () => {
    const agents = [named("master"), named("c", { parentAgentId: "master" }), named("old", { parentAgentId: "master", archived: true })];
    const { onOpenDispatch } = bar("old", agents);
    fireEvent.click(screen.getByRole("button", { name: "派单页" }));
    expect(onOpenDispatch).toHaveBeenCalledWith("master");
  });

  it("已归档主会话名下的子会话：「派单页」进主会话详情，详情能看到子会话", () => {
    const agents = [named("master", { archived: true }), named("c", { parentAgentId: "master", lastTurnOutcome: "completed" })];
    const { onOpenDispatch, view } = bar("c", agents);
    fireEvent.click(screen.getByRole("button", { name: "派单页" }));
    expect(onOpenDispatch).toHaveBeenCalledWith("master");
    view.unmount();
    wrap(<DispatchDetail agentId="master" onBack={vi.fn()} onOpenSession={vi.fn()} />, agents);
    expect(screen.getByText("会话-c")).toBeTruthy();
    expect(screen.queryByText(/没有派发子会话/)).toBeNull();
  });

  it("主会话已删除：提示并回到总览", () => {
    const { onOpenDispatch } = bar("orphan", [named("orphan", { parentAgentId: "missing" })]);
    expect(screen.getByText("主会话已删除")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "派单页" }));
    expect(onOpenDispatch).toHaveBeenCalledWith(null);
  });

  it("主会话显示进度，普通会话不显示", () => {
    const { onOpenDispatch, view } = bar("master");
    fireEvent.click(screen.getByRole("button", { name: "派单 2/3" }));
    expect(onOpenDispatch).toHaveBeenCalledWith("master");
    view.unmount();
    bar("plain");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
