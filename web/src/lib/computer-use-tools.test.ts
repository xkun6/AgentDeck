import { describe, expect, test } from "vitest";
import { toolDisplayName } from "./computer-use-tools";

describe("toolDisplayName", () => {
  test("Claude / Codex 的 agentdeck_cua 工具显示为 Computer Use · <tool>", () => {
    expect(toolDisplayName("mcp__agentdeck_cua__click")).toBe("Computer Use · click");
    expect(toolDisplayName("agentdeck_cua.get_window_state")).toBe("Computer Use · get_window_state");
  });

  test("其它工具名原样返回", () => {
    expect(toolDisplayName("mcp__agentdeck__delegate")).toBe("mcp__agentdeck__delegate");
    expect(toolDisplayName("Bash")).toBe("Bash");
  });
});
