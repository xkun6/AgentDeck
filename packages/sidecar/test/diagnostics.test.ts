import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HEAP_WARN_RATIO,
  formatMemory,
  logMemorySample,
  startMemorySampler,
  type MemorySnapshot,
} from "../src/diagnostics.js";
import type { Logger } from "../src/logger.js";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MB = 1024 * 1024;

function recordingLogger() {
  const lines: Array<{ level: string; text: string }> = [];
  const push =
    (level: string) =>
    (message: string, ...args: unknown[]) => {
      let i = 0;
      lines.push({ level, text: message.replace(/%[sd%]/g, () => String(args[i++])) });
    };
  const logger: Logger = {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    close: () => undefined,
  };
  return { logger, lines };
}

function snapshot(heapUsedMb: number, heapLimitMb = 4096): MemorySnapshot {
  return {
    rss: 500 * MB,
    heapUsed: heapUsedMb * MB,
    heapTotal: 600 * MB,
    external: 10 * MB,
    arrayBuffers: 5 * MB,
    heapLimit: heapLimitMb * MB,
  };
}

describe("内存采样", () => {
  it("低于 80% 只写 info，包含各项内存字段与附加信息", () => {
    const { logger, lines } = recordingLogger();
    const warned = logMemorySample(logger, snapshot(1000), () => "sessions=3");
    expect(warned).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("info");
    for (const key of ["rss=", "heapUsed=", "heapTotal=", "external=", "arrayBuffers=", "heapLimit=", "sessions=3"]) {
      expect(lines[0]?.text).toContain(key);
    }
  });

  it("恰好 80% 不告警，超过 80% 额外写 warn", () => {
    const limit = 1000;
    const exact = recordingLogger();
    expect(logMemorySample(exact.logger, snapshot(limit * HEAP_WARN_RATIO, limit))).toBe(false);
    const over = recordingLogger();
    expect(logMemorySample(over.logger, snapshot(limit * HEAP_WARN_RATIO + 1, limit))).toBe(true);
    expect(over.lines.map((line) => line.level)).toEqual(["info", "warn"]);
    expect(over.lines[1]?.text).toContain("接近上限");
  });

  it("附加信息抛错不影响采样", () => {
    const { logger, lines } = recordingLogger();
    logMemorySample(logger, snapshot(10), () => {
      throw new Error("x");
    });
    expect(lines).toHaveLength(1);
  });

  it("startMemorySampler 启动即采样一次，之后按间隔采样，停止后不再写", async () => {
    const { logger, lines } = recordingLogger();
    const stop = startMemorySampler(logger, { intervalMs: 20, snapshot: () => snapshot(1) });
    expect(lines).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 90));
    stop();
    const count = lines.length;
    expect(count).toBeGreaterThanOrEqual(3);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(lines.length).toBe(count);
    expect(formatMemory(snapshot(1))).toContain("heapUsed=1.0MB");
  });
});

describe("致命错误与退出事件落盘", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "agentdeck-diag-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function runFixture(mode: string) {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "test/fixtures/diagnostics-child.ts"],
      {
        cwd: PACKAGE_DIR,
        env: { ...process.env, FIXTURE_LOG_DIR: dir, FIXTURE_MODE: mode },
        encoding: "utf8",
        windowsHide: true,
        timeout: 20_000,
      },
    );
    return { status: result.status, log: readFileSync(path.join(dir, "sidecar.log"), "utf8") };
  }

  it("uncaughtException：同步写入错误、堆栈、内存与退出事件（非零码），interop token 已脱敏", () => {
    const { status, log } = runFixture("throw");
    expect(status).toBe(1);
    expect(log).toContain("[error] 未捕获的异常：Error: 夹具致命错误 adi_***");
    expect(log).toContain("diagnostics-child.ts");
    expect(log).toMatch(/内存：rss=.* heapUsed=.* heapTotal=.* external=.* arrayBuffers=/);
    expect(log).toContain("进程退出事件：code=1 原因=uncaughtException");
    expect(log).not.toContain("0123456789abcdef0123");
  });

  it("unhandledRejection：只记录不退出，随后正常退出码 0", () => {
    const { status, log } = runFixture("reject");
    expect(status).toBe(0);
    expect(log).toContain("未处理的 Promise 拒绝：Error: 夹具未处理拒绝");
    expect(log).toContain("进程退出事件：code=0 原因=夹具正常结束");
  });

  it("正常退出路径记录原因（如 stdin end）", () => {
    const { status, log } = runFixture("normal");
    expect(status).toBe(0);
    expect(log).toContain("[info] 进程退出事件：code=0 原因=stdin end");
  });
});
