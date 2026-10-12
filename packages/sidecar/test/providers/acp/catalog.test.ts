import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { Logger } from "../../../src/logger.js";
import { createAcpClients } from "../../../src/providers/acp/index.js";
import {
  BUILTIN_ACP_AGENTS,
  loadCustomAcpAgents,
  mergeAcpAgents,
  parseCustomAcpAgents,
} from "../../../src/providers/acp/catalog.js";

function recordingLogger() {
  const lines: string[] = [];
  const push = (level: string) => (message: string, ...args: unknown[]) =>
    lines.push(`${level}:${message}:${args.map(String).join("|")}`);
  const logger: Logger = {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    close: () => undefined,
  };
  return { logger, lines };
}

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentdeck-acp-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("内置目录", () => {
  test("gemini / qwen / kimi / hermes 四个条目与 design.md 5.1 一致", () => {
    expect(BUILTIN_ACP_AGENTS.map(({ id, label, command }) => ({ id, label, command }))).toEqual([
      { id: "acp:gemini", label: "Gemini CLI", command: ["npx", "-y", "@google/gemini-cli", "--acp"] },
      { id: "acp:qwen", label: "Qwen Code", command: ["npx", "-y", "@qwen-code/qwen-code", "--acp"] },
      { id: "acp:kimi", label: "Kimi CLI", command: ["kimi", "acp"] },
      { id: "acp:hermes", label: "Hermes Agent", command: ["hermes", "acp"] },
    ]);
  });
});

describe("acp-agents.json 解析", () => {
  test("合法项保留，缺前缀自动补 acp:，env 透传", () => {
    const { logger, lines } = recordingLogger();
    const entries = parseCustomAcpAgents(
      JSON.stringify([
        { id: "acp:mine", label: "Mine", command: ["mine", "acp"] },
        { id: "other", label: "Other", command: ["other"], env: { FOO: "1" } },
      ]),
      "acp-agents.json",
      logger,
    );
    expect(entries).toEqual([
      { id: "acp:mine", label: "Mine", command: ["mine", "acp"], builtin: false },
      { id: "acp:other", label: "Other", command: ["other"], env: { FOO: "1" }, builtin: false },
    ]);
    expect(lines).toEqual([]);
  });

  test("非法项记日志并忽略，不影响其它项", () => {
    const { logger, lines } = recordingLogger();
    const entries = parseCustomAcpAgents(
      JSON.stringify([
        { id: "ok", label: "OK", command: ["ok"] },
        { id: "no-command", label: "X" },
        { id: "empty-command", label: "X", command: [] },
        { label: "no id", command: ["x"] },
        { id: "bad-env", label: "X", command: ["x"], env: { A: 1 } },
        { id: "acp:", label: "empty name", command: ["x"] },
        "not an object",
      ]),
      "acp-agents.json",
      logger,
    );
    expect(entries.map((e) => e.id)).toEqual(["acp:ok"]);
    expect(lines.filter((line) => line.startsWith("warn:"))).toHaveLength(6);
  });

  test("非 JSON / 顶层非数组：记错误并返回空", () => {
    const { logger, lines } = recordingLogger();
    expect(parseCustomAcpAgents("{oops", "f", logger)).toEqual([]);
    expect(parseCustomAcpAgents('{"id":"x"}', "f", logger)).toEqual([]);
    expect(lines.filter((line) => line.startsWith("error:"))).toHaveLength(2);
  });

  test("自定义同 id 覆盖内置（保持原位置），新条目追加在后", () => {
    const { logger } = recordingLogger();
    const custom = parseCustomAcpAgents(
      JSON.stringify([
        { id: "kimi", label: "Kimi 本地版", command: ["C:/tools/kimi.exe", "acp"] },
        { id: "mine", label: "Mine", command: ["mine"] },
      ]),
      "f",
      logger,
    );
    const merged = mergeAcpAgents(BUILTIN_ACP_AGENTS, custom, logger);
    expect(merged.map((e) => e.id)).toEqual([
      "acp:gemini",
      "acp:qwen",
      "acp:kimi",
      "acp:hermes",
      "acp:mine",
    ]);
    expect(merged[2]).toEqual({
      id: "acp:kimi",
      label: "Kimi 本地版",
      command: ["C:/tools/kimi.exe", "acp"],
      builtin: false,
    });
  });

  test("loadCustomAcpAgents：未设置 dataDir 或文件不存在时返回空且不报错", async () => {
    const { logger, lines } = recordingLogger();
    expect(await loadCustomAcpAgents(undefined, logger)).toEqual([]);
    expect(await loadCustomAcpAgents(await tempDir(), logger)).toEqual([]);
    expect(lines).toEqual([]);
  });

  test("createAcpClients：内置 + 自定义，每个条目一个 kind=acp 的 client", async () => {
    const dir = await tempDir();
    await writeFile(
      path.join(dir, "acp-agents.json"),
      JSON.stringify([{ id: "mine", label: "Mine", command: ["mine", "acp"] }]),
    );
    const { logger } = recordingLogger();
    const clients = await createAcpClients({ logger, dataDir: dir, env: process.env });
    expect(clients.map((c) => [c.provider, c.kind, c.label])).toEqual([
      ["acp:gemini", "acp", "Gemini CLI"],
      ["acp:qwen", "acp", "Qwen Code"],
      ["acp:kimi", "acp", "Kimi CLI"],
      ["acp:hermes", "acp", "Hermes Agent"],
      ["acp:mine", "acp", "Mine"],
    ]);
  });
});
