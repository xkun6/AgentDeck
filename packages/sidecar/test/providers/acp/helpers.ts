import { fileURLToPath } from "node:url";

import type { AgentStreamEvent } from "@agentdeck/protocol";

import { createSilentLogger } from "../../../src/logger.js";
import { AcpAgentClient } from "../../../src/providers/acp/acp-client.js";
import type { AcpAgentEntry } from "../../../src/providers/acp/catalog.js";

export const FAKE_AGENT_PATH = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

export function fakeEntry(env: Record<string, string> = {}, id = "acp:fake"): AcpAgentEntry {
  return {
    id,
    label: "Fake ACP",
    command: [process.execPath, FAKE_AGENT_PATH],
    env,
    builtin: false,
  };
}

/** 直接用 execPath，跳过 findExecutable 的 --version 探测，测试更快 */
export function fakeClient(env: Record<string, string> = {}): AcpAgentClient {
  return new AcpAgentClient(fakeEntry(env), {
    logger: createSilentLogger(),
    env: process.env,
    findExecutable: async (name) => name,
  });
}

export function collect(session: { subscribe(cb: (e: AgentStreamEvent) => void): () => void }) {
  const events: AgentStreamEvent[] = [];
  session.subscribe((e) => events.push(e));
  return events;
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil 超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export const TERMINAL_TYPES = new Set(["turn_completed", "turn_failed", "turn_canceled"]);

export function terminalEvents(events: AgentStreamEvent[]): AgentStreamEvent[] {
  return events.filter((e) => TERMINAL_TYPES.has(e.type));
}

export function waitForTerminal(events: AgentStreamEvent[], count = 1, timeoutMs?: number) {
  return waitUntil(() => terminalEvents(events).length >= count, timeoutMs);
}

export function timelineItems(events: AgentStreamEvent[]) {
  return events.flatMap((e) => (e.type === "timeline" ? [e.item] : []));
}

export function assistantText(events: AgentStreamEvent[]): string {
  return timelineItems(events)
    .map((item) => (item.type === "assistant_message" ? item.text : ""))
    .join("");
}
