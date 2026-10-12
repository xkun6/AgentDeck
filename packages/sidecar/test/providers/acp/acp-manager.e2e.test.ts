// 通过 AgentManager 端到端跑假 ACP agent（作为 acp-agents.json 自定义条目注入），验证 design.md 4.4 的 seq / turn 生命周期。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentSnapshot, AgentStreamEnvelope } from "@agentdeck/protocol";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { AgentManager } from "../../../src/agent/agent-manager.js";
import { createSilentLogger } from "../../../src/logger.js";
import { createAcpClients } from "../../../src/providers/acp/index.js";
import { createProviderRegistry, type ProviderRegistry } from "../../../src/providers/registry.js";
import { FAKE_AGENT_PATH, waitUntil } from "./helpers.js";

let dataDir: string;
let registry: ProviderRegistry;
let manager: AgentManager;
const envelopes: AgentStreamEnvelope[] = [];
const states: AgentSnapshot[] = [];

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "agentdeck-acp-e2e-"));
  await writeFile(
    path.join(dataDir, "acp-agents.json"),
    JSON.stringify([
      { id: "fake", label: "Fake ACP", command: [process.execPath, FAKE_AGENT_PATH] },
    ]),
  );
  registry = await createProviderRegistry(
    { logger: createSilentLogger(), dataDir, env: process.env },
    [createAcpClients],
  );
  manager = new AgentManager({ registry, coalesceWindowMs: 10 });
  manager.subscribe({
    onStream: (envelope) => envelopes.push(envelope),
    onState: (agent) => states.push(agent),
  });
});

afterAll(async () => {
  await manager.shutdown();
  await rm(dataDir, { recursive: true, force: true });
});

function forAgent(agentId: string) {
  return envelopes.filter((e) => e.agentId === agentId);
}

function idle(agentId: string) {
  return () => manager.getAgent(agentId).status === "idle" && !manager.getAgent(agentId).activeTurnId;
}

describe("ACP provider × AgentManager", () => {
  test("provider.list 含内置与自定义条目，自定义条目可用", async () => {
    const infos = await registry.listProviderInfo();
    const fake = infos.find((info) => info.id === "acp:fake");
    expect(fake).toEqual({
      id: "acp:fake",
      kind: "acp",
      label: "Fake ACP",
      available: true,
      command: [process.execPath, FAKE_AGENT_PATH],
    });
    expect(infos.map((info) => info.id)).toEqual(
      expect.arrayContaining(["acp:gemini", "acp:qwen", "acp:kimi", "acp:hermes", "acp:fake"]),
    );
  });

  test("一轮工具调用：seq 连续、user_message 在前、终态唯一且快照回到 idle", async () => {
    const agent = await manager.createAgent({ provider: "acp:fake", cwd: process.cwd(), title: "e2e" });
    expect(agent).toMatchObject({
      provider: "acp:fake",
      status: "idle",
      model: null,
      modeId: null,
      persistence: { provider: "acp:fake", sessionId: "fake-session-1" },
    });

    const { turnId } = await manager.sendPrompt(agent.id, "scenario:tools", "client-1");
    await waitUntil(idle(agent.id));

    const entries = forAgent(agent.id);
    expect(entries.map((e) => e.seq)).toEqual(entries.map((_, index) => index + 1));
    expect(new Set(entries.map((e) => e.epoch))).toEqual(new Set([manager.epoch]));
    const events = entries.map((e) => e.event);
    expect(events[0]).toEqual({
      type: "timeline",
      item: { type: "user_message", text: "scenario:tools", clientMessageId: "client-1" },
    });
    expect(events[1]).toEqual({ type: "thread_started", sessionId: "fake-session-1" });
    expect(events[2]).toEqual({ type: "turn_started", turnId });
    expect(events.at(-1)).toEqual({ type: "turn_completed", turnId });
    expect(
      events.filter((e) => e.type === "turn_completed" || e.type === "turn_failed" || e.type === "turn_canceled"),
    ).toHaveLength(1);
    // provider 不发 user_message；turn 内的 timeline 都带 turnId
    const timeline = events.slice(1).filter((e) => e.type === "timeline");
    expect(timeline.every((e) => e.type === "timeline" && e.turnId === turnId)).toBe(true);
    expect(timeline.some((e) => e.type === "timeline" && e.item.type === "user_message")).toBe(false);
    const toolStatuses = timeline.flatMap((e) =>
      e.type === "timeline" && e.item.type === "tool_call" && e.item.callId === "call-exec" ? [e.item.status] : [],
    );
    // AgentManager 的 coalescer 会在合并窗口内按 callId 只保留最新快照，这里只校验最终状态
    expect(toolStatuses.at(-1)).toBe("completed");

    const runningStates = states.filter((s) => s.id === agent.id && s.status === "running");
    expect(runningStates.length).toBeGreaterThan(0);
    expect(manager.getAgent(agent.id).lastError).toBeNull();

    // 模式通过 agent.setMode 下发并反映到快照
    const updated = await manager.setMode(agent.id, "plan");
    expect(updated.modeId).toBe("plan");
    await manager.close(agent.id);
    expect(manager.getAgent(agent.id).status).toBe("closed");
  });

  test("权限经由 AgentManager 中转：pendingPermissions 出现后应答，回合完成", async () => {
    const agent = await manager.createAgent({ provider: "acp:fake", cwd: process.cwd() });
    await manager.sendPrompt(agent.id, "scenario:permission");
    await waitUntil(() => manager.getAgent(agent.id).pendingPermissions.length === 1);
    const [request] = manager.getAgent(agent.id).pendingPermissions;
    expect(request?.actions?.map((a) => a.id)).toEqual(["opt-allow-once", "opt-allow-always", "opt-reject"]);

    await manager.respondToPermission(agent.id, request!.id, {
      behavior: "allow",
      selectedActionId: "opt-allow-always",
    });
    await waitUntil(idle(agent.id));
    const events = forAgent(agent.id).map((e) => e.event);
    expect(events.filter((e) => e.type === "permission_resolved")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("turn_completed");
    expect(manager.getAgent(agent.id).pendingPermissions).toEqual([]);
    await manager.close(agent.id);
  });

  test("agent.cancel → 只有一个 turn_canceled；崩溃 → turn_failed 记录 lastError", async () => {
    const agent = await manager.createAgent({ provider: "acp:fake", cwd: process.cwd() });
    const { turnId } = await manager.sendPrompt(agent.id, "scenario:slow");
    await waitUntil(() =>
      forAgent(agent.id).some((e) => e.event.type === "timeline" && e.event.item.type === "tool_call"),
    );
    await manager.cancel(agent.id);
    let events = forAgent(agent.id).map((e) => e.event);
    expect(events.filter((e) => e.type === "turn_canceled")).toEqual([
      { type: "turn_canceled", turnId, reason: "interrupted" },
    ]);
    expect(manager.getAgent(agent.id).status).toBe("idle");

    const crash = await manager.sendPrompt(agent.id, "scenario:crash");
    await waitUntil(idle(agent.id));
    events = forAgent(agent.id).map((e) => e.event);
    expect(events.at(-1)).toMatchObject({ type: "turn_failed", turnId: crash.turnId, code: "PROCESS_EXITED" });
    expect(manager.getAgent(agent.id).lastError).toContain("进程意外退出");
    await manager.close(agent.id);
  });
});
