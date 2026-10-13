// 真实 codex 冒烟测试（opt-in）：AGENTDECK_SMOKE=1 pnpm --filter @agentdeck/sidecar exec vitest run test/providers/codex
// 需要本机已安装并登录 codex CLI；会真实调用模型。
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentStreamEvent } from "@agentdeck/protocol";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { AgentSession } from "../../../src/agent/types.js";
import { createLogger } from "../../../src/logger.js";
import { CodexAgentClient } from "../../../src/providers/codex/index.js";

const SMOKE = process.env.AGENTDECK_SMOKE === "1";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const WORK_DIR = path.join(REPO_ROOT, "tmp", `codex-smoke-${process.pid}`);

const isTerminal = (e: AgentStreamEvent) =>
  e.type === "turn_completed" || e.type === "turn_failed" || e.type === "turn_canceled";

function summarize(e: AgentStreamEvent): string {
  if (e.type === "timeline") {
    const item = e.item;
    if (item.type === "tool_call") {
      const detail = item.detail.type === "shell" ? ` ${item.detail.command}` : "";
      return `timeline:tool_call(${item.name},${item.status}${detail})`;
    }
    if (item.type === "assistant_message" || item.type === "reasoning") {
      return `timeline:${item.type}(${JSON.stringify(item.text.slice(0, 40))})`;
    }
    return `timeline:${item.type}`;
  }
  if (e.type === "turn_failed") return `turn_failed(${e.error})`;
  if (e.type === "permission_requested") return `permission_requested(${e.request.title ?? e.request.name})`;
  return e.type;
}

/** 合并连续的同类增量，便于阅读事件序列 */
function compact(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const kind = line.replace(/\(.*$/, "");
    const prev = out.at(-1);
    if (prev && (kind === "timeline:assistant_message" || kind === "timeline:reasoning") && prev.startsWith(kind)) {
      const count = Number(prev.match(/×(\d+)$/)?.[1] ?? 1) + 1;
      out[out.length - 1] = `${prev.replace(/ ×\d+$/, "")} ×${count}`;
      continue;
    }
    out.push(line);
  }
  return out;
}

async function runTurn(session: AgentSession, prompt: string, timeoutMs = 240_000) {
  const events: AgentStreamEvent[] = [];
  const unsubscribe = session.subscribe((e) => {
    if (e.type === "provider_subagent" || e.type === "provider_background_tasks") return;
    events.push(e);
    if (e.type === "permission_requested") {
      void session.respondToPermission(e.request.id, { behavior: "allow" });
    }
  });
  try {
    await session.startTurn(prompt);
    const deadline = Date.now() + timeoutMs;
    while (!events.some(isTerminal)) {
      if (Date.now() > deadline) throw new Error(`回合超时：${prompt}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    unsubscribe();
  }
  return events;
}

describe.skipIf(!SMOKE)("Codex 真实冒烟", () => {
  const logger = createLogger({ logDir: path.join(REPO_ROOT, "tmp", "codex-smoke-logs") });
  const client = new CodexAgentClient({ logger, env: process.env });
  let session: AgentSession | null = null;

  beforeAll(() => {
    mkdirSync(WORK_DIR, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: WORK_DIR, windowsHide: true });
  });

  afterAll(async () => {
    await session?.close();
    logger.close();
    rmSync(WORK_DIR, { recursive: true, force: true });
  });

  test("isAvailable 与 fetchCatalog", async () => {
    const availability = await client.isAvailable();
    console.info("[smoke] isAvailable:", JSON.stringify(availability));
    expect(availability.available).toBe(true);
    const catalog = await client.fetchCatalog({ cwd: WORK_DIR });
    console.info("[smoke] models:", catalog.models.map((m) => `${m.id}${m.isDefault ? "*" : ""}`).join(", "));
    expect(catalog.models.length).toBeGreaterThan(0);
  }, 60_000);

  test("两轮对话：回复 OK；执行 echo agentdeck-smoke", async () => {
    session = await client.createSession({ cwd: WORK_DIR, modeId: "auto" });

    const first = await runTurn(session, "只回复 OK，不要输出别的内容。");
    console.info("[smoke] 第 1 轮:\n  " + compact(first.map(summarize)).join("\n  "));
    const text = first
      .flatMap((e) => (e.type === "timeline" && e.item.type === "assistant_message" ? [e.item.text] : []))
      .join("");
    expect(text.trim().length).toBeGreaterThan(0);
    expect(first.at(-1)?.type).toBe("turn_completed");
    expect(first.some((e) => e.type === "thread_started")).toBe(true);

    const second = await runTurn(session, "请用 shell 执行命令 echo agentdeck-smoke，然后把输出告诉我。");
    console.info("[smoke] 第 2 轮:\n  " + compact(second.map(summarize)).join("\n  "));
    const shell = second.find(
      (e) => e.type === "timeline" && e.item.type === "tool_call" && e.item.detail.type === "shell",
    );
    expect(shell).toBeTruthy();
    expect(second.at(-1)?.type).toBe("turn_completed");
    console.info("[smoke] threadId:", session.id);
  }, 600_000);
});
