import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentInWorkspace,
  normalizeWorkspacePath,
  readPinnedWorkspaceProjectPaths,
  readSessionWorkspaceMap,
  readWorkspaceProjects,
  rememberSessionWorkspace,
  rememberWorkspaceProject,
  removeWorkspaceProject,
  togglePinnedWorkspaceProject,
  unpinWorkspaceProjects,
  writePinnedWorkspaceProjectPaths,
  workspaceNameFromPath,
} from "./workspaces";
import { __resetUiStoreForTests } from "./ui-store";

describe("workspace persistence helpers", () => {
  beforeEach(() => {
    __resetUiStoreForTests();
    vi.stubGlobal("window", {
      dispatchEvent: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
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
