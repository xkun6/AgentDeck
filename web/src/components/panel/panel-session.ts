import type { AgentSnapshot } from "@agentdeck/protocol";

/** 工作台列表的一行：sidecar agent 快照 + 已解析的显示标题与 Agent 名称。 */
export interface PanelSession {
  agent: AgentSnapshot;
  title: string;
  provider: string;
}

export function shortId(id: string): string {
  return id.slice(-6);
}

export function sessionTokens(agent: AgentSnapshot): number {
  const usage = agent.lastUsage;
  return (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
}
