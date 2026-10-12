// Codex 可执行文件定位（design.md 5.1 / 5.2）：
// AGENTDECK_CODEX_PATH → PATH 上的 codex.exe（非 Windows 为 codex）→ 解析 npm 的 codex.cmd shim：
// 背后是 node_modules/@openai/codex/bin/codex.js 时优先找平台包里的原生 codex.exe，找不到则用当前 node 执行 codex.js。
// 设计参考 paseo codex-app-server-agent.ts 的 findDefaultCodexBinary，但实现为 AgentDeck 自写。
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export type CodexLaunchSource = "env" | "path" | "npm-shim-native" | "npm-shim-js";

export interface CodexLaunch {
  /** 直接 spawn 的可执行文件（原生 exe 或 node） */
  command: string;
  /** 放在 `app-server` 之前的参数（用 node 执行 codex.js 时为 [codex.js]） */
  args: string[];
  /** 额外环境变量（模拟 npm 入口脚本给原生 exe 设的变量） */
  envOverlay?: Record<string, string>;
  source: CodexLaunchSource;
}

export interface ResolveCodexLaunchOptions {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  /** 用来执行 codex.js 的 node，默认 process.execPath */
  nodePath?: string;
  exists?: (p: string) => boolean;
  readFile?: (p: string) => string;
  onWarning?: (message: string) => void;
}

const WINDOWS_TARGETS: Record<string, string> = {
  x64: "x86_64-pc-windows-msvc",
  arm64: "aarch64-pc-windows-msvc",
};

function envValue(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") {
    return env[key];
  }
  // Windows 环境变量不区分大小写（Path / PATH）
  const match = Object.keys(env).find((k) => k.toUpperCase() === key.toUpperCase());
  return match ? env[match] : undefined;
}

function pathDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const raw = envValue(env, "PATH", platform) ?? "";
  const sep = platform === "win32" ? ";" : ":";
  return raw
    .split(sep)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter((dir) => dir.length > 0);
}

function joinFor(platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === "win32" ? path.win32.join(...parts) : path.posix.join(...parts);
}

function dirnameFor(platform: NodeJS.Platform, p: string): string {
  return platform === "win32" ? path.win32.dirname(p) : path.posix.dirname(p);
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** 从 npm 生成的 codex.cmd 里取出它要执行的 js 入口（绝对路径） */
export function parseNpmCmdShimTarget(
  shimPath: string,
  content: string,
  platform: NodeJS.Platform = "win32",
): string | null {
  const match = content.match(/"%(?:~)?dp0%\\?([^"\r\n]+?\.(?:js|mjs|cjs))"/i);
  if (!match?.[1]) {
    return null;
  }
  const relative = match[1].replace(/^[\\/]+/, "");
  return joinFor(platform, dirnameFor(platform, shimPath), relative);
}

/** codex.js 所在包对应的原生 exe 候选（嵌套 node_modules、提升后的同级包、旧版 vendor） */
export function codexNativeCandidates(
  codexJsPath: string,
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  if (platform !== "win32") {
    return [];
  }
  const triple = WINDOWS_TARGETS[arch];
  if (!triple) {
    return [];
  }
  const pkgRoot = path.win32.dirname(path.win32.dirname(codexJsPath)); // .../@openai/codex
  const platformPkg = `codex-win32-${arch}`;
  const tail = ["vendor", triple, "bin", "codex.exe"];
  return [
    path.win32.join(pkgRoot, "node_modules", "@openai", platformPkg, ...tail),
    path.win32.join(path.win32.dirname(pkgRoot), platformPkg, ...tail),
    path.win32.join(pkgRoot, ...tail),
  ];
}

function resolveFromCodexJs(
  codexJsPath: string,
  opts: Required<Pick<ResolveCodexLaunchOptions, "exists">> & {
    platform: NodeJS.Platform;
    arch: string;
    nodePath: string;
  },
): CodexLaunch {
  const native = codexNativeCandidates(codexJsPath, opts.platform, opts.arch).find(opts.exists);
  if (native) {
    const pkgRoot = path.win32.dirname(path.win32.dirname(codexJsPath));
    return {
      command: native,
      args: [],
      envOverlay: {
        CODEX_MANAGED_PACKAGE_ROOT: safeRealpath(pkgRoot),
        CODEX_MANAGED_BY_NPM: "1",
      },
      source: "npm-shim-native",
    };
  }
  return { command: opts.nodePath, args: [codexJsPath], source: "npm-shim-js" };
}

function resolveCmdShim(
  shimPath: string,
  opts: {
    exists: (p: string) => boolean;
    readFile: (p: string) => string;
    platform: NodeJS.Platform;
    arch: string;
    nodePath: string;
  },
): CodexLaunch | null {
  let content: string;
  try {
    content = opts.readFile(shimPath);
  } catch {
    return null;
  }
  const target = parseNpmCmdShimTarget(shimPath, content, opts.platform);
  if (!target || !opts.exists(target)) {
    return null;
  }
  return resolveFromCodexJs(target, opts);
}

/** 解析 codex 的启动方式；找不到返回 null */
export function resolveCodexLaunch(options: ResolveCodexLaunchOptions): CodexLaunch | null {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const nodePath = options.nodePath ?? process.execPath;
  const exists = options.exists ?? existsSync;
  const readFile = options.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const ctx = { exists, readFile, platform, arch, nodePath };

  // 1. AGENTDECK_CODEX_PATH
  const override = envValue(options.env, "AGENTDECK_CODEX_PATH", platform)?.trim();
  if (override) {
    if (!exists(override)) {
      options.onWarning?.(`AGENTDECK_CODEX_PATH 指向的文件不存在：${override}`);
    } else {
      const ext = path.extname(override).toLowerCase();
      if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
        return { ...resolveFromCodexJs(override, ctx), source: "env" };
      }
      if (ext === ".cmd" || ext === ".bat") {
        const fromShim = resolveCmdShim(override, ctx);
        if (fromShim) {
          return { ...fromShim, source: "env" };
        }
        options.onWarning?.(`无法解析 AGENTDECK_CODEX_PATH 指向的 shim：${override}`);
      } else {
        return { command: override, args: [], source: "env" };
      }
    }
  }

  const dirs = pathDirs(options.env, platform);

  // 2. PATH 上的原生可执行文件
  const exeName = platform === "win32" ? "codex.exe" : "codex";
  for (const dir of dirs) {
    const candidate = joinFor(platform, dir, exeName);
    if (exists(candidate)) {
      return { command: candidate, args: [], source: "path" };
    }
  }

  // 3. Windows：npm 的 codex.cmd shim（PATH 之外再兜底 %APPDATA%\npm）
  if (platform === "win32") {
    const appData = envValue(options.env, "APPDATA", platform);
    const shimDirs = appData ? [...dirs, path.win32.join(appData, "npm")] : dirs;
    const seen = new Set<string>();
    for (const dir of shimDirs) {
      const shim = path.win32.join(dir, "codex.cmd");
      const key = shim.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (!exists(shim)) continue;
      const resolved = resolveCmdShim(shim, ctx);
      if (resolved) {
        return resolved;
      }
      options.onWarning?.(`无法解析 npm shim：${shim}`);
    }
  }

  return null;
}

/** ProviderInfo.command 用的完整启动命令 */
export function describeCodexLaunch(launch: CodexLaunch): string[] {
  return [launch.command, ...launch.args];
}
