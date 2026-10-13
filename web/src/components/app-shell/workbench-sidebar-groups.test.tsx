// @vitest-environment jsdom
// 侧栏协作组节点（design.md 4.27）：同组会话聚在可折叠的「协作组」下，与子会话树兼容。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { Provider, createStore } from "jotai";
import type { AgentGroup, AgentSnapshot } from "@agentdeck/protocol";
import { stubRadixGlobals } from "@/test-utils/radix";
import { ConfirmProvider } from "@/lib/use-confirm";
import { replaceAgentSnapshotsAtom } from "@/stores/agents";
import { replaceGroupsAtom } from "@/stores/groups";
import { groupSessionRoots, buildSessionTree } from "@/lib/session-list";
import { WorkbenchSidebar } from "./workbench-sidebar";

stubRadixGlobals();

vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => ({
    updateSession: vi.fn(),
    fetchAllTimelineEntries: vi.fn(async () => []),
    forkSession: vi.fn(),
    deleteSession: vi.fn(),
  }),
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

function group(patch: Partial<AgentGroup> = {}): AgentGroup {
  return {
    id: "g1",
    title: "排序对比",
    prompt: "p",
    cwd: "C:/work/demo",
    createdAt: 1,
    members: [
      { agentId: "m1", provider: "claude" },
      { agentId: "m2", provider: "codex" },
    ],
    status: "running",
    ...patch,
  };
}

function LocationProbe() {
  return <div data-testid="path">{useLocation().pathname}</div>;
}

function renderSidebar(agents: AgentSnapshot[], groups: AgentGroup[]) {
  const store = createStore();
  store.set(replaceAgentSnapshotsAtom, agents);
  store.set(replaceGroupsAtom, groups);
  return render(
    <Provider store={store}>
      <ConfirmProvider>
        <MemoryRouter>
          <WorkbenchSidebar />
          <Routes>
            <Route path="*" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </Provider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("groupSessionRoots", () => {
  it("同组的根合并成一块（位置取首个成员），未知 groupId 与无 groupId 的各自一块", () => {
    const roots = buildSessionTree([
      agent("a", { groupId: "g1" }),
      agent("solo"),
      agent("b", { groupId: "g1" }),
      agent("orphan", { groupId: "deleted" }),
    ]);
    const blocks = groupSessionRoots(roots, new Set(["g1"]));
    expect(blocks.map((block) => [block.groupId, block.roots.map((root) => root.agent.id)])).toEqual([
      ["g1", ["a", "b"]],
      [null, ["solo"]],
      [null, ["orphan"]],
    ]);
  });
});

describe("侧栏协作组节点", () => {
  const members = [
    agent("m1", { groupId: "g1", updatedAt: 4000 }),
    agent("m2", { groupId: "g1", updatedAt: 3000 }),
  ];

  it("同组会话聚在组节点下缩进显示；组节点显示标题与状态，点击进入协作视图", () => {
    renderSidebar([...members, agent("solo", { updatedAt: 1000 })], [group({ status: "done" })]);
    expect(screen.getByText("排序对比")).toBeTruthy();
    expect(screen.getByText(/协作组 · 已完成 · 2 个会话/)).toBeTruthy();
    expect(screen.getByText("会话-m1").closest("[data-depth]")?.getAttribute("data-depth")).toBe("1");
    expect(screen.getByText("会话-solo").closest("[data-depth]")).toBeNull();
    // 组节点在其成员之前
    const labels = screen.getAllByText(/^(会话-|排序对比)/).map((node) => node.textContent);
    expect(labels).toEqual(["排序对比", "会话-m1", "会话-m2", "会话-solo"]);

    fireEvent.click(screen.getByText("排序对比"));
    expect(screen.getByTestId("path").textContent).toBe("/groups/g1");
  });

  it("组节点可折叠 / 展开", () => {
    renderSidebar(members, [group({ status: "done" })]);
    fireEvent.click(screen.getByRole("button", { name: "折叠协作组：排序对比" }));
    expect(screen.queryByText("会话-m1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开协作组：排序对比" }));
    expect(screen.getByText("会话-m1")).toBeTruthy();
  });

  it("组内任一会话在运行时整组进入进行中；子会话随其父成员一起进组", () => {
    renderSidebar(
      [
        agent("m1", { groupId: "g1", status: "running", updatedAt: 5000 }),
        agent("m2", { groupId: "g1", updatedAt: 4000 }),
        agent("sub", { parentAgentId: "m2", updatedAt: 3000 }),
        agent("solo", { updatedAt: 1000 }),
      ],
      [group()],
    );
    const labels = screen.getAllByText(/^(会话-|排序对比)/).map((node) => node.textContent);
    // 进行中：组节点 + m1 + m2 + sub（sub 在 m2 下，深度 2）；最近：solo
    expect(labels).toEqual(["排序对比", "会话-m1", "会话-m2", "会话-sub", "会话-solo"]);
    expect(screen.getByText("会话-sub").closest("[data-depth]")?.getAttribute("data-depth")).toBe("2");
  });

  it("协作组已不存在时，会话按普通会话显示", () => {
    renderSidebar(members, []);
    expect(screen.queryByText("排序对比")).toBeNull();
    expect(screen.getByText("会话-m1").closest("[data-depth]")).toBeNull();
  });
});
