// Claude Code 可执行文件定位（design.md 5.1）。顺序：
//   1. 环境变量 AGENTDECK_CLAUDE_PATH（指向 .cmd shim 时同样解析出背后的真实 exe）
//   2. PATH 上的 claude.exe（非 Windows 为 claude）
//   3. PATH 上的 npm shim claude.cmd → 解析出真实 exe（或 cli.js）
//   4. 不可用
// 只使用用户本机安装的 Claude Code：PATH 中位于 node_modules 内的目录（项目本地依赖）一律跳过。
// 每个候选都跑一次 `--version`（带超时）校验，失败则继续下一个。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { isInsideNodeModules } from "../../utils/node-modules-dir.js";
import { execCommand } from "../../utils/spawn.js";

export type ClaudeExecutableSource = "env" | "path" | "npm-shim";

export interface ClaudeExecutable {
  /** 真实可执行文件（.exe 或无扩展名的原生二进制；极少数情况为 cli.js，由当前 node 执行） */
  path: string;
  source: ClaudeExecutableSource;
  version: string;
}

export type ClaudeExecutableResolution =
  | ({ available: true } & ClaudeExecutable)
  | { available: false; reason: string };

export interface ClaudeExecutableDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  exists(filePath: string): boolean;
  readFile(filePath: string): string;
  /** 跑 `--version`，成功返回版本文本，失败返回 null */
  probe(executablePath: string): Promise<string | null>;
  warn?(message: string): void;
}

export const CLAUDE_PATH_ENV = "AGENTDECK_CLAUDE_PATH";
const PROBE_TIMEOUT_MS = 8_000;

export const CLAUDE_UNAVAILABLE_REASON =
  "未找到 Claude Code 可执行文件：请先安装 Claude Code（npm i -g @anthropic-ai/claude-code），" +
  `或设置环境变量 ${CLAUDE_PATH_ENV} 指向 claude.exe`;

export async function resolveClaudeExecutable(
  deps: ClaudeExecutableDeps = createDefaultClaudeExecutableDeps(),
): Promise<ClaudeExecutableResolution> {
  const failures: string[] = [];
  const tryCandidate = async (
    candidate: string | null,
    source: ClaudeExecutableSource,
  ): Promise<ClaudeExecutable | null> => {
    if (!candidate || !deps.exists(candidate)) {
      return null;
    }
    const version = await deps.probe(candidate);
    if (version === null) {
      failures.push(`${candidate}（--version 校验失败）`);
      return null;
    }
    return { path: candidate, source, version };
  };

  // 1. AGENTDECK_CLAUDE_PATH
  const configured = deps.env[CLAUDE_PATH_ENV]?.trim();
  if (configured) {
    const target = isCommandScript(configured)
      ? parseNpmCmdShim(configured, deps)
      : configured;
    const found = await tryCandidate(target, "env");
    if (found) {
      return { available: true, ...found };
    }
    deps.warn?.(`${CLAUDE_PATH_ENV}=${configured} 不可用，继续查找其它位置`);
    if (!deps.exists(configured)) {
      failures.push(`${configured}（${CLAUDE_PATH_ENV} 指向的文件不存在）`);
    }
  }

  const pathDirs = splitPath(deps);

  // 2. PATH 上的 claude.exe
  const exeName = deps.platform === "win32" ? "claude.exe" : "claude";
  for (const dir of pathDirs) {
    const found = await tryCandidate(path.join(dir, exeName), "path");
    if (found) {
      return { available: true, ...found };
    }
  }

  // 3. npm 的 claude.cmd shim
  if (deps.platform === "win32") {
    for (const dir of pathDirs) {
      const shim = path.join(dir, "claude.cmd");
      if (!deps.exists(shim)) {
        continue;
      }
      const found = await tryCandidate(parseNpmCmdShim(shim, deps), "npm-shim");
      if (found) {
        return { available: true, ...found };
      }
    }
  }

  const detail = failures.length > 0 ? `；已尝试：${failures.join("、")}` : "";
  return { available: false, reason: `${CLAUDE_UNAVAILABLE_REASON}${detail}` };
}

/**
 * 解析 npm 生成的 .cmd shim，得到它实际调用的 exe（或 js）。
 * 典型内容：`"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*`
 * 旧版：`"%_prog%"  "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*`
 */
export function parseNpmCmdShim(
  shimPath: string,
  deps: Pick<ClaudeExecutableDeps, "exists" | "readFile">,
): string | null {
  const shimDir = path.dirname(shimPath);
  let content = "";
  try {
    content = deps.readFile(shimPath);
  } catch {
    content = "";
  }

  const targets: string[] = [];
  const pattern = /"%~?dp0%?\\?([^"]+?\.(?:exe|js|cjs|mjs))"/gi;
  for (const match of content.matchAll(pattern)) {
    const relative = match[1];
    if (relative) {
      targets.push(path.join(shimDir, relative));
    }
  }
  // 原生 exe 优先于 js
  targets.sort((a, b) => Number(!isExe(a)) - Number(!isExe(b)));
  for (const target of targets) {
    if (deps.exists(target)) {
      return target;
    }
  }

  // shim 内容无法识别时，按 npm 全局安装的固定布局兜底
  const fallback = path.join(shimDir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  return deps.exists(fallback) ? fallback : null;
}

function isExe(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".exe";
}

function isCommandScript(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

export function isJavaScriptEntry(filePath: string): boolean {
  return /\.(?:js|cjs|mjs)$/i.test(filePath);
}

function splitPath(deps: Pick<ClaudeExecutableDeps, "env" | "platform">): string[] {
  // Windows 上环境变量名大小写不敏感，但普通对象里可能是 Path
  const raw =
    deps.env.PATH ??
    deps.env.Path ??
    Object.entries(deps.env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ??
    "";
  const delimiter = deps.platform === "win32" ? ";" : ":";
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const entry of raw.split(delimiter)) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || isInsideNodeModules(dir)) {
      continue;
    }
    const key = deps.platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    dirs.push(dir);
  }
  return dirs;
}

export async function probeClaudeVersion(
  executablePath: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<string | null> {
  const js = isJavaScriptEntry(executablePath);
  try {
    const { stdout } = await execCommand(
      js ? process.execPath : executablePath,
      js ? [executablePath, "--version"] : ["--version"],
      {
        env,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
        shell: false,
      },
    );
    return stdout.trim() || "unknown";
  } catch {
    return null;
  }
}

export function createDefaultClaudeExecutableDeps(
  env: NodeJS.ProcessEnv = process.env,
  warn?: (message: string) => void,
): ClaudeExecutableDeps {
  return {
    env,
    platform: process.platform,
    exists: existsSync,
    readFile: (filePath) => readFileSync(filePath, "utf8"),
    probe: (executablePath) => probeClaudeVersion(executablePath, env),
    ...(warn ? { warn } : {}),
  };
}
