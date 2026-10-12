import { describe, expect, it } from "vitest";
import { groupConsecutiveTools, groupElapsedMs } from "./group-tools";
import type { ChatToolItem } from "./chat-types";

function tool(overrides: Partial<ChatToolItem> & { tool_id: string }): ChatToolItem {
  return {
    name: "bash",
    status: "done",
    startedAt: 0,
    context: "cd /tmp",
    ...overrides,
  };
}

describe("groupConsecutiveTools", () => {
  it("returns each tool as a single entry when nothing repeats", () => {
    const tools: ChatToolItem[] = [
      tool({ tool_id: "1", context: "cd /a" }),
      tool({ tool_id: "2", context: "cd /b" }),
      tool({ tool_id: "3", name: "read", context: "/a/file.ts" }),
    ];
    const out = groupConsecutiveTools(tools);
    expect(out).toHaveLength(3);
    expect(out.every((entry) => entry.kind === "single")).toBe(true);
  });

  it("groups consecutive identical tools", () => {
    const tools: ChatToolItem[] = [
      tool({ tool_id: "1", context: "cd /repo" }),
      tool({ tool_id: "2", context: "cd /repo" }),
      tool({ tool_id: "3", context: "cd /repo" }),
    ];
    const out = groupConsecutiveTools(tools);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("group");
    if (out[0].kind === "group") {
      expect(out[0].tools).toHaveLength(3);
    }
  });

  it("does not merge non-adjacent identical tools", () => {
    const tools: ChatToolItem[] = [
      tool({ tool_id: "1", context: "cd /a" }),
      tool({ tool_id: "2", context: "cd /a" }),
      tool({ tool_id: "3", name: "read", context: "/x" }),
      tool({ tool_id: "4", context: "cd /a" }),
    ];
    const out = groupConsecutiveTools(tools);
    expect(out.map((entry) => entry.kind)).toEqual(["group", "single", "single"]);
  });

  it("ignores whitespace differences in context", () => {
    const tools: ChatToolItem[] = [
      tool({ tool_id: "1", context: "cd /repo" }),
      tool({ tool_id: "2", context: "  cd  /repo  " }),
    ];
    const out = groupConsecutiveTools(tools);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("group");
  });

  it("never merges error or running tools", () => {
    const tools: ChatToolItem[] = [
      tool({ tool_id: "1", context: "cd /a" }),
      tool({ tool_id: "2", context: "cd /a", status: "error", error: "fail" }),
      tool({ tool_id: "3", context: "cd /a" }),
      tool({ tool_id: "4", context: "cd /a", status: "running" }),
    ];
    const out = groupConsecutiveTools(tools);
    expect(out.map((entry) => entry.kind)).toEqual(["single", "single", "single", "single"]);
  });

  it("treats different tool names as different groups", () => {
    const tools: ChatToolItem[] = [
      tool({ tool_id: "1", name: "bash", context: "ls" }),
      tool({ tool_id: "2", name: "shell", context: "ls" }),
    ];
    const out = groupConsecutiveTools(tools);
    expect(out).toHaveLength(2);
    expect(out.every((entry) => entry.kind === "single")).toBe(true);
  });
});

describe("groupElapsedMs", () => {
  it("sums each tool's duration when completedAt available", () => {
    const tools: ChatToolItem[] = [
      tool({ tool_id: "1", startedAt: 0, completedAt: 100 }),
      tool({ tool_id: "2", startedAt: 200, completedAt: 350 }),
    ];
    expect(groupElapsedMs(tools)).toBe(250);
  });

  it("returns undefined when no tool has completedAt", () => {
    expect(groupElapsedMs([tool({ tool_id: "1", startedAt: 100 })])).toBeUndefined();
  });

  it("returns undefined for empty input", () => {
    expect(groupElapsedMs([])).toBeUndefined();
  });
});
