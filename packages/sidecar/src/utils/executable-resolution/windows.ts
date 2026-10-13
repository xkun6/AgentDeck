// Derived from paseo packages/server/src/executable-resolution/windows.ts (Apache-2.0); modified for AgentDeck
import { readdirSync } from "node:fs";
import { extname, join } from "node:path";

interface WindowsFindExecutableOptions {
  enumeratePathCandidates: (name: string) => Promise<string[]>;
  probeExecutable: (executablePath: string, timeoutMs: number) => Promise<boolean>;
  exists: (path: string) => boolean;
  localAppData?: string;
  probeTimeoutMs: number;
}

interface WindowsExecutableExistsOptions {
  exists: (path: string) => boolean;
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function enumerateLiteralPathCandidates(executablePath: string): string[] {
  if (extname(executablePath)) {
    return [executablePath];
  }
  return [executablePath, `${executablePath}.exe`, `${executablePath}.cmd`];
}

function enumerateWingetPackageCandidates(
  name: string,
  localAppData: string | undefined,
): string[] {
  if (!localAppData) {
    return [];
  }

  const wingetPackages = join(localAppData, "Microsoft", "WinGet", "Packages");
  let packageDirs: string[];
  try {
    packageDirs = readdirSync(wingetPackages, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const exeName = `${name}.exe`;
  return packageDirs.map((packageDir) => join(wingetPackages, packageDir, exeName));
}

/**
 * PATH 命中 `.cmd` / `.bat` 且同目录有同名 `.exe` 时，把 `.exe` 排在它前面：能直接 spawn 真实 exe（shell:false）
 * 就不经 cmd.exe，且不受 PATHEXT 顺序影响（如 DeepSeek Harness 的 bin 目录同时有 dsh.exe 与 dsh.cmd）。
 */
function preferSiblingExe(candidates: string[], exists: (path: string) => boolean): string[] {
  return candidates.flatMap((candidate) => {
    const extension = extname(candidate);
    const lower = extension.toLowerCase();
    if (lower !== ".cmd" && lower !== ".bat") {
      return [candidate];
    }
    const exe = `${candidate.slice(0, -extension.length)}.exe`;
    return exists(exe) ? [exe, candidate] : [candidate];
  });
}

async function find(input: string, options: WindowsFindExecutableOptions): Promise<string | null> {
  if (hasPathSeparator(input)) {
    return findFirstProbeable(enumerateLiteralPathCandidates(input), options);
  }

  const pathCandidates = preferSiblingExe(
    await options.enumeratePathCandidates(input),
    options.exists,
  );
  const wingetCandidates = enumerateWingetPackageCandidates(
    input,
    options.localAppData ?? process.env.LOCALAPPDATA,
  ).filter(options.exists);

  return findFirstProbeable([...pathCandidates, ...wingetCandidates], options);
}

async function findFirstProbeable(
  candidates: string[],
  options: WindowsFindExecutableOptions,
): Promise<string | null> {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    if (!options.exists(candidate)) {
      continue;
    }
    if (await options.probeExecutable(candidate, options.probeTimeoutMs)) {
      return candidate;
    }
  }
  return null;
}

function exists(executablePath: string, options: WindowsExecutableExistsOptions): string | null {
  for (const candidate of enumerateLiteralPathCandidates(executablePath)) {
    if (options.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

export const windowsExecutableResolution = {
  exists,
  find,
};
