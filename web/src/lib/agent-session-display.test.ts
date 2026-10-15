import { describe, expect, it } from "vitest";
import type { AgentSnapshot } from "@agentdeck/protocol";
import { AGENT_STATUS_LABELS, agentStatusLabel, isAgentActive, isAgentRunning } from "./agent-session-display";

function agent(patch: Partial<AgentSnapshot>): AgentSnapshot {
  return {
    id: "a",
    provider: "claude",
    cwd: "/w",
    status: "idle",
    pendingPermissions: [],
    lastSeq: 0,
    resumable: false,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

describe("isAgentActive / agentStatusLabel（backgroundActive 只影响显示）", () => {
  it("running 或 backgroundActive 为 true 视为进行中", () => {
    expect(isAgentActive(agent({ status: "running" }))).toBe(true);
    expect(isAgentActive(agent({ status: "idle", backgroundActive: true }))).toBe(true);
    expect(isAgentActive(agent({ status: "idle" }))).toBe(false);
    expect(isAgentActive(agent({ status: "idle", backgroundActive: false }))).toBe(false);
  });

  it("idle + backgroundActive 显示「运行中」文案，否则按 status", () => {
    expect(agentStatusLabel(agent({ status: "idle", backgroundActive: true }))).toBe(AGENT_STATUS_LABELS.running);
    expect(agentStatusLabel(agent({ status: "idle" }))).toBe(AGENT_STATUS_LABELS.idle);
    expect(agentStatusLabel(agent({ status: "dormant" }))).toBe(AGENT_STATUS_LABELS.dormant);
  });

  it("isAgentRunning 把 backgroundActive 计入", () => {
    expect(isAgentRunning(agent({ status: "idle", backgroundActive: true }), undefined)).toBe(true);
    expect(isAgentRunning(agent({ status: "idle" }), undefined)).toBe(false);
  });
});
