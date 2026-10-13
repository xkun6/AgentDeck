// 会话详情页的斜杠命令：合并 Agent 自报命令与 AgentDeck 本地命令（/mcp），以及 /mcp 拦截判断。
import type { AgentProviderKind, AgentSlashCommand } from "@agentdeck/protocol";
import type { ComposerSlashCommand } from "@/components/chat/composer-types";

export const MCP_COMMAND_DESCRIPTION = "查看 MCP 服务器状态，重连失败的服务器";
export const LOCAL_COMMAND_BADGE = "AgentDeck";

/** Claude / Codex 的 `/mcp` 由 AgentDeck 打开 MCP 面板处理。 */
export function supportsLocalMcpCommand(kind: AgentProviderKind | undefined): boolean {
  return kind === "claude" || kind === "codex";
}

/** Agent 命令按 name 去重；支持本地 /mcp 时把它（覆盖描述、带 AgentDeck 标签）放在最前。 */
export function mergeSlashCommands(
  commands: readonly AgentSlashCommand[] | undefined,
  kind: AgentProviderKind | undefined,
): ComposerSlashCommand[] {
  const seen = new Set<string>();
  const merged: ComposerSlashCommand[] = [];
  if (supportsLocalMcpCommand(kind)) {
    merged.push({ name: "mcp", description: MCP_COMMAND_DESCRIPTION, badge: LOCAL_COMMAND_BADGE });
    seen.add("mcp");
  }
  for (const command of commands ?? []) {
    if (seen.has(command.name)) continue;
    seen.add(command.name);
    merged.push(command);
  }
  return merged;
}

/** 无附件且文本恰为 `/mcp`：不发送，直接打开 MCP 面板。 */
export function isLocalMcpCommand(
  payload: { text: string; attachments: readonly unknown[] },
  kind: AgentProviderKind | undefined,
): boolean {
  return supportsLocalMcpCommand(kind) && payload.attachments.length === 0 && payload.text.trim() === "/mcp";
}
