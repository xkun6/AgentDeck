// 真实 Claude Code 冒烟测试（opt-in）：AGENTDECK_SMOKE=1 时才运行，会消耗真实额度。
//   AGENTDECK_SMOKE=1 pnpm --filter @agentdeck/sidecar exec vitest run test/providers/claude
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentStreamEnvelope, AgentStreamEvent } from "@agentdeck/protocol";
import { afterAll, describe, expect, test } from "vitest";

import { AgentManager } from "../../../src/agent/agent-manager.js";
import { createLogger } from "../../../src/logger.js";
import { ClaudeAgentClient } from "../../../src/providers/claude/index.js";

const SMOKE = process.env.AGENTDECK_SMOKE === "1";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const TURN_TIMEOUT_MS = 180_000;

function describeEvent(event: AgentStreamEvent): string {
  switch (event.type) {
    case "timeline": {
      const item = event.item;
      if (item.type === "tool_call") {
        return `timeline:tool_call(${item.name},${item.status},${item.detail.type})`;
      }
      if (item.type === "assistant_message" || item.type === "reasoning") {
        return `timeline:${item.type}(${JSON.stringify(item.text.slice(0, 40))})`;
      }
      return `timeline:${item.type}`;
    }
    case "permission_requested":
      return `permission_requested(${event.request.kind}:${event.request.name})`;
    case "permission_resolved":
      return `permission_resolved(${event.response.behavior})`;
    case "turn_failed":
      return `turn_failed(${event.error})`;
    case "thread_started":
      return `thread_started(${event.sessionId})`;
    default:
      return event.type;
  }
}

describe.skipIf(!SMOKE)("Claude Code 真实冒烟", () => {
  const cwd = path.join(REPO_ROOT, "tmp", `claude-smoke-${Date.now()}`);
  mkdirSync(cwd, { recursive: true });
  const logger = createLogger({ logDir: path.join(REPO_ROOT, "tmp", "claude-smoke-logs") });
  const client = new ClaudeAgentClient({ logger, env: process.env });
  const manager = new AgentManager({ registry: { get: (id) => (id === "claude" ? client : undefined) }, logger });
  const envelopes: AgentStreamEnvelope[] = [];

  manager.subscribe({
    onStream: (envelope) => {
      envelopes.push(envelope);
      const event = envelope.event;
      if (event.type === "permission_requested") {
        void manager
          .respondToPermission(envelope.agentId, event.request.id, { behavior: "allow" })
          .catch((error: unknown) => logger.error("自动批准失败：%s", String(error)));
      }
    },
  });

  afterAll(async () => {
    await manager.shutdown();
    logger.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  async function runTurn(agentId: string, prompt: string): Promise<AgentStreamEvent[]> {
    const from = envelopes.length;
    const { turnId } = await manager.sendPrompt(agentId, prompt);
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    const isTerminal = (e: AgentStreamEvent) =>
      (e.type === "turn_completed" || e.type === "turn_failed" || e.type === "turn_canceled") &&
      e.turnId === turnId;
    while (!envelopes.slice(from).some((env) => isTerminal(env.event))) {
      if (Date.now() > deadline) throw new Error(`回合超时：${prompt}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const events = envelopes.slice(from).map((env) => env.event);
    // eslint-disable-next-line no-console
    console.log(`[smoke] ${prompt}\n  ${events.map(describeEvent).join("\n  ")}`);
    return events;
  }

  test(
    "两轮：纯文本回复 + Bash 工具调用",
    async () => {
      const availability = await client.isAvailable();
      // eslint-disable-next-line no-console
      console.log(`[smoke] availability: ${JSON.stringify(availability)}`);
      expect(availability.available).toBe(true);

      const agent = await manager.createAgent({ provider: "claude", cwd });

      const first = await runTurn(agent.id, "只回复 OK，不要使用任何工具。");
      const text = first
        .flatMap((e) => (e.type === "timeline" && e.item.type === "assistant_message" ? [e.item.text] : []))
        .join("");
      expect(text.trim().length).toBeGreaterThan(0);
      expect(first.at(-1)?.type).toBe("turn_completed");
      expect(first.filter((e) => e.type === "thread_started")).toHaveLength(1);

      const second = await runTurn(
        agent.id,
        // Windows 上 Claude Code 可能只提供 PowerShell 工具，两者都映射为 shell detail
        "请使用 Bash 工具（若没有 Bash 则用 PowerShell 工具）执行命令 `echo agentdeck-smoke`，然后告诉我输出是什么。",
      );
      const shellCalls = second.filter(
        (e) => e.type === "timeline" && e.item.type === "tool_call" && e.item.detail.type === "shell",
      );
      expect(shellCalls.length).toBeGreaterThan(0);
      expect(second.at(-1)?.type).toBe("turn_completed");
      expect(second.some((e) => e.type === "thread_started")).toBe(false);

      const snapshot = manager.getAgent(agent.id);
      // eslint-disable-next-line no-console
      console.log(`[smoke] snapshot: ${JSON.stringify({ status: snapshot.status, persistence: snapshot.persistence, lastUsage: snapshot.lastUsage })}`);
      expect(snapshot.persistence?.provider).toBe("claude");
    },
    TURN_TIMEOUT_MS * 2 + 30_000,
  );
});
