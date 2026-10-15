// MCP elicitation 表单的纯逻辑（design.md 4.32）：初始值、单字段校验、构造提交的 content。
// 字段由 sidecar 从 requestedSchema 归一化而来（packages/protocol 的 ElicitationField）。
import type { ElicitationField } from "@agentdeck/protocol";

export type FieldValue = string | boolean | string[];
export type FieldValues = Record<string, FieldValue>;

/** 单选选项不超过这个数用单选组，超过用下拉 */
export const RADIO_OPTION_LIMIT = 4;

export function initialValues(fields: readonly ElicitationField[]): FieldValues {
  const values: FieldValues = {};
  for (const field of fields) {
    switch (field.type) {
      case "boolean":
        values[field.key] = typeof field.default === "boolean" ? field.default : false;
        break;
      case "multiselect":
        values[field.key] = Array.isArray(field.default) ? [...field.default] : [];
        break;
      case "number":
      case "integer":
        values[field.key] = typeof field.default === "number" ? String(field.default) : "";
        break;
      default:
        values[field.key] = typeof field.default === "string" ? field.default : "";
    }
  }
  return values;
}

/** 字段当前是否有值（用于「选填」字段为空时不放进 content） */
function isBlank(field: ElicitationField, value: FieldValue | undefined): boolean {
  if (field.type === "boolean") return false;
  if (field.type === "multiselect") return !Array.isArray(value) || value.length === 0;
  return typeof value !== "string" || value.trim() === "";
}

/** 校验单个字段，返回中文错误；通过返回 null */
export function validateField(field: ElicitationField, value: FieldValue | undefined): string | null {
  if (isBlank(field, value)) {
    return field.required ? "必填" : null;
  }
  switch (field.type) {
    case "string": {
      const text = value as string;
      const length = Array.from(text).length;
      if (field.minLength !== undefined && length < field.minLength) return `不能少于 ${field.minLength} 个字符`;
      if (field.maxLength !== undefined && length > field.maxLength) return `不能超过 ${field.maxLength} 个字符`;
      return null;
    }
    case "number":
    case "integer": {
      const text = (value as string).trim();
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) return "请输入数字";
      if (field.type === "integer" && !Number.isInteger(parsed)) return "请输入整数";
      if (field.min !== undefined && parsed < field.min) return `不能小于 ${field.min}`;
      if (field.max !== undefined && parsed > field.max) return `不能大于 ${field.max}`;
      return null;
    }
    case "select":
      return field.options?.some((option) => option.value === value) ? null : "请选择有效的选项";
    case "multiselect": {
      const count = (value as string[]).length;
      if (field.min !== undefined && count < field.min) return `至少选择 ${field.min} 项`;
      if (field.max !== undefined && count > field.max) return `最多选择 ${field.max} 项`;
      return null;
    }
    default:
      return null;
  }
}

export interface FormResult {
  /** 提交给 Agent 的内容：选填且为空的字段不包含 */
  content: Record<string, unknown>;
  /** key → 错误；为空表示全部通过 */
  errors: Record<string, string>;
}

export function buildContent(fields: readonly ElicitationField[], values: FieldValues): FormResult {
  const content: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.key];
    const error = validateField(field, value);
    if (error) {
      errors[field.key] = error;
      continue;
    }
    if (isBlank(field, value)) continue;
    switch (field.type) {
      case "number":
      case "integer":
        content[field.key] = Number((value as string).trim());
        break;
      case "boolean":
        content[field.key] = value === true;
        break;
      default:
        content[field.key] = value;
    }
  }
  return { content, errors };
}
