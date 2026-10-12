import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  codexNativeCandidates,
  parseNpmCmdShimTarget,
  resolveCodexLaunch,
} from "../../../src/providers/codex/launch.js";

// npm 为 @openai/codex 生成的 codex.cmd（取自本机）
const NPM_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`;

let root: string;

function touch(file: string, content = ""): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "agentdeck-codex-launch-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const winOpts = { platform: "win32" as const, arch: "x64", nodePath: "C:\\node\\node.exe" };

describe("parseNpmCmdShimTarget", () => {
  test("解析出 codex.js 绝对路径", () => {
    expect(parseNpmCmdShimTarget("C:\\npm\\codex.cmd", NPM_SHIM)).toBe(
      "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
    );
    expect(parseNpmCmdShimTarget("C:\\npm\\codex.cmd", "@echo off\necho hi")).toBeNull();
  });

  test("原生 exe 候选：嵌套平台包、提升后的平台包、旧 vendor", () => {
    expect(
      codexNativeCandidates("C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js", "win32", "x64"),
    ).toEqual([
      "C:\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe",
      "C:\\npm\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe",
      "C:\\npm\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe",
    ]);
    expect(codexNativeCandidates("/x/codex.js", "linux", "x64")).toEqual([]);
  });
});

describe.skipIf(process.platform !== "win32")("resolveCodexLaunch（Windows 文件布局）", () => {
  test("AGENTDECK_CODEX_PATH 优先", () => {
    const exe = touch(path.join(root, "custom", "codex.exe"));
    const other = path.join(root, "bin");
    touch(path.join(other, "codex.exe"));
    expect(resolveCodexLaunch({ ...winOpts, env: { AGENTDECK_CODEX_PATH: exe, PATH: other } })).toEqual({
      command: exe,
      args: [],
      source: "env",
    });
  });

  test("AGENTDECK_CODEX_PATH 不存在时告警并继续查找 PATH", () => {
    const bin = path.join(root, "bin");
    const exe = touch(path.join(bin, "codex.exe"));
    const warnings: string[] = [];
    const launch = resolveCodexLaunch({
      ...winOpts,
      env: { AGENTDECK_CODEX_PATH: path.join(root, "missing.exe"), Path: bin },
      onWarning: (m) => warnings.push(m),
    });
    expect(launch).toEqual({ command: exe, args: [], source: "path" });
    expect(warnings[0]).toContain("AGENTDECK_CODEX_PATH");
  });

  test("npm shim → 平台包里的原生 codex.exe（带 CODEX_MANAGED_* 环境变量）", () => {
    const npm = path.join(root, "npm");
    touch(path.join(npm, "codex.cmd"), NPM_SHIM);
    const pkgRoot = path.join(npm, "node_modules", "@openai", "codex");
    touch(path.join(pkgRoot, "bin", "codex.js"));
    const native = touch(
      path.join(pkgRoot, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
    );
    const launch = resolveCodexLaunch({ ...winOpts, env: { PATH: npm } });
    expect(launch).toMatchObject({ command: native, args: [], source: "npm-shim-native" });
    expect(launch?.envOverlay?.CODEX_MANAGED_BY_NPM).toBe("1");
    expect(launch?.envOverlay?.CODEX_MANAGED_PACKAGE_ROOT?.toLowerCase()).toBe(pkgRoot.toLowerCase());
  });

  test("npm shim 找不到原生 exe 时用当前 node 执行 codex.js", () => {
    const npm = path.join(root, "npm");
    touch(path.join(npm, "codex.cmd"), NPM_SHIM);
    const codexJs = touch(path.join(npm, "node_modules", "@openai", "codex", "bin", "codex.js"));
    expect(resolveCodexLaunch({ ...winOpts, env: { PATH: npm } })).toEqual({
      command: "C:\\node\\node.exe",
      args: [codexJs],
      source: "npm-shim-js",
    });
  });

  test("PATH 之外兜底 %APPDATA%\\npm\\codex.cmd", () => {
    const appData = path.join(root, "AppData");
    const npm = path.join(appData, "npm");
    touch(path.join(npm, "codex.cmd"), NPM_SHIM);
    const codexJs = touch(path.join(npm, "node_modules", "@openai", "codex", "bin", "codex.js"));
    expect(resolveCodexLaunch({ ...winOpts, env: { PATH: path.join(root, "empty"), APPDATA: appData } })).toMatchObject({
      args: [codexJs],
      source: "npm-shim-js",
    });
  });

  test("AGENTDECK_CODEX_PATH 指向 codex.js 时用 node 执行", () => {
    const codexJs = touch(path.join(root, "pkg", "bin", "codex.js"));
    expect(resolveCodexLaunch({ ...winOpts, env: { AGENTDECK_CODEX_PATH: codexJs } })).toEqual({
      command: "C:\\node\\node.exe",
      args: [codexJs],
      source: "env",
    });
  });

  test("PATH 中位于 node_modules 内的目录（如 pnpm 注入的 node_modules/.bin）被跳过", () => {
    const localBin = path.join(root, "repo", "node_modules", ".bin");
    touch(path.join(localBin, "codex.exe"));
    touch(path.join(localBin, "codex.cmd"), NPM_SHIM);
    touch(path.join(localBin, "node_modules", "@openai", "codex", "bin", "codex.js"));
    expect(resolveCodexLaunch({ ...winOpts, env: { PATH: localBin } })).toBeNull();

    const globalBin = path.join(root, "global");
    const exe = touch(path.join(globalBin, "codex.exe"));
    expect(resolveCodexLaunch({ ...winOpts, env: { PATH: [localBin, globalBin].join(";") } })).toEqual({
      command: exe,
      args: [],
      source: "path",
    });
  });

  test("都找不到时返回 null", () => {
    expect(resolveCodexLaunch({ ...winOpts, env: { PATH: path.join(root, "empty") } })).toBeNull();
  });
});
