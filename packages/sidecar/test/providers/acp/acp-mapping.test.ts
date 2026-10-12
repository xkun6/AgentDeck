import type { PermissionOption } from "@agentclientprotocol/sdk";
import { describe, expect, test } from "vitest";

import {
  mapToolDetail,
  mergeToolSnapshot,
  selectPermissionOption,
  toAcpPrompt,
  toolSnapshotToTimelineItem,
} from "../../../src/providers/acp/acp-mapping.js";

const OPTIONS: PermissionOption[] = [
  { optionId: "a1", name: "允许一次", kind: "allow_once" },
  { optionId: "a2", name: "总是允许", kind: "allow_always" },
  { optionId: "r1", name: "拒绝", kind: "reject_once" },
  { optionId: "r2", name: "总是拒绝", kind: "reject_always" },
];

describe("selectPermissionOption", () => {
  test("按行为选 once 优先，退而求 always，都没有返回 null", () => {
    expect(selectPermissionOption(OPTIONS, { behavior: "allow" })?.optionId).toBe("a1");
    expect(selectPermissionOption(OPTIONS, { behavior: "deny" })?.optionId).toBe("r1");
    expect(selectPermissionOption(OPTIONS.slice(1, 2), { behavior: "allow" })?.optionId).toBe("a2");
    expect(selectPermissionOption(OPTIONS.slice(3), { behavior: "deny" })?.optionId).toBe("r2");
    expect(selectPermissionOption(OPTIONS.slice(0, 2), { behavior: "deny" })).toBeNull();
  });

  test("selectedActionId 精确匹配，不存在返回 undefined", () => {
    expect(selectPermissionOption(OPTIONS, { behavior: "allow", selectedActionId: "a2" })?.optionId).toBe(
      "a2",
    );
    expect(selectPermissionOption(OPTIONS, { behavior: "deny", selectedActionId: "x" })).toBeUndefined();
  });
});

describe("工具快照", () => {
  test("合并：未出现的字段沿用旧值，显式 null 覆盖", () => {
    const first = mergeToolSnapshot({
      toolCallId: "t",
      title: "grep foo",
      kind: "search",
      status: "pending",
      locations: [{ path: "a.ts" }],
      rawInput: { pattern: "foo" },
    });
    const second = mergeToolSnapshot({ toolCallId: "t", status: "completed", locations: null }, first);
    expect(second).toMatchObject({
      title: "grep foo",
      kind: "search",
      status: "completed",
      locations: null,
      rawInput: { pattern: "foo" },
    });
  });

  test("search / fetch / delete / 其它 kind 的 detail", () => {
    const base = { content: null, locations: null, status: null } as const;
    expect(
      mapToolDetail({
        ...base,
        toolCallId: "1",
        title: "grep",
        kind: "search",
        locations: [{ path: "a.ts" }, { path: "b.ts" }],
        rawInput: { pattern: "foo" },
      }),
    ).toEqual({ type: "search", query: "foo", toolName: "search", filePaths: ["a.ts", "b.ts"] });
    expect(
      mapToolDetail({
        ...base,
        toolCallId: "2",
        title: "fetch",
        kind: "fetch",
        rawInput: { url: "https://example.com" },
        content: [{ type: "content", content: { type: "text", text: "页面" } }],
      }),
    ).toEqual({ type: "fetch", url: "https://example.com", result: "页面" });
    expect(
      mapToolDetail({
        ...base,
        toolCallId: "3",
        title: "rm a.txt",
        kind: "delete",
        locations: [{ path: "a.txt" }],
      }),
    ).toEqual({ type: "edit", filePath: "a.txt", newString: "" });
    expect(
      mapToolDetail({ ...base, toolCallId: "4", title: "mystery", kind: "other", rawInput: { x: 1 } }),
    ).toEqual({ type: "unknown", input: { x: 1 }, output: null });
    expect(
      mapToolDetail({
        ...base,
        toolCallId: "5",
        title: "mcp tool",
        kind: null,
        content: [{ type: "content", content: { type: "text", text: "结果" } }],
      }),
    ).toEqual({ type: "plain_text", label: "mcp tool", text: "结果" });
  });

  test("状态映射：pending/in_progress→running，可覆盖为 canceled", () => {
    const snapshot = mergeToolSnapshot({ toolCallId: "t", title: "x", kind: "execute", status: "pending" });
    expect(toolSnapshotToTimelineItem(snapshot).status).toBe("running");
    expect(toolSnapshotToTimelineItem({ ...snapshot, status: "in_progress" }).status).toBe("running");
    expect(toolSnapshotToTimelineItem(snapshot, "canceled").status).toBe("canceled");
  });
});

describe("toAcpPrompt", () => {
  test("字符串 → 单个 text block；图片按能力保留或丢弃", () => {
    expect(toAcpPrompt("hi", null)).toEqual([{ type: "text", text: "hi" }]);
    const parts = [
      { type: "text" as const, text: "看" },
      { type: "image" as const, data: "AA==", mimeType: "image/png" },
    ];
    expect(toAcpPrompt(parts, { image: true })).toEqual([
      { type: "text", text: "看" },
      { type: "image", data: "AA==", mimeType: "image/png" },
    ]);
    let dropped = 0;
    expect(toAcpPrompt(parts, {}, () => (dropped += 1))).toEqual([{ type: "text", text: "看" }]);
    expect(dropped).toBe(1);
  });
});
