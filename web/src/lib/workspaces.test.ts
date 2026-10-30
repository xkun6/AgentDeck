import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentInWorkspace,
  ensureWorkspaceProject,
  isManagedWorktreePath,
  moveWorkspaceProject,
  normalizeWorkspacePath,
  readPinnedWorkspaceProjectPaths,
  readSessionWorkspaceMap,
  readWorkspacePath,
  readWorkspaceProjects,
  rememberSessionWorkspace,
  rememberWorkspaceProject,
  removeWorkspaceProject,
  togglePinnedWorkspaceProject,
  unpinWorkspaceProjects,
  writePinnedWorkspaceProjectPaths,
  writeWorkspacePath,
  workspaceNameFromPath,
} from "./workspaces";
import { __resetUiStoreForTests, writeUiValue } from "./ui-store";

describe("workspace persistence helpers", () => {
  beforeEach(() => {
    __resetUiStoreForTests();
    vi.stubGlobal("window", {
      dispatchEvent: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  it("AgentDeck 自建的 worktree 不算项目：不登记、不写当前工作区，已误登记的读取时过滤", () => {
    const managed = [
      "C:\\Users\\x\\AppData\\Roaming\\local.agentdeck.desktop\\worktrees\\delegate-906423a5",
      "/data/worktrees/task-3f2a",
      "/data/worktrees/ab12cd34/2",
    ];
    for (const path of managed) expect(isManagedWorktreePath(path)).toBe(true);
    for (const path of ["/work/worktrees", "/work/worktrees/feature-x", "/work/delegate-906423a5"]) {
      expect(isManagedWorktreePath(path)).toBe(false);
    }

    rememberWorkspaceProject("/Users/claw/A");
    expect(rememberWorkspaceProject(managed[0]!)).toBeNull();
    ensureWorkspaceProject(managed[1]!);
    expect(readWorkspaceProjects().map((p) => p.path)).toEqual(["/Users/claw/A"]);

    writeWorkspacePath("/Users/claw/A");
    writeWorkspacePath(managed[0]!);
    expect(readWorkspacePath()).toBe("/Users/claw/A");

    writeUiValue("agentdeck-cn-ui.workspaceProjects", [
      { path: managed[0], name: "delegate-906423a5" },
      { path: "/Users/claw/B", name: "B" },
    ]);
    expect(readWorkspaceProjects().map((p) => p.path)).toEqual(["/Users/claw/B"]);
  });

  it("normalizes paths and derives project names", () => {
    expect(normalizeWorkspacePath(" /Users/claw/Project/ ")).toBe("/Users/claw/Project");
    expect(workspaceNameFromPath("/Users/claw/Project")).toBe("Project");
  });

  it("按 cwd 或会话关联判定会话是否属于项目", () => {
    const map = { "s-2": "/Users/claw/Project/", "s-3": "/Users/claw/Other" };
    const project = "/Users/claw/Project";
    expect(agentInWorkspace({ id: "s-1", cwd: "/Users/claw/Project/" }, project, map)).toBe(true);
    // cwd 为空时退回会话关联
    expect(agentInWorkspace({ id: "s-2", cwd: "" }, project, map)).toBe(true);
    expect(agentInWorkspace({ id: "s-3", cwd: "" }, project, map)).toBe(false);
    // cwd 优先于会话关联
    expect(agentInWorkspace({ id: "s-2", cwd: "/Users/claw/Other" }, project, map)).toBe(false);
    expect(agentInWorkspace({ id: "s-4", cwd: "" }, project, map)).toBe(false);
  });


  it("ignores malformed persisted workspace values from older builds", () => {
    __resetUiStoreForTests({
      "agentdeck-cn-ui.workspaceProjects": [
        { path: ["/Users/claw/OldA", "/Users/claw/OldB"], name: { label: "old" } },
        { path: "/Users/claw/Project", name: 42, createdAt: "bad", updatedAt: null },
      ],
      "agentdeck-cn-ui.sessionWorkspaces": {
        "session-1": ["/Users/claw/OldA"],
        "session-2": "/Users/claw/Project",
      },
    });

    expect(normalizeWorkspacePath(["/Users/claw/OldA"])).toBe("");
    expect(readWorkspaceProjects()).toEqual([
      expect.objectContaining({
        path: "/Users/claw/Project",
        name: "Project",
      }),
    ]);
    expect(readSessionWorkspaceMap()).toEqual({
      "session-2": "/Users/claw/Project",
    });
  });

  it("ensureWorkspaceProject only registers missing projects and never bumps existing ones", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      rememberWorkspaceProject("/Users/claw/A");
      vi.setSystemTime(2_000);
      rememberWorkspaceProject("/Users/claw/B");
      vi.setSystemTime(3_000);
      ensureWorkspaceProject("/Users/claw/A/");
      expect(readWorkspaceProjects().map((p) => [p.path, p.updatedAt])).toEqual([
        ["/Users/claw/B", 2_000],
        ["/Users/claw/A", 1_000],
      ]);

      ensureWorkspaceProject("/Users/claw/C");
      expect(readWorkspaceProjects().map((p) => p.path)).toEqual(["/Users/claw/C", "/Users/claw/B", "/Users/claw/A"]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("rememberWorkspaceProject 新项目放最前，已有项目刷新 updatedAt 但不调整顺序", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      rememberWorkspaceProject("/Users/claw/A");
      rememberWorkspaceProject("/Users/claw/B");
      vi.setSystemTime(5_000);
      rememberWorkspaceProject("/Users/claw/A");
      expect(readWorkspaceProjects().map((p) => [p.path, p.updatedAt])).toEqual([
        ["/Users/claw/B", 1_000],
        ["/Users/claw/A", 5_000],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("moveWorkspaceProject 把项目移到目标之前 / 之后", () => {
    for (const path of ["/p/C", "/p/B", "/p/A"]) rememberWorkspaceProject(path);
    const order = () => readWorkspaceProjects().map((p) => p.path);
    expect(order()).toEqual(["/p/A", "/p/B", "/p/C"]);
    moveWorkspaceProject("/p/A", "/p/C", "after");
    expect(order()).toEqual(["/p/B", "/p/C", "/p/A"]);
    moveWorkspaceProject("/p/A", "/p/B", "before");
    expect(order()).toEqual(["/p/A", "/p/B", "/p/C"]);
    moveWorkspaceProject("/p/A", "/p/missing", "before");
    expect(order()).toEqual(["/p/A", "/p/B", "/p/C"]);
  });

  it("stores workspace projects without duplicating equivalent paths", () => {
    rememberWorkspaceProject("/Users/claw/Project/");
    rememberWorkspaceProject("/Users/claw/Project", "Renamed");

    expect(readWorkspaceProjects()).toEqual([
      expect.objectContaining({
        path: "/Users/claw/Project",
        name: "Renamed",
      }),
    ]);
  });

  it("stores pinned workspace projects without duplicating equivalent paths", () => {
    writePinnedWorkspaceProjectPaths([
      "",
      "/Users/claw/Project/",
      "/Users/claw/Project",
      "/Users/claw/Other",
    ]);

    expect(Array.from(readPinnedWorkspaceProjectPaths())).toEqual([
      "/Users/claw/Project",
      "/Users/claw/Other",
    ]);
  });

  it("toggles and unpins workspace projects", () => {
    expect(Array.from(togglePinnedWorkspaceProject(" /Users/claw/Project/ "))).toEqual([
      "/Users/claw/Project",
    ]);
    expect(Array.from(togglePinnedWorkspaceProject("/Users/claw/Project"))).toEqual([]);

    writePinnedWorkspaceProjectPaths([
      "/Users/claw/Project",
      "/Users/claw/Other",
      "/Users/claw/Third",
    ]);

    expect(Array.from(unpinWorkspaceProjects(["/Users/claw/Other/"]))).toEqual([
      "/Users/claw/Project",
      "/Users/claw/Third",
    ]);
  });

  it("links sessions to workspaces and registers the project", () => {
    rememberSessionWorkspace("session-1", "/Users/claw/Project");

    expect(readSessionWorkspaceMap()).toEqual({
      "session-1": "/Users/claw/Project",
    });
    expect(readWorkspaceProjects()[0]).toMatchObject({
      path: "/Users/claw/Project",
      name: "Project",
    });
  });

  it("removes a workspace project and unlinks its sessions", () => {
    rememberSessionWorkspace("session-1", "/Users/claw/Project");
    rememberSessionWorkspace("session-2", "/Users/claw/Other");
    writePinnedWorkspaceProjectPaths(["/Users/claw/Project", "/Users/claw/Other"]);

    removeWorkspaceProject("/Users/claw/Project/");

    expect(readWorkspaceProjects()).toEqual([
      expect.objectContaining({ path: "/Users/claw/Other" }),
    ]);
    expect(readSessionWorkspaceMap()).toEqual({
      "session-2": "/Users/claw/Other",
    });
    expect(Array.from(readPinnedWorkspaceProjectPaths())).toEqual(["/Users/claw/Other"]);
  });
});
