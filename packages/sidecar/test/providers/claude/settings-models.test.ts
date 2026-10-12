import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentModelDefinition } from "@agentdeck/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  claudeUserSettingsPath,
  readClaudeUserSettings,
  settingsCurrentModel,
  settingsModelIds,
  settingsModelLabel,
  withSettingsModels,
} from "../../../src/providers/claude/settings-models.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "agentdeck-settings-models-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readClaudeUserSettings", () => {
  test("路径：CLAUDE_CONFIG_DIR 优先，未设置（或空白）时 ~/.claude", () => {
    expect(claudeUserSettingsPath({ CLAUDE_CONFIG_DIR: dir })).toBe(path.join(dir, "settings.json"));
    const fallback = path.join(os.homedir(), ".claude", "settings.json");
    expect(claudeUserSettingsPath({})).toBe(fallback);
    expect(claudeUserSettingsPath({ CLAUDE_CONFIG_DIR: "  " })).toBe(fallback);
  });

  test("允许 BOM；文件不存在、非法 JSON、非对象时返回 null；不修改文件", async () => {
    const file = path.join(dir, "settings.json");
    await expect(readClaudeUserSettings({ CLAUDE_CONFIG_DIR: dir })).resolves.toBeNull();

    const text = `\uFEFF${JSON.stringify({ model: "opus[1m]" })}`;
    writeFileSync(file, text);
    await expect(readClaudeUserSettings({ CLAUDE_CONFIG_DIR: dir })).resolves.toEqual({ model: "opus[1m]" });
    expect(readFileSync(file, "utf8")).toBe(text);

    writeFileSync(file, "{oops");
    await expect(readClaudeUserSettings({ CLAUDE_CONFIG_DIR: dir })).resolves.toBeNull();
    writeFileSync(file, "[1,2]");
    await expect(readClaudeUserSettings({ CLAUDE_CONFIG_DIR: dir })).resolves.toBeNull();
  });
});

describe("设置中的模型", () => {
  test("顶层 model 在前，再按 env 变量顺序；去空白、去重、忽略非字符串", () => {
    expect(
      settingsModelIds({
        model: " opus[1m] ",
        env: {
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku-x",
          ANTHROPIC_MODEL: "opus[1m]",
          ANTHROPIC_SMALL_FAST_MODEL: 3,
          ANTHROPIC_DEFAULT_OPUS_MODEL: "",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-4.6",
          OTHER: "ignored",
        },
      }),
    ).toEqual([
      { id: "opus[1m]", source: "model" },
      { id: "glm-4.6", source: "env.ANTHROPIC_DEFAULT_SONNET_MODEL" },
      { id: "haiku-x", source: "env.ANTHROPIC_DEFAULT_HAIKU_MODEL" },
    ]);
    expect(settingsModelIds({ env: "x" })).toEqual([]);
  });

  test("当前生效模型：env.ANTHROPIC_MODEL 优先于顶层 model", () => {
    expect(settingsCurrentModel({ model: "opus[1m]" })).toBe("opus[1m]");
    expect(settingsCurrentModel({ model: "opus", env: { ANTHROPIC_MODEL: "sonnet[1m]" } })).toBe("sonnet[1m]");
    expect(settingsCurrentModel({})).toBeNull();
  });

  test("显示名：[1m] 后缀追加「· 1M 上下文」，其它原样", () => {
    expect(settingsModelLabel("opus[1m]")).toBe("Opus · 1M 上下文");
    expect(settingsModelLabel("sonnet[1m]")).toBe("Sonnet · 1M 上下文");
    expect(settingsModelLabel("claude-opus-4-5[1m]")).toBe("claude-opus-4-5 · 1M 上下文");
    expect(settingsModelLabel("glm-4.6")).toBe("glm-4.6");
  });

  test("withSettingsModels：已有 id 不重复追加，不修改入参", () => {
    const base: AgentModelDefinition[] = [
      { provider: "p", id: "default", label: "默认", description: "旧描述", isDefault: true },
      { provider: "p", id: "opus", label: "Opus" },
    ];
    const merged = withSettingsModels(base, { model: "opus", env: { ANTHROPIC_MODEL: "opus[1m]" } }, "p");
    expect(merged.map((m) => [m.id, m.label, m.description])).toEqual([
      ["default", "默认", "跟随 Claude Code 设置（当前：opus[1m]）"],
      ["opus", "Opus", undefined],
      ["opus[1m]", "Opus · 1M 上下文", "来自 Claude Code 设置（env.ANTHROPIC_MODEL）"],
    ]);
    expect(base[0]!.description).toBe("旧描述");
    expect(withSettingsModels(base, null, "p").map((m) => m.description)).toEqual([
      "跟随 Claude Code 设置",
      undefined,
    ]);
  });
});
