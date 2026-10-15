// MCP elicitation 的 requestedSchema（JSON Schema 子集）→ AgentDeck 表单字段（AgentDeck 原创，design.md 4.32）。
// Claude（control_request elicitation 的 requested_schema）与 Codex（mcpServer/elicitation/request 的
// requestedSchema）共用。支持 MCP 2025-11-25 ElicitRequestFormParams 的全部原始类型：
//   - string：title / description / minLength / maxLength / format(email|uri|date|date-time) / default
//   - number / integer：minimum / maximum / default
//   - boolean：default
//   - 单选：{enum}（可带旧版 enumNames）、{oneOf:[{const,title}]}
//   - 多选：{type:"array", items:{enum}|{anyOf:[{const,title}]}, minItems, maxItems, default}
// 不认识的字段降级为 string 并在 description 里注明；字段顺序优先按 property_order，其次 properties 的键序。
import type { AgentPermissionAction, ElicitationField, ElicitationFieldOption } from "@agentdeck/protocol";

type JsonRecord = Record<string, unknown>;

/** 单个表单最多渲染的字段数（防止畸形 schema 撑爆审批事件） */
export const ELICITATION_MAX_FIELDS = 50;
/** 单个字段最多保留的选项数 */
export const ELICITATION_MAX_OPTIONS = 200;

/** 表单模式的应答动作：提交（allow）/ 拒绝（deny）/ 取消（deny + interrupt，中断本回合） */
export const ELICITATION_FORM_ACTIONS: readonly AgentPermissionAction[] = [
  { id: "submit", label: "提交", behavior: "allow" },
  { id: "decline", label: "拒绝", behavior: "deny" },
  { id: "cancel", label: "取消", behavior: "deny" },
];
/** url 模式的应答动作：已完成（allow）/ 拒绝 / 取消 */
export const ELICITATION_URL_ACTIONS: readonly AgentPermissionAction[] = [
  { id: "done", label: "已完成", behavior: "allow" },
  { id: "decline", label: "拒绝", behavior: "deny" },
  { id: "cancel", label: "取消", behavior: "deny" },
];

const SECRET_KEY_PATTERN = /(password|passwd|secret|api[_-]?key|token)/i;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 有限数字（兼容 bigint 序列化成的 number / 数字字符串之外的值一律忽略） */
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && n >= 0 ? Math.floor(n) : undefined;
}

/** JSON Schema 的 type 可能是 "string" 或 ["string","null"]：取第一个非 null 的字符串 */
function schemaType(schema: JsonRecord): string | undefined {
  const type = schema.type;
  if (typeof type === "string") return type;
  if (Array.isArray(type)) {
    return type.find((item): item is string => typeof item === "string" && item !== "null");
  }
  return undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
}

/** 选项：enum（可配旧版 enumNames）或 [{const,title}] */
function optionsFromEnum(values: string[], names: unknown): ElicitationFieldOption[] {
  const titles = stringArray(names);
  return values.slice(0, ELICITATION_MAX_OPTIONS).map((value, index) => ({
    value,
    label: titles?.[index] || value,
  }));
}

function optionsFromConst(list: unknown): ElicitationFieldOption[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const options: ElicitationFieldOption[] = [];
  for (const item of list) {
    if (!isRecord(item) || typeof item.const !== "string") return undefined;
    options.push({ value: item.const, label: text(item.title) ?? item.const });
  }
  return options.slice(0, ELICITATION_MAX_OPTIONS);
}

/** 从 enum / oneOf / anyOf 取出选项；形状不对返回 undefined */
function selectOptions(schema: JsonRecord): ElicitationFieldOption[] | undefined {
  const fromOneOf = optionsFromConst(schema.oneOf);
  if (fromOneOf && fromOneOf.length > 0) return fromOneOf;
  const fromAnyOf = optionsFromConst(schema.anyOf);
  if (fromAnyOf && fromAnyOf.length > 0) return fromAnyOf;
  const values = stringArray(schema.enum);
  if (values && values.length > 0) return optionsFromEnum(values, schema.enumNames);
  return undefined;
}

function degrade(base: ElicitationField, schema: JsonRecord, why: string): ElicitationField {
  const original = schemaType(schema) ?? (schema.enum !== undefined ? "enum" : "unknown");
  const note = `（${why}：${original}，已按文本输入处理）`;
  return { ...base, type: "string", description: `${base.description ?? ""}${note}`.trim() };
}

function normalizeProperty(key: string, raw: unknown, required: boolean): ElicitationField {
  const schema = isRecord(raw) ? raw : {};
  const title = text(schema.title);
  const description = text(schema.description);
  const base: ElicitationField = {
    key,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    required,
    type: "string",
  };
  if (!isRecord(raw)) {
    return degrade(base, schema, "不支持的字段定义");
  }
  const type = schemaType(schema);

  if (type === "array") {
    const items = isRecord(schema.items) ? schema.items : {};
    const options = selectOptions(items);
    if (!options) return degrade(base, schema, "不支持的多选定义");
    const min = nonNegativeInt(schema.minItems);
    const max = nonNegativeInt(schema.maxItems);
    const values = new Set(options.map((option) => option.value));
    const defaults = stringArray(schema.default)?.filter((value) => values.has(value));
    return {
      ...base,
      type: "multiselect",
      options,
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(defaults && defaults.length > 0 ? { default: defaults } : {}),
    };
  }

  // 单选：带 enum / oneOf 的 string（缺省 type 但有 enum / oneOf 也按单选）
  const options = type === undefined || type === "string" ? selectOptions(schema) : undefined;
  if (options) {
    const defaultValue = text(schema.default);
    return {
      ...base,
      type: "select",
      options,
      ...(defaultValue && options.some((option) => option.value === defaultValue) ? { default: defaultValue } : {}),
    };
  }

  if (type === "boolean") {
    return { ...base, type: "boolean", ...(typeof schema.default === "boolean" ? { default: schema.default } : {}) };
  }

  if (type === "number" || type === "integer") {
    const min = num(schema.minimum);
    const max = num(schema.maximum);
    const defaultValue = num(schema.default);
    return {
      ...base,
      type,
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    };
  }

  if (type === "string") {
    const minLength = nonNegativeInt(schema.minLength);
    const maxLength = nonNegativeInt(schema.maxLength);
    const format = text(schema.format);
    const defaultValue = typeof schema.default === "string" ? schema.default : undefined;
    const secret =
      format === "password" || schema.writeOnly === true || SECRET_KEY_PATTERN.test(key);
    return {
      ...base,
      type: "string",
      ...(format ? { format } : {}),
      ...(minLength !== undefined ? { minLength } : {}),
      ...(maxLength !== undefined ? { maxLength } : {}),
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      ...(secret ? { secret: true } : {}),
    };
  }

  return degrade(base, schema, type === undefined ? "缺少类型" : "不支持的类型");
}

/**
 * requestedSchema → 字段列表。
 * @param schema JSON Schema 对象（{type:"object", properties, required?}）；不是对象或没有 properties 时返回 []
 * @param propertyOrder CLI 提供的 properties 键顺序（Claude 的 property_order）；缺省用 properties 的键序，
 *   顺序里没有的键按键序追加，顺序里多出的键忽略
 */
export function normalizeElicitationSchema(
  schema: unknown,
  propertyOrder?: readonly string[] | null,
): ElicitationField[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  const properties = schema.properties;
  const required = new Set(stringArray(schema.required) ?? []);
  const keys: string[] = [];
  for (const key of propertyOrder ?? []) {
    if (Object.hasOwn(properties, key) && !keys.includes(key)) keys.push(key);
  }
  for (const key of Object.keys(properties)) {
    if (!keys.includes(key)) keys.push(key);
  }
  return keys
    .slice(0, ELICITATION_MAX_FIELDS)
    .map((key) => normalizeProperty(key, properties[key], required.has(key)));
}
