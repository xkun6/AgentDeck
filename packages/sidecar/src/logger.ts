import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import { format } from "node:util";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  close(): void;
}

export interface CreateLoggerOptions {
  /** 日志目录；设置时追加写 `<logDir>/sidecar.log`（目录不存在则创建） */
  logDir?: string;
  /** 是否写 stderr，默认 true */
  stderr?: boolean;
}

/**
 * sidecar 日志：只写 stderr 与日志文件，**绝不写 stdout**（stdout 只留给 ready 握手行）。
 * 文件写入用同步 writeSync，保证 process.exit 前的日志不丢。
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const toStderr = options.stderr ?? true;
  let fd: number | null = null;
  if (options.logDir) {
    try {
      mkdirSync(options.logDir, { recursive: true });
      fd = openSync(path.join(options.logDir, "sidecar.log"), "a");
    } catch (error) {
      process.stderr.write(`[sidecar] 打开日志文件失败：${String(error)}\n`);
    }
  }

  const write = (level: LogLevel, message: string, args: unknown[]) => {
    const line = `${new Date().toISOString()} [${level}] ${format(message, ...args)}\n`;
    if (toStderr) {
      process.stderr.write(line);
    }
    if (fd !== null) {
      try {
        writeSync(fd, line);
      } catch {
        // 日志写失败不能影响主流程
      }
    }
  };

  return {
    debug: (message, ...args) => write("debug", message, args),
    info: (message, ...args) => write("info", message, args),
    warn: (message, ...args) => write("warn", message, args),
    error: (message, ...args) => write("error", message, args),
    close: () => {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
        fd = null;
      }
    },
  };
}

/** 测试用静默 logger */
export function createSilentLogger(): Logger {
  const noop = () => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop, close: noop };
}
