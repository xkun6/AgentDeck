// @vitest-environment jsdom
// 工作空间页与项目详情页不列出、不统计派单出去的子会话（design.md 4.26）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Provider, createStore } from "jotai";
import type { AgentSnapshot } from "@agentdeck/protocol";
import { stubRadixGlobals } from "@/test-utils/radix";
import { ConfirmProvider } from "@/lib/use-confirm";
import { __resetUiStoreForTests } from "@/lib/ui-store";
import { rememberWorkspaceProject } from "@/lib/workspaces";
import { agentListLoadedAtom, replaceAgentSnapshotsAtom } from "@/stores/agents";
import { ProjectDetailRoute } from "./project-detail";

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

const CWD = "C:/work/demo";

function agent(id: string, patch: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id,
    provider: "claude",
    cwd: CWD,
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

beforeEach(() => {
  __resetUiStoreForTests();
  rememberWorkspaceProject(CWD);
});

afterEach(() => {
  cleanup();
});

describe("项目详情页", () => {
  it("只列出主会话与普通会话，cwd 相同的子会话不出现", () => {
    const store = createStore();
    store.set(replaceAgentSnapshotsAtom, [
      agent("master"),
      agent("plain"),
      agent("child", { origin: "delegate", parentAgentId: "master" }),
      agent("legacy", { reportToAgentId: "master" }),
    ]);
    store.set(agentListLoadedAtom, true);
    render(
      <Provider store={store}>
        <ConfirmProvider>
          <MemoryRouter initialEntries={[`/projects/${encodeURIComponent(CWD)}`]}>
            <Routes>
              <Route path="/projects/:workspacePath" element={<ProjectDetailRoute />} />
            </Routes>
          </MemoryRouter>
        </ConfirmProvider>
      </Provider>,
    );
    expect(screen.getAllByText("会话-master").length).toBeGreaterThan(0);
    expect(screen.getAllByText("会话-plain").length).toBeGreaterThan(0);
    expect(screen.queryByText("会话-child")).toBeNull();
    expect(screen.queryByText("会话-legacy")).toBeNull();
  });
});
