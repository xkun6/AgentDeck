// Computer Use 驱动（trycua/cua 的 cua-driver）的定位、manifest 探测与安装（design.md 4.37）。
// 思路借鉴 LiveAgent crates/agent-gui/src-tauri/src/services/cua_driver/mod.rs（MIT）：
// 版本与 MCP 启动方式问 `cua-driver manifest`，安装转调官方脚本，不自己实现下载 / 更新。
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import type {
  ComputerUseInstallCommand,
  ComputerUseInstallResult,
} from "@agentdeck/protocol";
import which from "which";

import { execCommand, spawnProcess } from "../utils/spawn.js";
import { terminateWithTreeKill } from "../utils/tree-kill.js";

export const COMPUTER_USE_SUPPORTED = process.platform === "win32";

export const CUA_INSTALL_SCRIPT_URL = "https://cua.ai/driver/install.ps1";

const MANIFEST_TIMEOUT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const INSTALL_OUTPUT_MAX_CHARS = 4000;

export interface DriverProbe {
  installed: boolean;
  path?: string;
  version?: string;
  /** manifest 读取失败等原因；未安装不是错误 */
  error?: string;
  /** MCP 启动方式（`mcp_invocation`，缺失时 `<path> mcp`） */
  command?: string;
  args?: string[];
}

/**
 * 候选路径：PATH 上的 cua-driver.exe → 官方安装脚本的落点 → 安装目录里的 current 联接。
 * 每次都重新查找：GUI 拉起的 sidecar 的 PATH 不含安装脚本刚写进用户 PATH 的目录。
 */
export function driverCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];
  const onPath = which.sync("cua-driver.exe", { nothrow: true, path: env.PATH ?? env.Path ?? "" });
  if (onPath) {
    candidates.push(onPath);
  }
  if (env.LOCALAPPDATA) {
    candidates.push(path.join(env.LOCALAPPDATA, "Programs", "Cua", "cua-driver", "bin", "cua-driver.exe"));
  }
  if (env.USERPROFILE) {
    candidates.push(path.join(env.USERPROFILE, ".cua-driver", "packages", "current", "cua-driver.exe"));
  }
  return candidates;
}

export function locateDriver(
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = existsSync,
): string | null {
  if (!COMPUTER_USE_SUPPORTED) {
    return null;
  }
  return driverCandidates(env).find((candidate) => exists(candidate)) ?? null;
}

/** 解析 `cua-driver manifest` 的输出；字段缺失时回退 `<binary> mcp` */
export function parseManifest(
  binary: string,
  stdout: string,
): Pick<DriverProbe, "version" | "command" | "args"> {
  const manifest = JSON.parse(stdout) as {
    binary_version?: unknown;
    mcp_invocation?: { command?: unknown; args?: unknown };
  };
  const version = typeof manifest.binary_version === "string" ? manifest.binary_version : undefined;
  const invocation = manifest.mcp_invocation;
  const command = typeof invocation?.command === "string" && invocation.command ? invocation.command : binary;
  const args =
    Array.isArray(invocation?.args) && invocation.args.every((arg) => typeof arg === "string")
      ? (invocation.args as string[])
      : ["mcp"];
  return { ...(version ? { version } : {}), command, args };
}

export async function probeDriver(): Promise<DriverProbe> {
  const binary = locateDriver();
  if (!binary) {
    return { installed: false };
  }
  try {
    const { stdout } = await execCommand(binary, ["manifest"], {
      timeout: MANIFEST_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    return { installed: true, path: binary, ...parseManifest(binary, stdout) };
  } catch (error) {
    return {
      installed: true,
      path: binary,
      command: binary,
      args: ["mcp"],
      error: `读取驱动 manifest 失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** 将要执行的安装命令（只描述不执行）：PATH 上有 pwsh 用它，否则用系统自带的 Windows PowerShell */
export function installCommand(env: NodeJS.ProcessEnv = process.env): ComputerUseInstallCommand {
  const pwsh = which.sync("pwsh.exe", { nothrow: true, path: env.PATH ?? env.Path ?? "" });
  const program =
    pwsh ??
    path.join(env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `irm ${CUA_INSTALL_SCRIPT_URL} | iex`;
  const args = ["-NoProfile", "-Command", script];
  return {
    program,
    args,
    display: `${pwsh ? "pwsh" : "powershell"} -NoProfile -Command "${script}"`,
    sourceUrl: CUA_INSTALL_SCRIPT_URL,
  };
}

function tailChars(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(-max)}`;
}

let installing = false;

/**
 * 执行官方安装脚本：输出逐行回调，15 分钟超时结束整棵进程树；同时只允许一个安装。
 * 上游脚本默认注册开机自启计划任务（RunLevel=Highest），会弹 UAC，属预期。
 */
export async function runInstall(
  onLine: (stream: "stdout" | "stderr", line: string) => void,
): Promise<ComputerUseInstallResult> {
  if (installing) {
    return { ok: false, exitCode: null, output: "已有安装任务在进行" };
  }
  installing = true;
  try {
    const command = installCommand();
    const child = spawnProcess(command.program, command.args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const lines: string[] = [];
    const pump = (stream: "stdout" | "stderr", source: NodeJS.ReadableStream | null) => {
      if (!source) {
        return;
      }
      createInterface({ input: source }).on("line", (line) => {
        lines.push(line);
        onLine(stream, line);
      });
    };
    pump("stdout", child.stdout);
    pump("stderr", child.stderr);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateWithTreeKill(child, { gracefulTimeoutMs: 2000, forceTimeoutMs: 2000 });
    }, INSTALL_TIMEOUT_MS);
    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("error", (error) => {
        lines.push(`无法启动安装命令：${error.message}`);
        resolve(null);
      });
      child.once("close", (code) => resolve(code));
    }).finally(() => clearTimeout(timer));

    if (timedOut) {
      lines.push(`安装超时（超过 ${INSTALL_TIMEOUT_MS / 60_000} 分钟），已终止`);
    }
    return {
      ok: !timedOut && exitCode === 0,
      exitCode,
      output: tailChars(lines.join("\n"), INSTALL_OUTPUT_MAX_CHARS),
    };
  } finally {
    installing = false;
  }
}
