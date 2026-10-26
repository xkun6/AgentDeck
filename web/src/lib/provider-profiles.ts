// 自定义 provider / 三方中转（design.md 4.7）的前端纯逻辑：
// - id slug 生成与校验；
// - 启动命令的切分（支持引号）与回显；
// - 表单状态 ↔ ProviderProfile 互转（空字段省略、默认模型单选、Claude 设置 JSON、Codex config.toml / auth.json）；
// - provider.config.set / provider.test 校验错误（data.issues）路径 → 表单字段；
// - Agent 菜单的「内置 / 中转」分组。
// 本文件不做任何 IO，也不打印密钥。
import {
  CUSTOM_PROVIDER_ID_PREFIX,
  type ProviderInfo,
  type ProviderProfile,
  type ProviderProfileAuthMode,
  type ProviderProfileExtends,
  type ProviderProfileModel,
} from "@agentdeck/protocol";

export const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const PROFILE_ID_MAX_LENGTH = 32;
export const PROFILE_LABEL_MAX_CHARS = 40;
/** 设置了 Base URL 且未自定义时，sidecar 默认禁用的 Claude 工具 */
export const DEFAULT_RELAY_DISALLOWED_TOOLS = ["WebSearch"] as const;

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** sidecar 无论内置 provider 如何变化都保留的 id */
const ALWAYS_RESERVED_IDS = ["claude", "codex", "acp", "mock", "custom"];
const SLUG_FALLBACK = "relay";

export const PROFILE_EXTENDS_LABELS: Record<ProviderProfileExtends, string> = {
  claude: "Claude Code",
  codex: "Codex",
  acp: "ACP",
};

export function customProviderId(profileId: string): string {
  return `${CUSTOM_PROVIDER_ID_PREFIX}${profileId}`;
}

export function isCustomProviderId(providerId: string): boolean {
  return providerId.startsWith(CUSTOM_PROVIDER_ID_PREFIX);
}

// ── id slug ────────────────────────────────────────────────────────────────

/** 与内置 provider 冲突的 id（与 sidecar 规则一致：内置 id、ACP 名去掉前缀、固定保留字）。 */
export function reservedProfileIds(providers: readonly Pick<ProviderInfo, "id" | "custom">[] | null | undefined): Set<string> {
  const reserved = new Set(ALWAYS_RESERVED_IDS);
  for (const provider of providers ?? []) {
    if (provider.custom || isCustomProviderId(provider.id)) continue;
    const id = provider.id.toLowerCase();
    reserved.add(id);
    const colon = id.indexOf(":");
    if (colon >= 0) reserved.add(id.slice(colon + 1));
  }
  return reserved;
}

function truncateSlug(slug: string, max: number): string {
  return slug.slice(0, max).replace(/-+$/, "");
}

/**
 * 由名称生成 id：小写、非 [a-z0-9] 折叠为 `-`、去首尾 `-`、以字母开头、最长 32 位；
 * 名称里没有可用字符（如纯中文）时取 `relay`。与 `taken`（已用 / 保留 id）冲突时追加 `-2`、`-3`…
 */
export function slugifyProfileId(label: string, taken: ReadonlySet<string> = new Set()): string {
  let base = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base && !/^[a-z]/.test(base)) base = `${SLUG_FALLBACK}-${base}`;
  base = truncateSlug(base || SLUG_FALLBACK, PROFILE_ID_MAX_LENGTH);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${truncateSlug(base, PROFILE_ID_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** id 格式校验（冲突由 sidecar 判定并经 issues 回显）；合法返回 null。 */
export function validateProfileId(id: string): string | null {
  if (!id) return "id 不能为空";
  if (!PROFILE_ID_PATTERN.test(id)) return "id 须以小写字母开头，只含小写字母、数字和 -，最长 32 位";
  return null;
}

// ── 启动命令 ───────────────────────────────────────────────────────────────

/**
 * 把一行命令按空白切成参数：单引号 / 双引号包裹的部分原样保留（可含空格），引号本身去掉；
 * 反斜杠不做转义（Windows 路径常含 `\`）。未闭合的引号视为延续到行尾。
 */
export function splitCommandLine(line: string): string[] {
  const args: string[] = [];
  let current = "";
  let inArg = false;
  let quote: '"' | "'" | null = null;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inArg = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (inArg) args.push(current);
      current = "";
      inArg = false;
      continue;
    }
    current += char;
    inArg = true;
  }
  if (inArg) args.push(current);
  return args;
}

/** splitCommandLine 的逆：含空白或引号（或为空）的参数加引号。 */
export function joinCommandLine(args: readonly string[]): string {
  return args
    .map((arg) => {
      if (arg !== "" && !/[\s"']/.test(arg)) return arg;
      return arg.includes('"') ? `'${arg}'` : `"${arg}"`;
    })
    .join(" ");
}

/** 逗号 / 空白分隔的工具名列表。 */
export function splitToolList(text: string): string[] {
  return text
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// ── URL ────────────────────────────────────────────────────────────────────

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/** 列表与菜单里只显示 host（含端口）；无法解析时原样返回。 */
export function profileHost(baseUrl: string | undefined | null): string {
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl;
  }
}

// ── 表单 ↔ ProviderProfile ─────────────────────────────────────────────────

export interface ProviderFormModel {
  /** 列表行的稳定 key（不提交） */
  key: string;
  id: string;
  label: string;
  description: string;
  isDefault: boolean;
}

export interface ProviderFormEnv {
  key: string;
  name: string;
  value: string;
}

export interface ProviderFormState {
  extends: ProviderProfileExtends;
  label: string;
  id: string;
  /** 用户手动改过 id（或编辑已有项）：不再随名称自动生成 */
  idTouched: boolean;
  description: string;
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  authMode: ProviderProfileAuthMode;
  models: ProviderFormModel[];
  /** 是否自定义禁用工具（否则用 sidecar 默认：有 Base URL 时禁用 WebSearch） */
  customDisallowedTools: boolean;
  disallowedToolsText: string;
  /** ACP：启动命令；Claude / Codex：可执行文件覆盖。一行，空格分隔，支持引号 */
  commandText: string;
  env: ProviderFormEnv[];
  /** 仅 Claude：设置 JSON 文本（留空表示不用） */
  settingsText: string;
  /** 仅 Codex：config.toml 原文（留空表示不用；语法由 sidecar 校验） */
  codexConfigText: string;
  /** 仅 Codex：auth.json 文本（JSON 对象；留空表示不用） */
  codexAuthText: string;
}

let rowKeySeq = 0;
export function newRowKey(prefix = "row"): string {
  rowKeySeq += 1;
  return `${prefix}-${rowKeySeq}`;
}

export function emptyProviderForm(extendsValue: ProviderProfileExtends = "claude"): ProviderFormState {
  return {
    extends: extendsValue,
    label: "",
    id: "",
    idTouched: false,
    description: "",
    enabled: true,
    baseUrl: "",
    apiKey: "",
    authMode: "auth_token",
    models: [],
    customDisallowedTools: false,
    disallowedToolsText: "",
    commandText: "",
    env: [],
    settingsText: "",
    codexConfigText: "",
    codexAuthText: "",
  };
}

export function profileToForm(profile: ProviderProfile): ProviderFormState {
  return {
    extends: profile.extends,
    label: profile.label,
    id: profile.id,
    idTouched: true,
    description: profile.description ?? "",
    enabled: profile.enabled !== false,
    baseUrl: profile.baseUrl ?? "",
    apiKey: profile.apiKey ?? "",
    authMode: profile.authMode ?? "auth_token",
    models: (profile.models ?? []).map((model) => ({
      key: newRowKey("model"),
      id: model.id,
      label: model.label,
      description: model.description ?? "",
      isDefault: model.isDefault === true,
    })),
    customDisallowedTools: profile.disallowedTools !== undefined,
    disallowedToolsText: (profile.disallowedTools ?? []).join(", "),
    commandText: profile.command ? joinCommandLine(profile.command) : "",
    env: Object.entries(profile.env ?? {}).map(([name, value]) => ({ key: newRowKey("env"), name, value })),
    settingsText: profile.settings ? JSON.stringify(profile.settings, null, 2) : "",
    codexConfigText: profile.codexConfig ?? "",
    codexAuthText: profile.codexAuth ? JSON.stringify(profile.codexAuth, null, 2) : "",
  };
}

// ── Claude 设置（JSON） ─────────────────────────────────────────────────────

export type SettingsTextParse =
  | { kind: "empty" }
  | { kind: "ok"; value: Record<string, unknown> }
  | { kind: "error"; message: string };

/** 设置 JSON 文本：留空表示不使用；否则必须是 JSON 对象。 */
export function parseSettingsText(text: string): SettingsTextParse {
  if (!text.trim()) return { kind: "empty" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    return { kind: "error", message: `不是合法的 JSON${detail ? `：${detail}` : ""}` };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "error", message: "必须是 JSON 对象（{ … }），不能是数组或其它值" };
  }
  return { kind: "ok", value: value as Record<string, unknown> };
}

/** 「格式化」：合法 JSON 对象返回 2 空格缩进的文本，否则返回 null（保持原样）。 */
export function formatSettingsText(text: string): string | null {
  const parsed = parseSettingsText(text);
  return parsed.kind === "ok" ? JSON.stringify(parsed.value, null, 2) : null;
}

/** 列表「含设置」标记：基于 Claude Code 且配置了设置 JSON。 */
export function profileHasClaudeSettings(profile: ProviderProfile): boolean {
  return profile.extends === "claude" && Boolean(profile.settings);
}

function isBlankModel(model: ProviderFormModel): boolean {
  return !model.id.trim() && !model.label.trim() && !model.description.trim();
}

/**
 * 表单 → ProviderProfile：可选文本去空白后为空则省略；Base URL 去掉末尾 `/`；
 * 只有第一个勾选「默认」的模型带 `isDefault: true`；空行模型 / 环境变量丢弃；
 * 与 extends 无关的字段（ACP 的 Base URL / 密钥、非 Claude 的认证方式与禁用工具）不提交。
 */
export function formToProfile(form: ProviderFormState): ProviderProfile {
  const profile: ProviderProfile = {
    id: form.id.trim(),
    extends: form.extends,
    label: form.label.trim(),
  };
  const description = form.description.trim();
  if (description) profile.description = description;
  if (!form.enabled) profile.enabled = false;

  if (form.extends !== "acp") {
    const baseUrl = form.baseUrl.trim().replace(/\/+$/, "");
    if (baseUrl) profile.baseUrl = baseUrl;
    const apiKey = form.apiKey.trim();
    if (apiKey) profile.apiKey = apiKey;
  }
  if (form.extends === "claude") {
    profile.authMode = form.authMode;
    if (form.customDisallowedTools) profile.disallowedTools = splitToolList(form.disallowedToolsText);
    // 非法 JSON 由 validateProviderForm 拦下；这里只写入能解析成对象的内容
    const settings = parseSettingsText(form.settingsText);
    if (settings.kind === "ok") profile.settings = settings.value;
  }
  if (form.extends === "codex") {
    // config.toml 原样提交（保留注释与格式）；auth.json 非法由 validateProviderForm 拦下
    if (form.codexConfigText.trim()) profile.codexConfig = form.codexConfigText;
    const auth = parseSettingsText(form.codexAuthText);
    if (auth.kind === "ok") profile.codexAuth = auth.value;
  }

  const env: Record<string, string> = {};
  let hasEnv = false;
  for (const row of form.env) {
    const name = row.name.trim();
    if (!name && !row.value) continue;
    env[name] = row.value;
    hasEnv = true;
  }
  if (hasEnv) profile.env = env;

  const command = splitCommandLine(form.commandText);
  if (command.length > 0) profile.command = command;

  let defaultTaken = false;
  const models: ProviderProfileModel[] = form.models.filter((model) => !isBlankModel(model)).map((model) => {
    const id = model.id.trim();
    const entry: ProviderProfileModel = { id, label: model.label.trim() || id };
    const modelDescription = model.description.trim();
    if (modelDescription) entry.description = modelDescription;
    if (model.isDefault && !defaultTaken) {
      entry.isDefault = true;
      defaultTaken = true;
    }
    return entry;
  });
  if (models.length > 0) profile.models = models;
  return profile;
}

/** 设为默认（单选）：再次点击当前默认项则取消默认。 */
export function setDefaultModel(models: ProviderFormModel[], key: string): ProviderFormModel[] {
  const target = models.find((model) => model.key === key);
  const nextDefault = !(target?.isDefault ?? false);
  return models.map((model) => ({ ...model, isDefault: model.key === key ? nextDefault : false }));
}

/** 把接口拉取的模型并入列表：已存在的 id 跳过；原列表全是空行时直接替换。 */
export function mergeFetchedModels(
  models: ProviderFormModel[],
  fetched: readonly { id: string; label: string }[],
): ProviderFormModel[] {
  const kept = models.filter((model) => !isBlankModel(model));
  const existing = new Set(kept.map((model) => model.id.trim()));
  const added = fetched
    .filter((model) => model.id && !existing.has(model.id))
    .map((model) => ({
      key: newRowKey("model"),
      id: model.id,
      label: model.label || model.id,
      description: "",
      isDefault: false,
    }));
  return [...kept, ...added];
}

/** 表单字段错误：key 为字段名（id / label / baseUrl / command / models.<i>.id …） */
export type ProviderFormErrors = Record<string, string>;

/** 本地校验（格式类）；冲突、重复等由 sidecar 返回 issues。 */
export function validateProviderForm(form: ProviderFormState): ProviderFormErrors {
  const errors: ProviderFormErrors = {};
  const label = form.label.trim();
  if (!label) errors.label = "名称不能为空";
  else if (Array.from(label).length > PROFILE_LABEL_MAX_CHARS) errors.label = `名称最长 ${PROFILE_LABEL_MAX_CHARS} 字`;
  const idError = validateProfileId(form.id.trim());
  if (idError) errors.id = idError;

  if (form.extends !== "acp") {
    const baseUrl = form.baseUrl.trim();
    if (baseUrl && !isHttpUrl(baseUrl)) errors.baseUrl = "接口地址必须是 http:// 或 https:// 开头的 URL";
  }
  if (form.extends === "acp" && splitCommandLine(form.commandText).length === 0) {
    errors.command = "ACP 中转必须填写启动命令";
  }
  if (form.extends === "claude") {
    const settings = parseSettingsText(form.settingsText);
    if (settings.kind === "error") errors.settings = settings.message;
  }
  if (form.extends === "codex") {
    const auth = parseSettingsText(form.codexAuthText);
    if (auth.kind === "error") errors.codexAuth = auth.message;
  }

  const models = form.models.filter((model) => !isBlankModel(model));
  if (form.extends === "codex" && form.baseUrl.trim() && models.length === 0) {
    errors.models = "Codex 不会从中转发现模型，必须至少填写一个模型";
  }
  form.models.forEach((model, index) => {
    if (isBlankModel(model)) return;
    if (!model.id.trim()) errors[`models.${index}.id`] = "模型 id 不能为空";
  });

  for (const row of form.env) {
    const name = row.name.trim();
    if (!name && !row.value) continue;
    if (!ENV_KEY_PATTERN.test(name)) {
      errors.env = "环境变量名只能含字母、数字和下划线，且不能以数字开头";
      break;
    }
  }
  return errors;
}

// ── data.issues → 表单字段 ─────────────────────────────────────────────────

export interface RpcIssue {
  path: string;
  message: string;
}

/** 从 RPC 错误的 `data.issues` 里取出合法的 issue 列表。 */
export function readRpcIssues(data: unknown): RpcIssue[] {
  if (!data || typeof data !== "object") return [];
  const issues = (data as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issue) => {
    if (!issue || typeof issue !== "object") return [];
    const { path, message } = issue as { path?: unknown; message?: unknown };
    if (typeof message !== "string") return [];
    return [{ path: typeof path === "string" ? path : "", message }];
  });
}

/**
 * issue 路径 → 表单字段 key。路径形如 `providers.<i>.<field>…`（provider.config.set）
 * 或 `profile.<field>…`（provider.test）。属于其它项（i ≠ index）或无法识别时返回 null。
 * 模型行保留 `models.<i>.id|label`，其余嵌套（command.2、env.FOO、disallowedTools.0）归到顶层字段。
 */
export function issuePathToField(path: string, index: number | null): string | null {
  const segments = path.split(".").filter((segment) => segment !== "");
  let rest: string[];
  if (segments[0] === "providers") {
    if (segments.length < 3 || index === null || segments[1] !== String(index)) return null;
    rest = segments.slice(2);
  } else if (segments[0] === "profile") {
    if (segments.length < 2) return null;
    rest = segments.slice(1);
  } else {
    return null;
  }
  const [field, row, sub] = rest;
  if (!field) return null;
  if (field === "models" && row !== undefined && /^\d+$/.test(row)) {
    return sub === "id" || sub === "label" ? `models.${row}.${sub}` : "models";
  }
  return field;
}

export interface MappedIssues {
  fields: ProviderFormErrors;
  /** 无法落到当前表单字段的问题（整表 / 其它项） */
  general: string[];
}

/** 把 issues 分成「当前表单字段」与「其它」。同一字段保留第一条。 */
export function mapIssuesToForm(issues: readonly RpcIssue[], index: number | null): MappedIssues {
  const fields: ProviderFormErrors = {};
  const general: string[] = [];
  for (const issue of issues) {
    const field = issuePathToField(issue.path, index);
    if (field) {
      if (!(field in fields)) fields[field] = issue.message;
    } else {
      general.push(issue.message);
    }
  }
  return { fields, general };
}

// ── 会话所用中转的状态 ──────────────────────────────────────────────────────

/**
 * 会话 provider 在 providers.json 中的状态：`builtin` 非中转；`unknown` 配置未加载；
 * `present` 已启用；`disabled` 已停用（恢复返回 PROVIDER_NOT_FOUND，重新启用后可恢复）；
 * `deleted` 已从配置删除（无法恢复，只能新建会话）。
 */
export type RelaySessionState = "builtin" | "unknown" | "present" | "disabled" | "deleted";

export function relaySessionState(
  providerId: string | null | undefined,
  profiles: readonly ProviderProfile[] | null | undefined,
): RelaySessionState {
  if (!providerId || !isCustomProviderId(providerId)) return "builtin";
  if (!profiles) return "unknown";
  const profile = profiles.find((item) => customProviderId(item.id) === providerId);
  if (!profile) return "deleted";
  return profile.enabled === false ? "disabled" : "present";
}

// ── Agent 菜单分组 ─────────────────────────────────────────────────────────

export const PROVIDER_GROUP_BUILTIN = "内置";
export const PROVIDER_GROUP_RELAY = "中转";

export interface ProviderMenuEntry {
  value: string;
  label: string;
  description?: string;
  disabled: boolean;
  group: typeof PROVIDER_GROUP_BUILTIN | typeof PROVIDER_GROUP_RELAY;
}

function relayBasis(extendsValue: ProviderProfileExtends | undefined, baseUrl?: string): string {
  const basis = `基于 ${PROFILE_EXTENDS_LABELS[extendsValue ?? "claude"]}`;
  const host = profileHost(baseUrl);
  return host ? `${basis}，${host}` : basis;
}

/**
 * Agent 菜单：先「内置」，后「中转」。中转按 providers.json 顺序列出，停用项（不在 provider.list 中）
 * 与不可用项置灰；副文字为「基于 Claude Code，host」。配置尚未加载时只按 provider.list 列出。
 */
export function buildProviderMenuEntries(
  providers: readonly ProviderInfo[] | null,
  profiles: readonly ProviderProfile[] | null | undefined,
): ProviderMenuEntry[] {
  const list = providers ?? [];
  const builtin: ProviderMenuEntry[] = list
    .filter((provider) => !provider.custom && !isCustomProviderId(provider.id))
    .map((provider) => ({
      value: provider.id,
      label: provider.label,
      disabled: !provider.available,
      description: provider.available
        ? undefined
        : `不可用${provider.unavailableReason ? `：${provider.unavailableReason}` : ""}`,
      group: PROVIDER_GROUP_BUILTIN,
    }));

  const customInfos = list.filter((provider) => provider.custom || isCustomProviderId(provider.id));
  const infoById = new Map(customInfos.map((provider) => [provider.id, provider]));
  const relay: ProviderMenuEntry[] = [];
  const seen = new Set<string>();
  for (const profile of profiles ?? []) {
    const id = customProviderId(profile.id);
    seen.add(id);
    const info = infoById.get(id);
    const basis = relayBasis(profile.extends, profile.baseUrl);
    if (profile.enabled === false || !info) {
      relay.push({ value: id, label: profile.label, disabled: true, description: `已停用，${basis}`, group: PROVIDER_GROUP_RELAY });
      continue;
    }
    relay.push({
      value: id,
      label: info.label,
      disabled: !info.available,
      description: info.available
        ? basis
        : `不可用${info.unavailableReason ? `：${info.unavailableReason}` : ""}，${basis}`,
      group: PROVIDER_GROUP_RELAY,
    });
  }
  for (const info of customInfos) {
    if (seen.has(info.id)) continue;
    const basis = relayBasis(info.extends ?? (info.kind === "mock" ? undefined : info.kind));
    relay.push({
      value: info.id,
      label: info.label,
      disabled: !info.available,
      description: info.available
        ? basis
        : `不可用${info.unavailableReason ? `：${info.unavailableReason}` : ""}，${basis}`,
      group: PROVIDER_GROUP_RELAY,
    });
  }
  return [...builtin, ...relay];
}
