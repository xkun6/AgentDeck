import { findExecutable } from "../utils/executable-resolution/executable-resolution.js";
import { spawnProcess } from "../utils/spawn.js";

export interface GitResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** stdout 超过 maxBytes 被截断（进程已被终止） */
  truncated: boolean;
}

export interface RunGitOptions {
  cwd?: string;
  input?: string | Buffer;
  /** stdout 上限（字节），超出即终止进程并标记 truncated */
  maxBytes?: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;

/** 在 PATH 上找真实 git 可执行文件（Windows 下为 git.exe，不经 cmd）；找不到返回 null */
export async function locateGit(): Promise<string | null> {
  try {
    return await findExecutable("git");
  } catch {
    return null;
  }
}

/** 直接 spawn 真实 git（shell:false、windowsHide:true，由 spawnProcess 保证），按 Buffer 收集 stdout */
export function runGit(gitPath: string, args: string[], options: RunGitOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(gitPath, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      envOverlay: {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        LC_ALL: "C",
      },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stderr = "";
    let settled = false;
    const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`git 执行超时：${args.slice(0, 4).join(" ")}`));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const finish = (error: Error | null, code?: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      resolve({ code: code ?? null, stdout: Buffer.concat(chunks), stderr, truncated });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) {
        return;
      }
      const room = maxBytes - size;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, Math.max(0, room)));
        size = maxBytes;
        truncated = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 16_384) {
        stderr += chunk.toString("utf8");
      }
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(null, code));
    child.stdin?.on("error", () => undefined);
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
  });
}
