// Derived from paseo packages/server/src/server/agent/providers/claude/models.ts (Apache-2.0); modified for AgentDeck
// 「Claude settings.json model discovery」：把 Claude 设置里的具体模型 id（顶层 model 与 env 中的模型变量）
// 追加到模型列表末尾（去重、原样保留，如 `opus[1m]`），并让「默认模型」写明当前实际生效的模型。
// AgentDeck 改动：设置来源可注入（内置读用户 settings.json，中转用自身合并后的 --settings）；
// `[1m]` 后缀的显示名追加「· 1M 上下文」；只读，绝不写回设置文件。
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentModelDefinition } from "@agentdeck/protocol";

/** settings.env 中会被当作模型 id 的变量 */
export const CLAUDE_SETTINGS_MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const;

const DEFAULT_MODEL_DESCRIPTION = "跟随 Claude Code 设置";
const ONE_M_SUFFIX = "[1m]";
const ALIAS_LABELS: Record<string, string> = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  fable: "Fable",
};

/** 用户 Claude 设置文件：`$CLAUDE_CONFIG_DIR/settings.json`，未设置时 `~/.claude/settings.json` */
export function claudeUserSettingsPath(env: NodeJS.ProcessEnv): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return path.join(configDir || path.join(os.homedir(), ".claude"), "settings.json");
}

/** 读取用户 Claude 设置（允许 BOM）；不存在、读不了或不是 JSON 对象时返回 null */
export async function readClaudeUserSettings(
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(claudeUserSettingsPath(env), "utf8");
    const data: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    return isRecord(data) ? data : null;
  } catch {
    return null;
  }
}

/** 设置里的模型 id 及来源（顶层 model 在前，再按 env 变量顺序；去重） */
export function settingsModelIds(settings: Record<string, unknown>): { id: string; source: string }[] {
  const entries: { id: string; source: string }[] = [];
  const add = (value: unknown, source: string) => {
    const id = typeof value === "string" ? value.trim() : "";
    if (id && !entries.some((entry) => entry.id === id)) {
      entries.push({ id, source });
    }
  };
  add(settings.model, "model");
  const env = isRecord(settings.env) ? settings.env : {};
  for (const key of CLAUDE_SETTINGS_MODEL_ENV_KEYS) {
    add(env[key], `env.${key}`);
  }
  return entries;
}

/** 不传 --model 时实际生效的模型：settings.env.ANTHROPIC_MODEL 优先于顶层 model */
export function settingsCurrentModel(settings: Record<string, unknown>): string | null {
  const env = isRecord(settings.env) ? settings.env : {};
  for (const value of [env.ANTHROPIC_MODEL, settings.model]) {
    const id = typeof value === "string" ? value.trim() : "";
    if (id) return id;
  }
  return null;
}

/** 显示名：`opus[1m]` → 「Opus · 1M 上下文」；其它 id 原样显示 */
export function settingsModelLabel(id: string): string {
  if (!id.toLowerCase().endsWith(ONE_M_SUFFIX)) {
    return id;
  }
  const base = id.slice(0, -ONE_M_SUFFIX.length);
  return `${ALIAS_LABELS[base.toLowerCase()] ?? base} · 1M 上下文`;
}

/**
 * 在模型列表后追加设置里的模型（已存在的 id 跳过），并把 `default` 的描述改为当前生效的模型。
 * settings 为 null 表示读不到设置。不修改入参。
 */
export function withSettingsModels(
  models: readonly AgentModelDefinition[],
  settings: Record<string, unknown> | null,
  providerId: string,
): AgentModelDefinition[] {
  const current = settings ? settingsCurrentModel(settings) : null;
  const result = models.map((model) =>
    model.id === "default"
      ? {
          ...model,
          description: current
            ? `${DEFAULT_MODEL_DESCRIPTION}（当前：${current}）`
            : DEFAULT_MODEL_DESCRIPTION,
        }
      : { ...model },
  );
  if (!settings) {
    return result;
  }
  for (const { id, source } of settingsModelIds(settings)) {
    if (result.some((model) => model.id === id)) {
      continue;
    }
    result.push({
      provider: providerId,
      id,
      label: settingsModelLabel(id),
      description: `来自 Claude Code 设置（${source}）`,
    });
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
