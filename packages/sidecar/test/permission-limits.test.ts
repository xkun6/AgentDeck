import type { AgentPermissionRequest } from "@agentdeck/protocol";
import { describe, expect, test } from "vitest";

import {
  limitPermissionRequest,
  limitPermissionResponse,
  PERMISSION_FIELD_MAX_BYTES,
  PERMISSION_TOTAL_MAX_BYTES,
  restoreTruncatedInput,
} from "../src/agent/permission-limits.js";

function request(patch: Partial<AgentPermissionRequest>): AgentPermissionRequest {
  return { id: "r1", provider: "mock", name: "Write", kind: "tool", ...patch };
}

describe("limitPermissionRequest", () => {
  test("未超限：返回同一个对象，不复制", () => {
    const original = request({
      title: "写文件",
      input: { file_path: "a.txt", content: "hello" },
      detail: { type: "write", filePath: "a.txt", content: "hello" },
    });
    const { request: limited, truncatedInput } = limitPermissionRequest(original);
    expect(limited).toBe(original);
    expect(truncatedInput).toEqual([]);
  });

  test("elicitation 的 detail 同样受限：超长 message 被截断，fields 与选项原样保留", () => {
    const big = "m".repeat(PERMISSION_FIELD_MAX_BYTES + 100);
    const fields = Array.from({ length: 50 }, (_, i) => ({
      key: `f${i}`,
      title: `字段 ${i}`,
      required: i === 0,
      type: "select" as const,
      options: Array.from({ length: 20 }, (_, j) => ({ value: `v${j}`, label: `选项 ${j}` })),
    }));
    const original = request({
      kind: "elicitation",
      name: "mcp:forms",
      input: { serverName: "forms", mode: "form", message: big },
      detail: { type: "elicitation", serverName: "forms", mode: "form", message: big, fields },
    });
    const { request: limited } = limitPermissionRequest(original);
    const detail = limited.detail as { message: string; fields: typeof fields };
    expect(detail.message.endsWith("…已截断 100 字节")).toBe(true);
    expect(detail.fields).toEqual(fields);
    expect(detail.fields).toHaveLength(50);
  });

  test("单字段超过 256KB：按 UTF-8 字节截断并附「…已截断 N 字节」，短字段与其它字段原样保留", () => {
    const big = "a".repeat(PERMISSION_FIELD_MAX_BYTES + 5000);
    const original = request({
      input: { content: big, file_path: "a.txt" },
      detail: { type: "write", filePath: "a.txt", content: big },
    });
    const { request: limited, truncatedInput } = limitPermissionRequest(original);
    expect(limited).not.toBe(original);
    const content = limited.input!.content as string;
    expect(content.startsWith("a".repeat(PERMISSION_FIELD_MAX_BYTES))).toBe(true);
    expect(content.endsWith("…已截断 5000 字节")).toBe(true);
    expect(limited.input!.file_path).toBe("a.txt");
    expect((limited.detail as { content: string }).content.endsWith("…已截断 5000 字节")).toBe(true);
    // 原对象不被修改
    expect(original.input!.content).toBe(big);
    expect(truncatedInput.map((item) => item.key)).toEqual(["content"]);
    expect(truncatedInput[0]!.original).toBe(big);
  });

  test("多字节字符不会被截开；嵌套数组 / 对象里的字符串同样截断", () => {
    const original = request({
      input: { questions: [{ options: [{ preview: "中".repeat(PERMISSION_FIELD_MAX_BYTES) }] }] },
    });
    const { request: limited } = limitPermissionRequest(original);
    const preview = (limited.input as { questions: Array<{ options: Array<{ preview: string }> }> }).questions[0]!
      .options[0]!.preview;
    const [kept, marker] = preview.split("…已截断");
    expect(marker).toMatch(/^ \d+ 字节$/);
    expect(kept).not.toContain("\uFFFD");
    expect(Buffer.byteLength(kept!)).toBeLessThanOrEqual(PERMISSION_FIELD_MAX_BYTES);
    expect(kept!.length).toBeGreaterThan(80_000);
  });

  test("大量中等字段累加受总预算约束，整体大小有上界", () => {
    const input: Record<string, string> = {};
    for (let i = 0; i < 60; i += 1) input[`f${i}`] = "z".repeat(200 * 1024);
    const { request: limited } = limitPermissionRequest(request({ input }));
    const total = Object.values(limited.input as Record<string, string>).reduce((sum, v) => sum + Buffer.byteLength(v), 0);
    expect(total).toBeLessThan(PERMISSION_TOTAL_MAX_BYTES + 60 * 1200);
    expect(JSON.stringify(limited).length).toBeLessThan(4 * 1024 * 1024);
  });
});

describe("restoreTruncatedInput / limitPermissionResponse", () => {
  test("只还原仍等于下发截断值的字段；用户改过的保留；没有截断记录时原样返回", () => {
    const big = "b".repeat(PERMISSION_FIELD_MAX_BYTES + 10);
    const { request: limited, truncatedInput } = limitPermissionRequest(request({ input: { content: big, other: 1 } }));
    const sent = limited.input!;
    expect(restoreTruncatedInput({ ...sent, answers: {} }, truncatedInput)).toEqual({ content: big, other: 1, answers: {} });
    expect(restoreTruncatedInput({ content: "改过" }, truncatedInput)).toEqual({ content: "改过" });
    expect(restoreTruncatedInput({ other: 2 }, truncatedInput)).toEqual({ other: 2 });
    const plain = { a: 1 };
    expect(restoreTruncatedInput(plain, [])).toBe(plain);
    expect(restoreTruncatedInput(undefined, truncatedInput)).toBeUndefined();
  });

  test("permission_resolved 里的大 updatedInput 同样截断；deny 与小应答同一引用", () => {
    const big = "c".repeat(PERMISSION_FIELD_MAX_BYTES + 1);
    const limited = limitPermissionResponse({ behavior: "allow", updatedInput: { content: big } });
    expect(
      (limited as unknown as { updatedInput: { content: string } }).updatedInput.content.endsWith("…已截断 1 字节"),
    ).toBe(true);
    const deny = { behavior: "deny", message: "no" } as const;
    expect(limitPermissionResponse(deny)).toBe(deny);
    const small = { behavior: "allow", updatedInput: { a: "b" } } as const;
    expect(limitPermissionResponse(small)).toBe(small);
  });
});
