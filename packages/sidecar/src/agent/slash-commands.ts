import type { AgentSlashCommand } from "@agentdeck/protocol";

/** 按 name 去重，保留第一次出现（design.md 4.14） */
export function dedupeSlashCommands(commands: readonly AgentSlashCommand[]): AgentSlashCommand[] {
  const seen = new Set<string>();
  const result: AgentSlashCommand[] = [];
  for (const command of commands) {
    if (seen.has(command.name)) {
      continue;
    }
    seen.add(command.name);
    result.push(command);
  }
  return result;
}
