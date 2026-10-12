import { describe, expect, it } from "vitest";
import type { FsEntry } from "@agentdeck/protocol";
import {
  buildCommandPaletteItems,
  buildFileItems,
  COMMAND_PALETTE_COMMANDS,
  filterCommandPaletteGroups,
  shouldLoadCommandPaletteFiles,
  type CommandPaletteSession,
} from "./command-palette";
import type { WorkspaceProject } from "./workspaces";

function session(id: string, title: string, preview = ""): CommandPaletteSession {
  return { id, title, subtitle: "Claude Code · /repo", preview, updatedAt: 200 };
}

function project(path: string, name: string): WorkspaceProject {
  return { path, name, createdAt: 1, updatedAt: 2 };
}

function groupLabels(query: string, items = buildCommandPaletteItems({})): string[] {
  return filterCommandPaletteGroups(items, query, { maxPerGroup: 20 })
    .flatMap((group) => group.items.map((item) => item.label));
}

describe("command palette item building and filtering", () => {
  it("matches fixed commands by Chinese and English keywords", () => {
    expect(groupLabels("环境")).toContain("环境检测");
    expect(groupLabels("claude")).toContain("编程 Agent");
    expect(groupLabels("terminal")).toContain("终端");
  });

  it("only navigates to routes that still exist", () => {
    const routes = COMMAND_PALETTE_COMMANDS.map((item) => item.action.type === "navigate" ? item.action.to : "");
    expect(routes).toEqual([
      "/",
      "/history",
      "/projects",
      "/console",
      "/coding-agents",
      "/env",
      "/common",
      "/notifications",
      "/theme",
      "/about",
    ]);
  });

  it("matches sessions by title, preview and id", () => {
    const items = buildCommandPaletteItems({
      sessions: [session("session-abc123", "修复登录问题", "检查 token 刷新")],
    });

    expect(groupLabels("登录", items)).toContain("修复登录问题");
    expect(groupLabels("abc123", items)).toContain("修复登录问题");
    expect(groupLabels("token", items)).toContain("修复登录问题");
  });

  it("matches projects by display name and absolute path", () => {
    const items = buildCommandPaletteItems({
      projects: [project("/Users/enzo/work/agent-deck", "AgentDeck")],
    });

    expect(groupLabels("Deck", items)).toContain("AgentDeck");
    expect(groupLabels("/Users/enzo/work", items)).toContain("AgentDeck");
  });

  it("keeps empty query focused on fixed commands and recent dynamic entities", () => {
    const items = buildCommandPaletteItems({
      sessions: [session("s1", "最近会话")],
      projects: [project("/Users/enzo/project", "最近项目")],
    });
    const labels = groupLabels("", items);

    expect(labels).toContain("新建对话");
    expect(labels).toContain("最近会话");
    expect(labels).toContain("最近项目");
    expect(labels).not.toContain("关于 AgentDeck");
  });

  it("builds file open actions from bounded directory entries", () => {
    const entry: FsEntry = { name: "README.md", path: "/Users/enzo/project/README.md", is_dir: false };
    const [item] = buildFileItems([{ entry, projectPath: "/Users/enzo/project", projectName: "project" }]);

    expect(item).toMatchObject({
      label: "README.md",
      group: "files",
      action: { type: "open-path", path: "/Users/enzo/project/README.md" },
    });
  });

  it("does not load file search until the query has at least two characters", () => {
    expect(shouldLoadCommandPaletteFiles("")).toBe(false);
    expect(shouldLoadCommandPaletteFiles("a")).toBe(false);
    expect(shouldLoadCommandPaletteFiles("中文")).toBe(true);
    expect(shouldLoadCommandPaletteFiles("ab")).toBe(true);
  });
});
