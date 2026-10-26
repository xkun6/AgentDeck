// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Provider, createStore } from "jotai";
import type { AgentSnapshot } from "@agentdeck/protocol";
import { stubRadixGlobals } from "@/test-utils/radix";
import { ConfirmProvider } from "@/lib/use-confirm";
import { replaceAgentSnapshotsAtom } from "@/stores/agents";
import {
  isWorkspaceProjectPinned,
  readWorkspaceProjects,
  rememberWorkspaceProject,
  togglePinnedWorkspaceProject,
} from "@/lib/workspaces";
import { WorkbenchSidebar } from "@/components/app-shell/workbench-sidebar";

stubRadixGlobals();

const deleteSession = vi.fn(async () => {});
vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => ({ deleteSession }),
  humanizeSidecarError: (error: unknown) => String(error),
  isInactiveAgent: (agent: { status?: string } | null | undefined) =>
    agent?.status === "dormant" || agent?.status === "closed",
}));
vi.mock("@/hooks/use-agent-catalog", () => ({ useAgentProviders: () => ({ data: undefined }) }));

const CWD = "C:/work/demo";
const agent: AgentSnapshot = {
  id: "agent-1",
  provider: "claude",
  cwd: CWD,
  title: "我的会话标题",
  status: "idle",
  pendingPermissions: [],
  lastSeq: 0,
  resumable: false,
  createdAt: 1000,
  updatedAt: 2000,
};

function renderSidebar() {
  const store = createStore();
  store.set(replaceAgentSnapshotsAtom, [agent]);
  return render(
    <Provider store={store}>
      <ConfirmProvider>
        <MemoryRouter>
          <WorkbenchSidebar />
        </MemoryRouter>
      </ConfirmProvider>
    </Provider>,
  );
}

const writeText = vi.fn(async () => {});

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const project = rememberWorkspaceProject(CWD, "demo");
  expect(project).not.toBeNull();
  if (isWorkspaceProjectPinned(CWD)) togglePinnedWorkspaceProject(CWD);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("会话右键菜单", () => {
  it("右键侧边栏会话行出现全部菜单项，复制工作目录写入剪贴板", async () => {
    renderSidebar();
    fireEvent.contextMenu(screen.getByText("我的会话标题"));
    for (const label of ["打开会话", "复制会话标题", "复制工作目录", "查看所属项目", "删除会话"]) {
      expect(await screen.findByRole("menuitem", { name: label })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("menuitem", { name: "复制工作目录" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CWD));
  });

  it("点删除会话先弹确认，确认后才删除", async () => {
    renderSidebar();
    fireEvent.contextMenu(screen.getByText("我的会话标题"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除会话" }));
    expect(deleteSession).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith("agent-1"));
  });
});

describe("项目右键菜单", () => {
  it("右键置顶项目出现菜单，点取消置顶调用切换", async () => {
    togglePinnedWorkspaceProject(CWD);
    expect(readWorkspaceProjects().some((p) => p.path === CWD)).toBe(true);
    renderSidebar();
    fireEvent.contextMenu(screen.getByRole("button", { name: "折叠项目：demo" }));
    for (const label of ["新对话", "打开项目详情", "复制路径", "删除项目"]) {
      expect(await screen.findByRole("menuitem", { name: label })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("menuitem", { name: "取消置顶" }));
    await waitFor(() => expect(isWorkspaceProjectPinned(CWD)).toBe(false));
  });
});
