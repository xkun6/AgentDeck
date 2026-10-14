/**
 * sidecar 致命错误与资源诊断（design.md 4.18）。
 *
 * 目标：sidecar 意外退出时 `sidecar.log` 里一定留下线索——致命错误堆栈、退出码与原因、
 * 退出前最近一次内存采样。fatal / exit 路径一律用 `appendFileSync` 同步写，独立于 logger 的 fd。
 */
import { appendFileSync } from "node:fs";
import v8 from "node:v8";

import { formatLogLine, type LogLevel, type Logger } from "./logger.js";

export const MEMORY_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
/** heapUsed 超过堆上限的该比例时写 warn */
export const HEAP_WARN_RATIO = 0.8;
/** uncaughtException 后优雅关闭的硬退出兜底 */
export const FATAL_HARD_EXIT_MS = 4_000;

export interface MemorySnapshot {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  /** V8 堆上限（字节） */
  heapLimit: number;
}

export function takeMemorySnapshot(
  memoryUsage: () => NodeJS.MemoryUsage = () => process.memoryUsage(),
  heapLimit: () => number = () => v8.getHeapStatistics().heap_size_limit,
): MemorySnapshot {
  const usage = memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    heapLimit: heapLimit(),
  };
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function formatMemory(snapshot: MemorySnapshot): string {
  return (
    `rss=${mb(snapshot.rss)} heapUsed=${mb(snapshot.heapUsed)} heapTotal=${mb(snapshot.heapTotal)} ` +
    `external=${mb(snapshot.external)} arrayBuffers=${mb(snapshot.arrayBuffers)} heapLimit=${mb(snapshot.heapLimit)}`
  );
}

export interface MemorySamplerOptions {
  intervalMs?: number;
  /** 附加到采样行末尾的业务信息（会话数、子代理时间线占用等） */
  extra?: () => string;
  snapshot?: () => MemorySnapshot;
}

/** 写一条内存采样；heapUsed 超过堆上限 80% 时再写一条 warn。返回是否触发告警。 */
export function logMemorySample(
  logger: Logger,
  snapshot: MemorySnapshot,
  extra?: () => string,
): boolean {
  let suffix = "";
  try {
    const text = extra?.();
    suffix = text ? ` ${text}` : "";
  } catch {
    // 附加信息失败不影响采样
  }
  logger.info("内存采样 %s%s", formatMemory(snapshot), suffix);
  if (snapshot.heapLimit > 0 && snapshot.heapUsed > snapshot.heapLimit * HEAP_WARN_RATIO) {
    logger.warn(
      "堆内存接近上限：heapUsed=%s 已超过堆上限 %s 的 %d%%",
      mb(snapshot.heapUsed),
      mb(snapshot.heapLimit),
      Math.round(HEAP_WARN_RATIO * 100),
    );
    return true;
  }
  return false;
}

/** 启动时采样一次，之后每 intervalMs（默认 5 分钟）一次；定时器 unref。返回停止函数。 */
export function startMemorySampler(logger: Logger, options: MemorySamplerOptions = {}): () => void {
  const snapshot = options.snapshot ?? (() => takeMemorySnapshot());
  const sample = () => {
    try {
      logMemorySample(logger, snapshot(), options.extra);
    } catch (error) {
      logger.warn("内存采样失败：%s", String(error));
    }
  };
  sample();
  const timer = setInterval(sample, options.intervalMs ?? MEMORY_SAMPLE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export interface ProcessDiagnosticsOptions {
  logger: Logger;
  /** sidecar.log 路径；未设置日志目录时只写 stderr */
  logFile?: string;
  /** uncaughtException 后的优雅关闭（应以非零码退出） */
  onFatal: (reason: string, exitCode: number) => void;
  /** 测试用：替换硬退出兜底 */
  hardExit?: (code: number) => void;
}

export interface ProcessDiagnostics {
  /** shutdown 路径调用，供 exit 事件记录原因 */
  setExitReason(reason: string): void;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  try {
    return typeof error === "string" ? error : JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** 注册 uncaughtException / unhandledRejection / exit 处理。全部同步写文件。 */
export function installProcessDiagnostics(options: ProcessDiagnosticsOptions): ProcessDiagnostics {
  let exitReason: string | null = null;

  const writeSyncLine = (level: LogLevel, text: string) => {
    const line = formatLogLine(level, text);
    try {
      process.stderr.write(line);
    } catch {
      // ignore
    }
    if (options.logFile) {
      try {
        appendFileSync(options.logFile, line);
      } catch {
        // 日志写失败不能影响退出流程
      }
    }
  };

  const memoryText = () => {
    try {
      return formatMemory(takeMemorySnapshot());
    } catch {
      return "（内存信息不可用）";
    }
  };

  process.on("uncaughtException", (error) => {
    writeSyncLine("error", `未捕获的异常：${describeError(error)}\n内存：${memoryText()}`);
    options.onFatal("uncaughtException", 1);
    const timer = setTimeout(() => {
      writeSyncLine("error", `优雅关闭超过 ${FATAL_HARD_EXIT_MS}ms，强制退出（code=1）`);
      (options.hardExit ?? process.exit)(1);
    }, FATAL_HARD_EXIT_MS);
    // 兜底定时器本身不阻止进程正常退出
    timer.unref();
  });

  // 保持现有行为：只记录、不退出，避免引入新的崩溃
  process.on("unhandledRejection", (reason) => {
    writeSyncLine("error", `未处理的 Promise 拒绝：${describeError(reason)}\n内存：${memoryText()}`);
  });

  process.on("exit", (code) => {
    writeSyncLine(
      code === 0 ? "info" : "error",
      `进程退出事件：code=${code} 原因=${exitReason ?? "未经过 shutdown 流程（启动失败或直接 process.exit）"}`,
    );
  });

  return {
    setExitReason(reason) {
      exitReason ??= reason;
    },
  };
}
