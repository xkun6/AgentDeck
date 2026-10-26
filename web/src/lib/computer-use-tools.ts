// Computer Use 工具（design.md 4.37）：时间线里 agentdeck_cua MCP 工具调用的显示名。
// 工具名由各 CLI 加前缀：Claude `mcp__agentdeck_cua__click`，Codex `agentdeck_cua.click`。
const COMPUTER_USE_TOOL_PATTERN = /(?:^|__)agentdeck_cua(?:__|\.)(.+)$/;

/** agentdeck_cua 的工具显示为「Computer Use · <tool>」，其它工具名原样返回 */
export function toolDisplayName(name: string): string {
  const match = COMPUTER_USE_TOOL_PATTERN.exec(name);
  return match ? `Computer Use · ${match[1]}` : name;
}
