import { describe, expect, test } from "vitest";

import {
  ELICITATION_MAX_FIELDS,
  ELICITATION_MAX_OPTIONS,
  normalizeElicitationSchema,
} from "../src/providers/shared/elicitation-schema.js";

describe("normalizeElicitationSchema", () => {
  test("string：title / description / 长度 / format / default，required 取自 required 数组", () => {
    const fields = normalizeElicitationSchema({
      type: "object",
      properties: {
        name: { type: "string", title: "姓名", description: "你的名字", minLength: 1, maxLength: 20, default: "小明" },
        email: { type: "string", format: "email" },
      },
      required: ["name"],
    });
    expect(fields).toEqual([
      {
        key: "name",
        title: "姓名",
        description: "你的名字",
        required: true,
        type: "string",
        minLength: 1,
        maxLength: 20,
        default: "小明",
      },
      { key: "email", required: false, type: "string", format: "email" },
    ]);
  });

  test("number / integer：minimum / maximum / default", () => {
    const fields = normalizeElicitationSchema({
      type: "object",
      properties: {
        age: { type: "integer", minimum: 0, maximum: 150, default: 30 },
        score: { type: "number", title: "分数" },
      },
    });
    expect(fields).toEqual([
      { key: "age", required: false, type: "integer", min: 0, max: 150, default: 30 },
      { key: "score", title: "分数", required: false, type: "number" },
    ]);
  });

  test("boolean：default", () => {
    expect(
      normalizeElicitationSchema({ type: "object", properties: { ok: { type: "boolean", default: true }, no: { type: "boolean" } } }),
    ).toEqual([
      { key: "ok", required: false, type: "boolean", default: true },
      { key: "no", required: false, type: "boolean" },
    ]);
  });

  test("单选：untitled enum、legacy enumNames、oneOf const/title，非法 default 丢弃", () => {
    const fields = normalizeElicitationSchema({
      type: "object",
      properties: {
        color: { type: "string", enum: ["red", "blue"], default: "blue" },
        legacy: { type: "string", enum: ["a", "b"], enumNames: ["选项 A", "选项 B"], default: "zzz" },
        titled: { type: "string", oneOf: [{ const: "x", title: "叉" }, { const: "y", title: "叹" }], default: "y" },
      },
    });
    expect(fields).toEqual([
      {
        key: "color",
        required: false,
        type: "select",
        options: [
          { value: "red", label: "red" },
          { value: "blue", label: "blue" },
        ],
        default: "blue",
      },
      {
        key: "legacy",
        required: false,
        type: "select",
        options: [
          { value: "a", label: "选项 A" },
          { value: "b", label: "选项 B" },
        ],
      },
      {
        key: "titled",
        required: false,
        type: "select",
        options: [
          { value: "x", label: "叉" },
          { value: "y", label: "叹" },
        ],
        default: "y",
      },
    ]);
  });

  test("多选：untitled items.enum、titled items.anyOf，minItems / maxItems / default", () => {
    const fields = normalizeElicitationSchema({
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string", enum: ["a", "b", "c"] }, minItems: 1, maxItems: 2, default: ["a", "zz"] },
        langs: {
          type: "array",
          title: "语言",
          items: { anyOf: [{ const: "zh", title: "中文" }, { const: "en", title: "English" }] },
        },
      },
    });
    expect(fields).toEqual([
      {
        key: "tags",
        required: false,
        type: "multiselect",
        options: [
          { value: "a", label: "a" },
          { value: "b", label: "b" },
          { value: "c", label: "c" },
        ],
        min: 1,
        max: 2,
        default: ["a"],
      },
      {
        key: "langs",
        title: "语言",
        required: false,
        type: "multiselect",
        options: [
          { value: "zh", label: "中文" },
          { value: "en", label: "English" },
        ],
      },
    ]);
  });

  test("按 property_order 排序，缺失的键按键序追加，多出的键忽略", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } },
    };
    expect(normalizeElicitationSchema(schema, ["c", "nope", "a"]).map((field) => field.key)).toEqual(["c", "a", "b"]);
    expect(normalizeElicitationSchema(schema).map((field) => field.key)).toEqual(["a", "b", "c"]);
  });

  test("密码字段：format password / writeOnly / 键名像密码 → secret", () => {
    const fields = normalizeElicitationSchema({
      type: "object",
      properties: {
        pw: { type: "string", format: "password" },
        w: { type: "string", writeOnly: true },
        api_key: { type: "string" },
        city: { type: "string" },
      },
    });
    expect(fields.map((field) => [field.key, field.secret === true])).toEqual([
      ["pw", true],
      ["w", true],
      ["api_key", true],
      ["city", false],
    ]);
  });

  test("不认识的类型 / 缺少类型 / 非对象定义降级为 string 并在 description 注明", () => {
    const fields = normalizeElicitationSchema({
      type: "object",
      properties: {
        obj: { type: "object", description: "嵌套对象" },
        mystery: { anyOf: [{ type: "string" }, { type: "number" }] },
        junk: "not-a-schema",
        badArray: { type: "array", items: { type: "number" } },
      },
    });
    expect(fields).toEqual([
      { key: "obj", description: "嵌套对象（不支持的类型：object，已按文本输入处理）", required: false, type: "string" },
      { key: "mystery", description: "（缺少类型：unknown，已按文本输入处理）", required: false, type: "string" },
      { key: "junk", description: "（不支持的字段定义：unknown，已按文本输入处理）", required: false, type: "string" },
      { key: "badArray", description: "（不支持的多选定义：array，已按文本输入处理）", required: false, type: "string" },
    ]);
  });

  test("type 为数组（含 null）取第一个非 null 类型", () => {
    expect(
      normalizeElicitationSchema({ type: "object", properties: { n: { type: ["null", "integer"], maximum: 3 } } }),
    ).toEqual([{ key: "n", required: false, type: "integer", max: 3 }]);
  });

  test("不是对象 schema 或没有 properties 时返回空数组；字段与选项数有上限", () => {
    expect(normalizeElicitationSchema(undefined)).toEqual([]);
    expect(normalizeElicitationSchema({ type: "object" })).toEqual([]);
    expect(normalizeElicitationSchema({ type: "object", properties: [] })).toEqual([]);

    const many = Object.fromEntries(Array.from({ length: ELICITATION_MAX_FIELDS + 10 }, (_, i) => [`f${i}`, { type: "string" }]));
    expect(normalizeElicitationSchema({ type: "object", properties: many })).toHaveLength(ELICITATION_MAX_FIELDS);

    const values = Array.from({ length: ELICITATION_MAX_OPTIONS + 5 }, (_, i) => `v${i}`);
    const [select] = normalizeElicitationSchema({ type: "object", properties: { s: { type: "string", enum: values } } });
    expect(select?.options).toHaveLength(ELICITATION_MAX_OPTIONS);
  });
});
