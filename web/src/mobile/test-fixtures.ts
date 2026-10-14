import type { AgentSnapshot } from "@agentdeck/protocol";

export function agent(id: string, overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id,
    provider: "claude",
    cwd: "J:/Program/Demo",
    status: "idle",
    pendingPermissions: [],
    lastSeq: 10,
    resumable: true,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}
