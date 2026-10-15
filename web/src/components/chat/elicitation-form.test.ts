import { describe, expect, it } from "vitest";
import type { ElicitationField } from "@agentdeck/protocol";
import { buildContent, initialValues, validateField } from "./elicitation-form";

const f = (patch: Partial<ElicitationField> & Pick<ElicitationField, "key" | "type">): ElicitationField => ({
  required: false,
  ...patch,
});

describe("elicitation-form", () => {
  it("initialValues：按类型取默认值，缺省时字符串 / 数字为空串、布尔 false、多选空数组", () => {
    const fields = [
      f({ key: "s", type: "string", default: "x" }),
      f({ key: "n", type: "number", default: 2.5 }),
      f({ key: "i", type: "integer" }),
      f({ key: "b", type: "boolean" }),
      f({ key: "b2", type: "boolean", default: true }),
      f({ key: "sel", type: "select", default: "a" }),
      f({ key: "m", type: "multiselect", default: ["a"] }),
      f({ key: "m2", type: "multiselect" }),
    ];
    expect(initialValues(fields)).toEqual({
      s: "x",
      n: "2.5",
      i: "",
      b: false,
      b2: true,
      sel: "a",
      m: ["a"],
      m2: [],
    });
  });

  it("validateField：必填 / 长度（按字符数）/ 数值范围 / 整数 / 多选数量", () => {
    expect(validateField(f({ key: "s", type: "string", required: true }), "  ")).toBe("必填");
    expect(validateField(f({ key: "s", type: "string" }), "")).toBeNull();
    expect(validateField(f({ key: "s", type: "string", minLength: 3 }), "ab")).toBe("不能少于 3 个字符");
    expect(validateField(f({ key: "s", type: "string", maxLength: 2 }), "abc")).toBe("不能超过 2 个字符");
    expect(validateField(f({ key: "s", type: "string", maxLength: 2 }), "你好")).toBeNull();
    expect(validateField(f({ key: "n", type: "number", min: 0, max: 10 }), "abc")).toBe("请输入数字");
    expect(validateField(f({ key: "n", type: "number", min: 0, max: 10 }), "-1")).toBe("不能小于 0");
    expect(validateField(f({ key: "n", type: "number", min: 0, max: 10 }), "11")).toBe("不能大于 10");
    expect(validateField(f({ key: "n", type: "number", min: 0, max: 10 }), "7.5")).toBeNull();
    expect(validateField(f({ key: "i", type: "integer" }), "1.5")).toBe("请输入整数");
    expect(validateField(f({ key: "b", type: "boolean", required: true }), false)).toBeNull();
    expect(validateField(f({ key: "m", type: "multiselect", min: 2 }), ["a"])).toBe("至少选择 2 项");
    expect(validateField(f({ key: "m", type: "multiselect", max: 1 }), ["a", "b"])).toBe("最多选择 1 项");
    expect(validateField(f({ key: "m", type: "multiselect", required: true }), [])).toBe("必填");
    expect(
      validateField(f({ key: "sel", type: "select", options: [{ value: "a", label: "A" }] }), "zz"),
    ).toBe("请选择有效的选项");
  });

  it("buildContent：数字转 number，选填空值不放进 content，布尔始终带值，错误按 key 汇总", () => {
    const fields = [
      f({ key: "name", type: "string", required: true }),
      f({ key: "note", type: "string" }),
      f({ key: "age", type: "integer", min: 1 }),
      f({ key: "ok", type: "boolean" }),
      f({ key: "tags", type: "multiselect" }),
    ];
    expect(buildContent(fields, { name: "小明", note: "", age: "3", ok: false, tags: [] })).toEqual({
      content: { name: "小明", age: 3, ok: false },
      errors: {},
    });
    expect(buildContent(fields, { name: "", note: "", age: "0", ok: true, tags: ["a"] })).toEqual({
      content: { ok: true, tags: ["a"] },
      errors: { name: "必填", age: "不能小于 1" },
    });
  });
});
