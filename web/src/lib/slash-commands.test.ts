import { describe, expect, it } from "vitest";
import { isLocalMcpCommand, MCP_COMMAND_DESCRIPTION, mergeSlashCommands } from "./slash-commands";

describe("mergeSlashCommands", () => {
  const remote = [
    { name: "compact", description: "Clear conversation history but keep a summary" },
    { name: "mcp", description: "Manage MCP servers", argumentHint: "[enable|disable]" },
    { name: "compact", description: "重复项" },
    { name: "review" },
  ];

  it("Claude / Codex：本地 /mcp 置顶并覆盖描述、带 AgentDeck 标签，其余按 name 去重", () => {
    expect(mergeSlashCommands(remote, "claude")).toEqual([
      { name: "mcp", description: MCP_COMMAND_DESCRIPTION, badge: "AgentDeck" },
      remote[0],
      remote[3],
    ]);
    expect(mergeSlashCommands([], "codex")).toEqual([
      { name: "mcp", description: MCP_COMMAND_DESCRIPTION, badge: "AgentDeck" },
    ]);
  });

  it("ACP 与未知种类：不加本地命令，原样去重", () => {
    expect(mergeSlashCommands(remote, "acp")).toEqual([remote[0], remote[1], remote[3]]);
    expect(mergeSlashCommands(undefined, undefined)).toEqual([]);
  });
});

describe("isLocalMcpCommand", () => {
  it("仅 Claude / Codex、无附件、文本恰为 /mcp 时拦截", () => {
    expect(isLocalMcpCommand({ text: "/mcp", attachments: [] }, "claude")).toBe(true);
    expect(isLocalMcpCommand({ text: " /mcp ", attachments: [] }, "codex")).toBe(true);
    expect(isLocalMcpCommand({ text: "/mcp", attachments: [{}] }, "claude")).toBe(false);
    expect(isLocalMcpCommand({ text: "/mcp enable x", attachments: [] }, "claude")).toBe(false);
    expect(isLocalMcpCommand({ text: "/mcp", attachments: [] }, "acp")).toBe(false);
    expect(isLocalMcpCommand({ text: "/compact", attachments: [] }, "claude")).toBe(false);
  });
});
