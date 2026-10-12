// Derived from paseo packages/server/src/utils/spawn.ts (Apache-2.0); modified for AgentDeck
// 改动：env 处理改用本地 process-env.ts（剔除 AGENTDECK_* 内部变量），不依赖 paseo-env。
import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { extname } from "node:path";
import { promisify } from "node:util";

import { createExternalCommandProcessEnv, type ProcessEnvRecord } from "./process-env.js";
import {
  isWindowsCommandScript,
  quoteWindowsArgument,
  quoteWindowsCommand,
} from "./windows-command.js";

const execFileAsync = promisify(execFile);

interface ExternalEnvOptions {
  baseEnv?: ProcessEnvRecord;
  envMode?: "external" | "internal";
  env?: ProcessEnvRecord;
  envOverlay?: ProcessEnvRecord;
}

export type SpawnProcessOptions = Omit<SpawnOptions, "env"> & ExternalEnvOptions;

interface ExecCommandOptions extends ExternalEnvOptions {
  cwd?: string;
  encoding?: BufferEncoding;
  killSignal?: NodeJS.Signals;
  timeout?: number;
  maxBuffer?: number;
  shell?: boolean | string;
  signal?: AbortSignal;
}

interface ExecCommandResult {
  stdout: string;
  stderr: string;
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function shouldUseWindowsShell(
  command: string,
  requestedShell?: boolean | string,
): boolean | string {
  if (isWindowsCommandScript(command)) {
    return true;
  }
  if (requestedShell !== undefined) {
    return requestedShell;
  }
  return process.platform === "win32" && !hasPathSeparator(command) && !extname(command);
}

/**
 * 走 shell 时自己把命令与参数拼成单个命令串、args 传空数组：与 Node 内部的拼接方式一致，
 * 但避免 `shell:true` + args 数组触发 DEP0190 警告。Windows 下按 cmd 规则转义（windows-command.ts）。
 */
function resolveShellInvocation(
  command: string,
  args: string[],
  shell: boolean | string,
): [string, string[]] {
  if (shell === false) {
    return [command, args];
  }
  if (process.platform === "win32") {
    return [[quoteWindowsCommand(command), ...args.map(quoteWindowsArgument)].join(" "), []];
  }
  return [[command, ...args].join(" "), []];
}

export function spawnProcess(
  command: string,
  args: string[],
  options?: SpawnProcessOptions,
): ChildProcess {
  const { baseEnv, env, envOverlay, ...spawnOptions } = options ?? {};
  const resolvedBaseEnv = env ?? baseEnv ?? process.env;
  const shell = shouldUseWindowsShell(command, spawnOptions.shell);
  const [resolvedCommand, resolvedArgs] = resolveShellInvocation(command, args, shell);
  const childEnv =
    options?.envMode === "internal"
      ? ({ ...resolvedBaseEnv, ...envOverlay } as NodeJS.ProcessEnv)
      : createExternalCommandProcessEnv(
          command,
          resolvedBaseEnv,
          ...(envOverlay ? [envOverlay] : []),
        );

  return spawn(resolvedCommand, resolvedArgs, {
    ...spawnOptions,
    env: childEnv,
    shell,
    signal: options?.signal,
    windowsHide: true,
  });
}

export async function execCommand(
  command: string,
  args: string[],
  options?: ExecCommandOptions,
): Promise<ExecCommandResult> {
  const { baseEnv, env, envOverlay } = options ?? {};
  const resolvedBaseEnv = env ?? baseEnv ?? process.env;
  const shell = shouldUseWindowsShell(command, options?.shell);
  const [resolvedCommand, resolvedArgs] = resolveShellInvocation(command, args, shell);
  const childEnv =
    options?.envMode === "internal"
      ? ({ ...resolvedBaseEnv, ...envOverlay } as NodeJS.ProcessEnv)
      : createExternalCommandProcessEnv(
          command,
          resolvedBaseEnv,
          ...(envOverlay ? [envOverlay] : []),
        );

  return execFileAsync(resolvedCommand, resolvedArgs, {
    cwd: options?.cwd,
    env: childEnv,
    encoding: options?.encoding ?? "utf8",
    killSignal: options?.killSignal,
    timeout: options?.timeout,
    maxBuffer: options?.maxBuffer,
    shell,
    windowsHide: true,
  }) as Promise<ExecCommandResult>;
}
