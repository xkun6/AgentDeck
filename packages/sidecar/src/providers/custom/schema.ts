// 自定义 provider（providers.json）的 zod 校验（design.md 4.7）。
// 设计参考 paseo docs/custom-providers.md 的 provider 定义，字段按 AgentDeck 契约重写。
import {
  CUSTOM_PROVIDER_ID_PREFIX,
  type ProviderProfile,
} from "@agentdeck/protocol";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

export const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LABEL_MAX_CHARS = 40;

/** 无论内置 provider 如何变化都保留的 id */
const ALWAYS_RESERVED_IDS = ["claude", "codex", "acp", "mock", "custom"];

export function customProviderId(profileId: string): string {
  return `${CUSTOM_PROVIDER_ID_PREFIX}${profileId}`;
}

/**
 * 与内置 provider 冲突的 profile id：内置 id 本身（claude / codex / mock）以及 ACP 条目去掉 `acp:` 前缀后的名字
 * （内置 dsh 与 acp-agents.json 中的条目），外加固定保留字。
 */
export function reservedProfileIds(builtinProviderIds: Iterable<string>): Set<string> {
  const reserved = new Set(ALWAYS_RESERVED_IDS);
  for (const id of builtinProviderIds) {
    reserved.add(id.toLowerCase());
    const colon = id.indexOf(":");
    if (colon >= 0) {
      reserved.add(id.slice(colon + 1).toLowerCase());
    }
  }
  return reserved;
}

/** 表单里的空字符串视为未填写 */
const optionalText = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().optional(),
);

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

const baseUrlSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() || undefined : value),
  z
    .string()
    .refine(isHttpUrl, "接口地址必须是 http:// 或 https:// 开头的 URL")
    .transform((value) => value.replace(/\/+$/, ""))
    .optional(),
);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const settingsSchema = z
  .custom<Record<string, unknown>>(isPlainObject, "settings 必须是 JSON 对象")
  .optional();

const codexAuthSchema = z
  .custom<Record<string, unknown>>(isPlainObject, "auth.json 必须是 JSON 对象")
  .refine(
    (value) => value.OPENAI_API_KEY === undefined || typeof value.OPENAI_API_KEY === "string",
    "auth.json 的 OPENAI_API_KEY 必须是字符串",
  )
  .optional();

/** 解析 Codex config.toml 原文；语法错误抛出 Error（message 含行列位置）。日期类值转为字符串。 */
export function parseCodexConfigToml(text: string): Record<string, unknown> {
  return normalizeTomlValue(parseToml(text)) as Record<string, unknown>;
}

/** smol-toml 的日期类值（Date 子类）无法 JSON 序列化为 TOML 日期，统一转成字符串 */
function normalizeTomlValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeTomlValue);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeTomlValue(item)]));
  }
  return value;
}

const modelSchema = z.object({
  id: z.string().trim().min(1, "模型 id 不能为空"),
  label: z.string().trim().min(1, "模型名称不能为空"),
  description: optionalText,
  isDefault: z.boolean().optional(),
});

export const providerProfileSchema = z
  .object({
    id: z
      .string()
      .regex(PROFILE_ID_PATTERN, "id 须以小写字母开头，只含小写字母、数字和 -，最长 32 位"),
    extends: z.enum(["claude", "codex", "acp"], "extends 只能是 claude、codex 或 acp"),
    label: z
      .string()
      .trim()
      .min(1, "名称不能为空")
      .refine((value) => Array.from(value).length <= LABEL_MAX_CHARS, `名称最长 ${LABEL_MAX_CHARS} 字`),
    description: optionalText,
    enabled: z.boolean().optional(),
    baseUrl: baseUrlSchema,
    apiKey: optionalText,
    authMode: z.enum(["auth_token", "api_key"], "authMode 只能是 auth_token 或 api_key").optional(),
    env: z
      .record(z.string().regex(ENV_KEY_PATTERN, "环境变量名只能含字母、数字和下划线"), z.string())
      .optional(),
    command: z.array(z.string().trim().min(1, "命令参数不能为空")).optional(),
    models: z.array(modelSchema).optional(),
    disallowedTools: z.array(z.string().trim().min(1, "工具名不能为空")).optional(),
    settings: settingsSchema,
    codexConfig: optionalText,
    codexAuth: codexAuthSchema,
  })
  .superRefine((profile, ctx) => {
    if (profile.extends !== "claude" && profile.settings !== undefined) {
      ctx.addIssue({ code: "custom", path: ["settings"], message: "只有基于 Claude Code 的中转可以使用内联设置" });
    }
    const codexOnlyMessage = "只有基于 Codex 的中转可以使用 config.toml / auth.json";
    if (profile.extends !== "codex") {
      if (profile.codexConfig !== undefined) {
        ctx.addIssue({ code: "custom", path: ["codexConfig"], message: codexOnlyMessage });
      }
      if (profile.codexAuth !== undefined) {
        ctx.addIssue({ code: "custom", path: ["codexAuth"], message: codexOnlyMessage });
      }
    } else if (profile.codexConfig !== undefined) {
      let config: Record<string, unknown> | undefined;
      try {
        config = parseCodexConfigToml(profile.codexConfig);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ctx.addIssue({ code: "custom", path: ["codexConfig"], message: `config.toml 解析失败：${reason}` });
      }
      const modelProvider = config?.model_provider;
      if (typeof modelProvider === "string") {
        const providers = config?.model_providers;
        if (!isPlainObject(providers) || !isPlainObject(providers[modelProvider])) {
          ctx.addIssue({
            code: "custom",
            path: ["codexConfig"],
            message: `config.toml 的 model_provider「${modelProvider}」没有对应的 [model_providers.${modelProvider}]`,
          });
        }
      }
    }
    if (profile.extends === "acp" && (!profile.command || profile.command.length === 0)) {
      ctx.addIssue({ code: "custom", path: ["command"], message: "ACP provider 必须填写启动命令" });
    }
    if (profile.command && profile.command.length === 0) {
      ctx.addIssue({ code: "custom", path: ["command"], message: "启动命令不能为空数组" });
    }
  });

/** 整表校验：逐项校验 + id 不得重复、不得与内置 provider 冲突 */
export function createProviderProfilesSchema(reservedIds: ReadonlySet<string>) {
  return z.array(providerProfileSchema).superRefine((profiles, ctx) => {
    const seen = new Set<string>();
    profiles.forEach((profile, index) => {
      if (reservedIds.has(profile.id)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "id"],
          message: `id「${profile.id}」与内置 provider 冲突`,
        });
      }
      if (seen.has(profile.id)) {
        ctx.addIssue({ code: "custom", path: [index, "id"], message: `id「${profile.id}」重复` });
      }
      seen.add(profile.id);
    });
  });
}

/** zod 解析结果 → 协议类型（去掉值为 undefined 的键） */
export function toProviderProfile(parsed: z.output<typeof providerProfileSchema>): ProviderProfile {
  const profile: ProviderProfile = { id: parsed.id, extends: parsed.extends, label: parsed.label };
  if (parsed.description !== undefined) profile.description = parsed.description;
  if (parsed.enabled !== undefined) profile.enabled = parsed.enabled;
  if (parsed.baseUrl !== undefined) profile.baseUrl = parsed.baseUrl;
  if (parsed.apiKey !== undefined) profile.apiKey = parsed.apiKey;
  if (parsed.authMode !== undefined) profile.authMode = parsed.authMode;
  if (parsed.env !== undefined) profile.env = { ...parsed.env };
  if (parsed.command !== undefined) profile.command = [...parsed.command];
  if (parsed.models !== undefined) {
    profile.models = parsed.models.map((model) => ({
      id: model.id,
      label: model.label,
      ...(model.description !== undefined ? { description: model.description } : {}),
      ...(model.isDefault !== undefined ? { isDefault: model.isDefault } : {}),
    }));
  }
  if (parsed.disallowedTools !== undefined) profile.disallowedTools = [...parsed.disallowedTools];
  if (parsed.settings !== undefined) profile.settings = structuredClone(parsed.settings);
  if (parsed.codexConfig !== undefined) profile.codexConfig = parsed.codexConfig;
  if (parsed.codexAuth !== undefined) profile.codexAuth = structuredClone(parsed.codexAuth);
  return profile;
}

/** zod issue → RPC `data.issues` 形状（只含路径与说明，不含输入值） */
export function formatIssues(
  issues: readonly z.core.$ZodIssue[],
  prefix: readonly (string | number)[] = [],
): { path: string; message: string }[] {
  return issues.map((issue) => ({
    path: [...prefix, ...issue.path].map(String).join("."),
    message: issue.message,
  }));
}
