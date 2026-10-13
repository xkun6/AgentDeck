// providers.json：校验（id 规则 / 重复 / 内置冲突 / acp 缺 command / URL 非法）、原子写入、损坏文件容错。
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ProviderProfile } from "@agentdeck/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { Logger } from "../../../src/logger.js";
import {
  createProviderProfilesSchema,
  loadProviderProfiles,
  providerProfileSchema,
  providersConfigPath,
  reservedProfileIds,
  saveProviderProfiles,
  toProviderProfile,
} from "../../../src/providers/custom/index.js";
import { formatIssues } from "../../../src/providers/custom/schema.js";

const RESERVED = reservedProfileIds(["claude", "codex", "mock", "acp:dsh"]);

function issuesOf(input: unknown, reserved: ReadonlySet<string> = RESERVED) {
  const result = createProviderProfilesSchema(reserved).safeParse(input);
  return result.success ? [] : formatIssues(result.error.issues, ["providers"]);
}

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const push = (message: string, ...args: unknown[]) =>
    lines.push([message, ...args.map(String)].join(" | "));
  return { lines, debug: push, info: push, warn: push, error: push, close: () => undefined };
}

describe("profile 校验", () => {
  test("合法 profile：去掉 baseUrl 末尾斜杠，空字符串字段视为未填写", () => {
    const parsed = providerProfileSchema.parse({
      id: "my-relay-1",
      extends: "claude",
      label: " 我的中转 ",
      baseUrl: " https://relay.example.com/api/// ",
      apiKey: "",
      description: "",
      models: [{ id: "m1", label: "M1", isDefault: true }],
    });
    expect(toProviderProfile(parsed)).toEqual({
      id: "my-relay-1",
      extends: "claude",
      label: "我的中转",
      baseUrl: "https://relay.example.com/api",
      models: [{ id: "m1", label: "M1", isDefault: true }],
    });
  });

  test.each([
    ["大写字母", "MyRelay"],
    ["数字开头", "1relay"],
    ["下划线", "my_relay"],
    ["冒号", "custom:x"],
    ["超过 32 位", `a${"b".repeat(32)}`],
    ["空串", ""],
  ])("id 规则：%s 不合法", (_name, id) => {
    expect(issuesOf([{ id, extends: "claude", label: "x" }])).toEqual([
      expect.objectContaining({ path: "providers.0.id" }),
    ]);
  });

  test("id 恰好 32 位合法", () => {
    expect(issuesOf([{ id: `a${"b".repeat(31)}`, extends: "codex", label: "x" }])).toEqual([]);
  });

  test("id 重复与内置冲突（含 ACP 内置条目名）都是校验失败", () => {
    const issues = issuesOf([
      { id: "dup", extends: "claude", label: "a" },
      { id: "dup", extends: "codex", label: "b" },
      { id: "claude", extends: "claude", label: "c" },
      { id: "dsh", extends: "acp", label: "d", command: ["dsh"] },
      { id: "custom", extends: "codex", label: "e" },
    ]);
    expect(issues).toEqual(
      expect.arrayContaining([
        { path: "providers.1.id", message: "id「dup」重复" },
        { path: "providers.2.id", message: "id「claude」与内置 provider 冲突" },
        { path: "providers.3.id", message: "id「dsh」与内置 provider 冲突" },
        { path: "providers.4.id", message: "id「custom」与内置 provider 冲突" },
      ]),
    );
    expect(issues).toHaveLength(4);
  });

  test("acp 缺 command / command 为空数组", () => {
    expect(issuesOf([{ id: "a", extends: "acp", label: "x" }])).toEqual([
      { path: "providers.0.command", message: "ACP provider 必须填写启动命令" },
    ]);
    expect(issuesOf([{ id: "a", extends: "acp", label: "x", command: [] }])).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "providers.0.command" })]),
    );
  });

  test.each(["ftp://relay.example.com", "relay.example.com", "http://", "not a url"])(
    "URL 非法：%s",
    (baseUrl) => {
      expect(issuesOf([{ id: "a", extends: "claude", label: "x", baseUrl }])).toEqual([
        { path: "providers.0.baseUrl", message: "接口地址必须是 http:// 或 https:// 开头的 URL" },
      ]);
    },
  );

  test("label 1–40 字（按字符计），extends / authMode 枚举，env 键名", () => {
    expect(issuesOf([{ id: "a", extends: "claude", label: "中".repeat(40) }])).toEqual([]);
    expect(issuesOf([{ id: "a", extends: "claude", label: "中".repeat(41) }])).toEqual([
      { path: "providers.0.label", message: "名称最长 40 字" },
    ]);
    expect(issuesOf([{ id: "a", extends: "claude", label: "  " }])).toEqual([
      expect.objectContaining({ path: "providers.0.label" }),
    ]);
    expect(issuesOf([{ id: "a", extends: "gemini", label: "x" }])).toEqual([
      expect.objectContaining({ path: "providers.0.extends" }),
    ]);
    expect(issuesOf([{ id: "a", extends: "claude", label: "x", authMode: "bearer" }])).toEqual([
      expect.objectContaining({ path: "providers.0.authMode" }),
    ]);
    expect(
      issuesOf([{ id: "a", extends: "claude", label: "x", env: { "BAD-KEY": "v" } }]),
    ).toEqual([expect.objectContaining({ path: expect.stringContaining("providers.0.env") })]);
  });

  test("校验信息不回显字段值（apiKey 不会出现在 issues 里）", () => {
    const issues = issuesOf([
      { id: "BAD", extends: "claude", label: "x", apiKey: "sk-should-not-leak", baseUrl: "ftp://x" },
    ]);
    expect(JSON.stringify(issues)).not.toContain("sk-should-not-leak");
  });
});

describe("providers.json 读写", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "agentdeck-providers-"));
    file = providersConfigPath(path.join(dir, "data"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const profiles: ProviderProfile[] = [
    {
      id: "relay",
      extends: "claude",
      label: "中转",
      baseUrl: "https://relay.example.com",
      apiKey: "sk-test",
      authMode: "api_key",
      env: { API_TIMEOUT_MS: "3000000" },
      models: [{ id: "glm", label: "GLM", isDefault: true }],
      disallowedTools: ["WebSearch"],
    },
    { id: "kimi2", extends: "acp", label: "Kimi 2", command: ["kimi", "acp"], enabled: false },
  ];

  test("原子写入（不留临时文件）后能原样读回", async () => {
    await saveProviderProfiles(file, profiles);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, providers: profiles });
    expect(readdirSync(path.dirname(file))).toEqual(["providers.json"]);
    await expect(loadProviderProfiles(file, recordingLogger())).resolves.toEqual(profiles);

    // 再写一次覆盖
    await saveProviderProfiles(file, [profiles[1]!]);
    await expect(loadProviderProfiles(file, recordingLogger())).resolves.toEqual([profiles[1]]);
    expect(readdirSync(path.dirname(file))).toEqual(["providers.json"]);
  });

  test("文件不存在返回空表且不报错", async () => {
    const logger = recordingLogger();
    await expect(loadProviderProfiles(file, logger)).resolves.toEqual([]);
    expect(logger.lines).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  test.each([
    ["不是 JSON", "{ not json"],
    ["顶层不是对象", "[1,2]"],
    ["缺少 providers 数组", JSON.stringify({ version: 1 })],
  ])("损坏文件（%s）：返回空表并记日志，不抛错", async (_name, content) => {
    await saveProviderProfiles(file, []);
    writeFileSync(file, content);
    const logger = recordingLogger();
    await expect(loadProviderProfiles(file, logger)).resolves.toEqual([]);
    expect(logger.lines.length).toBeGreaterThan(0);
  });

  test("带 BOM 的文件可读", async () => {
    await saveProviderProfiles(file, profiles);
    writeFileSync(file, `\uFEFF${readFileSync(file, "utf8")}`);
    await expect(loadProviderProfiles(file, recordingLogger())).resolves.toEqual(profiles);
  });

  test("非法项 / 重复项 / 与内置冲突的项被跳过，其余保留；日志不含密钥", async () => {
    await saveProviderProfiles(file, []);
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        providers: [
          { id: "ok", extends: "codex", label: "OK", apiKey: "sk-ok" },
          { id: "BAD", extends: "claude", label: "x", apiKey: "sk-secret-in-bad-item" },
          { id: "ok", extends: "claude", label: "dup", apiKey: "sk-dup" },
          { id: "codex", extends: "codex", label: "conflict", apiKey: "sk-conflict" },
        ],
      }),
    );
    const logger = recordingLogger();
    const loaded = await loadProviderProfiles(file, logger, RESERVED);
    expect(loaded).toEqual([{ id: "ok", extends: "codex", label: "OK", apiKey: "sk-ok" }]);
    expect(logger.lines).toHaveLength(3);
    expect(logger.lines.join("\n")).not.toMatch(/sk-/);
  });
});
