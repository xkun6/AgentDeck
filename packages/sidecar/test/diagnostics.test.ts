import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HEAP_WARN_RATIO,
  RUNNING_MARKER_FILE,
  claimRunningMarker,
  formatMemory,
  logMemorySample,
  readRunningMarker,
  removeRunningMarker,
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

  function runFixture(mode: string, withMarker = false) {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "test/fixtures/diagnostics-child.ts"],
      {
        cwd: PACKAGE_DIR,
        env: {
          ...process.env,
          FIXTURE_LOG_DIR: dir,
          FIXTURE_MODE: mode,
          ...(withMarker ? { FIXTURE_MARKER: "1" } : {}),
        },
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

  it("运行标记：正常退出与 fatal 退出都会删除；被外部硬杀则残留，下次启动 warn 后覆盖", () => {
    const marker = path.join(dir, RUNNING_MARKER_FILE);

    runFixture("normal", true);
    expect(existsSync(marker)).toBe(false);

    runFixture("throw", true);
    expect(existsSync(marker)).toBe(false);

    runFixture("kill", true);
    expect(existsSync(marker)).toBe(true);
    const stale = readRunningMarker(marker);
    expect(stale?.pid).toBeGreaterThan(0);

    const { log } = runFixture("normal", true);
    expect(log).toContain(`[warn] 上次 sidecar（pid=${stale!.pid}，启动于 ${stale!.startedAt}）未正常退出（被外部结束或进程级崩溃）`);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("运行标记（sidecar.running）", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "agentdeck-marker-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("没有残留：不告警，写入本进程 pid 与启动时间", () => {
    const { logger, lines } = recordingLogger();
    const file = path.join(dir, RUNNING_MARKER_FILE);
    expect(claimRunningMarker(file, logger, () => new Date("2026-01-02T03:04:05.000Z"))).toBeNull();
    expect(lines).toEqual([]);
    expect(readRunningMarker(file)).toEqual({ pid: process.pid, startedAt: "2026-01-02T03:04:05.000Z" });
  });

  it("有残留：warn 带上次 pid 与启动时间，并覆盖为本进程", () => {
    const { logger, lines } = recordingLogger();
    const file = path.join(dir, RUNNING_MARKER_FILE);
    writeFileSync(file, JSON.stringify({ pid: 4242, startedAt: "2026-01-01T00:00:00.000Z" }));
    expect(claimRunningMarker(file, logger)).toEqual({ pid: 4242, startedAt: "2026-01-01T00:00:00.000Z" });
    expect(lines).toEqual([
      {
        level: "warn",
        text: "上次 sidecar（pid=4242，启动于 2026-01-01T00:00:00.000Z）未正常退出（被外部结束或进程级崩溃）",
      },
    ]);
    expect(readRunningMarker(file)?.pid).toBe(process.pid);
  });

  it("残留内容损坏：仍然告警（pid 未知）；目录不存在时写入失败不抛错", () => {
    const { logger, lines } = recordingLogger();
    const file = path.join(dir, RUNNING_MARKER_FILE);
    writeFileSync(file, "not json");
    claimRunningMarker(file, logger);
    expect(lines[0]?.text).toBe("上次 sidecar（pid=未知）未正常退出（被外部结束或进程级崩溃）");
    expect(() => claimRunningMarker(path.join(dir, "missing", RUNNING_MARKER_FILE), logger)).not.toThrow();
  });

  it("removeRunningMarker 只删除本进程写的标记", () => {
    const file = path.join(dir, RUNNING_MARKER_FILE);
    writeFileSync(file, JSON.stringify({ pid: process.pid + 1, startedAt: "x" }));
    removeRunningMarker(file);
    expect(existsSync(file)).toBe(true);
    writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: "x" }));
    removeRunningMarker(file);
    expect(existsSync(file)).toBe(false);
    expect(() => removeRunningMarker(file)).not.toThrow();
  });
});
