// 新建会话的工作目录候选：从现有会话的 cwd 去重，最近使用的在前；子会话（多在 worktree 里）不算（design.md 4.26）。
import type { AgentSnapshot } from "@agentdeck/protocol";
import { isDispatchedAgent, isHiddenAgent } from "@/lib/session-list";

export interface CwdOption {
  cwd: string;
  lastUsedAt: number;
  sessionCount: number;
}

/** 分隔符与大小写归一（Windows 路径不区分大小写、`\` 与 `/` 等价） */
export function cwdKey(cwd: string): string {
  const unified = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(unified) || unified.startsWith("//") ? unified.toLowerCase() : unified;
}

export function recentCwdOptions(
  agents: readonly Pick<AgentSnapshot, "cwd" | "updatedAt" | "origin" | "parentAgentId" | "reportToAgentId">[],
): CwdOption[] {
  const byKey = new Map<string, CwdOption>();
  for (const agent of agents) {
    if (isHiddenAgent(agent) || isDispatchedAgent(agent) || !agent.cwd.trim()) continue;
    const key = cwdKey(agent.cwd);
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, { cwd: agent.cwd, lastUsedAt: agent.updatedAt, sessionCount: 1 });
    } else {
      current.sessionCount += 1;
      if (agent.updatedAt > current.lastUsedAt) {
        current.lastUsedAt = agent.updatedAt;
        current.cwd = agent.cwd;
      }
    }
  }
  return [...byKey.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

/** 目录的最后一段，列表里作主标题 */
export function cwdBaseName(cwd: string): string {
  const parts = cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd;
}
