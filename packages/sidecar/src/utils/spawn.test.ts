// Derived from paseo packages/server/src/utils/spawn.test.ts (Apache-2.0); modified for AgentDeck
// 改动：环境变量用例改为验证 AGENTDECK_* 内部变量被剔除；删除依赖 paseo buildSelfNodeCommand 的用例。
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { execCommand, spawnProcess } from "./spawn.js";

const printEnvScript = `
const keys = [
  "CUSTOM",
  "AGENTDECK_TOKEN",
  "AGENTDECK_PORT",
  "AGENTDECK_PARENT_PID",
];
const values = Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]));
console.log(JSON.stringify(values));
`;

function parsePrintedEnv(stdout: string): Record<string, string | null> {
  return JSON.parse(stdout.trim()) as Record<string, string | null>;
}

describe("execCommand", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("returns stdout and stderr for a successful command", async () => {
    const result = await execCommand("echo", ["hello"]);

    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
  });

  test("rejects when the command times out", async () => {
    const command =
      process.platform === "win32"
        ? {
            command: process.execPath,
            args: ["-e", "setTimeout(() => {}, 10_000)"],
          }
        : { command: "sleep", args: ["10"] };

    await expect(execCommand(command.command, command.args, { timeout: 100 })).rejects.toThrow();
  });

  test("runs the command in the provided cwd", async () => {
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "spawn-test-")));
    tempDirs.push(cwd);

    const command =
      process.platform === "win32"
        ? {
            command: process.execPath,
            args: ["-e", "console.log(process.cwd())"],
          }
        : { command: "pwd", args: [] };

    const result = await execCommand(command.command, command.args, { cwd });

    expect(realpathSync(result.stdout.trim())).toBe(cwd);
    expect(result.stderr).toBe("");
  });

  test("treats env as the replacement base and strips internal AGENTDECK_* env", async () => {
    const result = await execCommand(process.execPath, ["-e", printEnvScript], {
      baseEnv: {
        CUSTOM: "from-base",
        PATH: process.env.PATH,
        AGENTDECK_TOKEN: "base-token",
      },
      env: {
        CUSTOM: "from-env",
        PATH: process.env.PATH,
        AGENTDECK_TOKEN: "secret-token",
        AGENTDECK_PORT: "1234",
      },
      envOverlay: {
        CUSTOM: "from-overlay",
        AGENTDECK_PARENT_PID: "42",
      },
    });

    expect(parsePrintedEnv(result.stdout)).toEqual({
      CUSTOM: "from-overlay",
      AGENTDECK_TOKEN: null,
      AGENTDECK_PORT: null,
      AGENTDECK_PARENT_PID: null,
    });
  });

  test("does not inherit process.env when env replacement is supplied", async () => {
    process.env.AGENTDECK_TEST_SHOULD_NOT_LEAK_X = "leaked";
    process.env.SIDECAR_TEST_SHOULD_NOT_LEAK = "leaked";
    try {
      const result = await execCommand(
        process.execPath,
        [
          "-e",
          "console.log(JSON.stringify({ leaked: process.env.SIDECAR_TEST_SHOULD_NOT_LEAK ?? null }))",
        ],
        {
          env: {
            PATH: process.env.PATH,
          },
        },
      );

      expect(JSON.parse(result.stdout.trim())).toEqual({ leaked: null });
    } finally {
      delete process.env.AGENTDECK_TEST_SHOULD_NOT_LEAK_X;
      delete process.env.SIDECAR_TEST_SHOULD_NOT_LEAK;
    }
  });

  test("spawnProcess strips internal env inherited from process.env", async () => {
    process.env.AGENTDECK_TOKEN = "inherited-secret";
    let child: ChildProcess;
    try {
      child = spawnProcess(process.execPath, ["-e", printEnvScript], {
        envOverlay: {
          CUSTOM: "spawn-overlay",
        },
      });
    } finally {
      delete process.env.AGENTDECK_TOKEN;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });

    expect(Buffer.concat(stderrChunks).toString()).toBe("");
    expect(exitCode).toBe(0);
    expect(parsePrintedEnv(Buffer.concat(stdoutChunks).toString())).toEqual({
      CUSTOM: "spawn-overlay",
      AGENTDECK_TOKEN: null,
      AGENTDECK_PORT: null,
      AGENTDECK_PARENT_PID: null,
    });
  });

  test("internal env mode preserves sidecar-owned env", async () => {
    const result = await execCommand(process.execPath, ["-e", printEnvScript], {
      envMode: "internal",
      baseEnv: {
        PATH: process.env.PATH,
        AGENTDECK_TOKEN: "kept",
      },
      envOverlay: {
        CUSTOM: "internal",
      },
    });

    expect(parsePrintedEnv(result.stdout)).toEqual({
      CUSTOM: "internal",
      AGENTDECK_TOKEN: "kept",
      AGENTDECK_PORT: null,
      AGENTDECK_PARENT_PID: null,
    });
  });

  test("does not realpath commands while finalizing external command env", async () => {
    const realpathSpy = vi.spyOn(fs.realpathSync, "native");

    await execCommand("/some/random/binary", ["--version"], {
      env: {
        PATH: process.env.PATH,
      },
      timeout: 100,
    }).catch(() => {});

    expect(realpathSpy).not.toHaveBeenCalled();
  });
});
