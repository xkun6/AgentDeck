import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  parseNpmCmdShim,
  resolveClaudeExecutable,
  type ClaudeExecutableDeps,
} from "../../../src/providers/claude/claude-executable.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "agentdeck-claude-exe-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function touch(...segments: string[]): string {
  const file = path.join(root, ...segments);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "");
  return file;
}

function writeShim(dir: string, body: string): string {
  const shim = path.join(root, dir, "claude.cmd");
  mkdirSync(path.dirname(shim), { recursive: true });
  writeFileSync(shim, body);
  return shim;
}

const NPM_EXE_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
].join("\r\n");

const NPM_JS_SHIM = [
  "@ECHO off",
  "SETLOCAL",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  ")",
  '"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
].join("\r\n");

function makeDeps(overrides: Partial<ClaudeExecutableDeps> & { good?: string[] } = {}) {
  const probed: string[] = [];
  const good = new Set(overrides.good ?? []);
  const deps: ClaudeExecutableDeps = {
    env: {},
    platform: "win32",
    arch: "x64",
    exists: existsSync,
    readFile: (file) => readFileSync(file, "utf8"),
    resolveSdkBinary: () => null,
    probe: async (file) => {
      probed.push(file);
      return good.has(file) ? "2.1.296 (Claude Code)" : null;
    },
    ...overrides,
  };
  return { deps, probed };
}

describe("resolveClaudeExecutable", () => {
  test("AGENTDECK_CLAUDE_PATH 优先", async () => {
    const exe = touch("custom", "claude.exe");
    const onPath = touch("bin", "claude.exe");
    const { deps } = makeDeps({
      env: { AGENTDECK_CLAUDE_PATH: exe, PATH: path.join(root, "bin") },
      good: [exe, onPath],
    });
    await expect(resolveClaudeExecutable(deps)).resolves.toEqual({
      available: true,
      path: exe,
      source: "env",
      version: "2.1.296 (Claude Code)",
    });
  });

  test("AGENTDECK_CLAUDE_PATH 指向 .cmd shim 时解析出真实 exe", async () => {
    const shim = writeShim("npm", NPM_EXE_SHIM);
    const exe = touch("npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    const { deps } = makeDeps({ env: { AGENTDECK_CLAUDE_PATH: shim }, good: [exe] });
    const result = await resolveClaudeExecutable(deps);
    expect(result).toMatchObject({ available: true, path: exe, source: "env" });
  });

  test("AGENTDECK_CLAUDE_PATH 无效时告警并继续查找 PATH", async () => {
    const onPath = touch("bin", "claude.exe");
    const warnings: string[] = [];
    const { deps } = makeDeps({
      env: { AGENTDECK_CLAUDE_PATH: path.join(root, "missing.exe"), Path: path.join(root, "bin") },
      good: [onPath],
      warn: (message) => warnings.push(message),
    });
    const result = await resolveClaudeExecutable(deps);
    expect(result).toMatchObject({ available: true, path: onPath, source: "path" });
    expect(warnings).toHaveLength(1);
  });

  test("PATH 上的 claude.exe 优先于 npm shim", async () => {
    writeShim("npm", NPM_EXE_SHIM);
    const shimExe = touch("npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    const onPath = touch("bin", "claude.exe");
    const { deps } = makeDeps({
      env: { PATH: [path.join(root, "npm"), path.join(root, "bin")].join(";") },
      good: [onPath, shimExe],
    });
    const result = await resolveClaudeExecutable(deps);
    expect(result).toMatchObject({ available: true, path: onPath, source: "path" });
  });

  test("只有 npm claude.cmd shim 时解析出背后的 exe（绝不返回 .cmd）", async () => {
    writeShim("npm", NPM_EXE_SHIM);
    const exe = touch("npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    const { deps } = makeDeps({ env: { PATH: path.join(root, "npm") }, good: [exe] });
    const result = await resolveClaudeExecutable(deps);
    expect(result).toMatchObject({ available: true, path: exe, source: "npm-shim" });
  });

  test("--version 校验失败的候选被跳过，退回 SDK 自带平台包", async () => {
    const broken = touch("bin", "claude.exe");
    const bundled = touch("sdk", "claude.exe");
    const { deps, probed } = makeDeps({
      env: { PATH: path.join(root, "bin") },
      good: [bundled],
      resolveSdkBinary: (platform, arch) =>
        platform === "win32" && arch === "x64" ? bundled : null,
    });
    const result = await resolveClaudeExecutable(deps);
    expect(result).toMatchObject({ available: true, path: bundled, source: "sdk-bundled" });
    expect(probed).toEqual([broken, bundled]);
  });

  test("全部找不到时返回中文原因", async () => {
    const { deps } = makeDeps({ env: { PATH: path.join(root, "empty") } });
    const result = await resolveClaudeExecutable(deps);
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toContain("未找到 Claude Code");
      expect(result.reason).toContain("AGENTDECK_CLAUDE_PATH");
    }
  });

  test.skipIf(process.platform === "win32")("非 Windows 查找无扩展名的 claude，且不解析 .cmd", async () => {
    writeShim("npm", NPM_EXE_SHIM);
    touch("npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    const bin = touch("bin", "claude");
    const { deps } = makeDeps({
      platform: "linux",
      env: { PATH: [path.join(root, "npm"), path.join(root, "bin")].join(":") },
      good: [bin],
    });
    const result = await resolveClaudeExecutable(deps);
    expect(result).toMatchObject({ available: true, path: bin, source: "path" });
  });
});

describe("parseNpmCmdShim", () => {
  const fsDeps = { exists: existsSync, readFile: (file: string) => readFileSync(file, "utf8") };

  test("新版 shim（直接调用 claude.exe）", () => {
    const shim = writeShim("npm", NPM_EXE_SHIM);
    const exe = touch("npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    expect(parseNpmCmdShim(shim, fsDeps)).toBe(exe);
  });

  test("旧版 shim（node + cli.js）解析出 cli.js", () => {
    const shim = writeShim("npm", NPM_JS_SHIM);
    const js = touch("npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    expect(parseNpmCmdShim(shim, fsDeps)).toBe(js);
  });

  test("shim 内容无法识别时按 npm 固定布局兜底", () => {
    const shim = writeShim("npm", "@ECHO off\r\nrem 自定义内容");
    const exe = touch("npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    expect(parseNpmCmdShim(shim, fsDeps)).toBe(exe);
  });

  test("目标不存在时返回 null", () => {
    const shim = writeShim("npm", NPM_EXE_SHIM);
    expect(parseNpmCmdShim(shim, fsDeps)).toBeNull();
  });
});
