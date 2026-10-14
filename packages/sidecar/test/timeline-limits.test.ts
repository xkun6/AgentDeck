import type { AgentTimelineItem } from "@agentdeck/protocol";
import { describe, expect, test } from "vitest";

import {
  TIMELINE_ITEM_TEXT_BUDGET,
  imagePlaceholder,
  limitTimelineItem,
} from "../src/agent/timeline-limits.js";

function unknownTool(output: unknown, input: unknown = { a: 1 }): AgentTimelineItem {
  return {
    type: "tool_call",
    callId: "c1",
    name: "mcp__x__y",
    status: "completed",
    detail: { type: "unknown", input, output },
  };
}

describe("limitTimelineItem", () => {
  test("未超限的项原样返回同一引用", () => {
    const item = unknownTool({ ok: true, text: "short" });
    expect(limitTimelineItem(item)).toBe(item);
    const message: AgentTimelineItem = { type: "assistant_message", text: "你好" };
    expect(limitTimelineItem(message)).toBe(message);
  });

  test("超长文本截断到预算附近并注明被截断的字符数", () => {
    const item: AgentTimelineItem = {
      type: "tool_call",
      callId: "c1",
      name: "Bash",
      status: "completed",
      detail: { type: "shell", command: "ls", output: "x".repeat(200_000), exitCode: 0 },
    };
    const limited = limitTimelineItem(item);
    expect(limited).not.toBe(item);
    const output = (limited as { detail: { output: string } }).detail.output;
    expect(output.startsWith("x".repeat(1000))).toBe(true);
    expect(output.length).toBeLessThan(TIMELINE_ITEM_TEXT_BUDGET + 100);
    expect(output).toMatch(/…\[已截断 \d+ 字符\]$/);
    const kept = output.indexOf("…[已截断");
    expect(kept + Number(/已截断 (\d+) 字符/.exec(output)![1])).toBe(200_000);
    // 原对象未被修改
    expect((item as { detail: { output: string } }).detail.output.length).toBe(200_000);
  });

  test("多个字段共用预算，预算用尽后每个字段仍保留 1024 字符", () => {
    const item = unknownTool({
      a: "1".repeat(100_000),
      b: "2".repeat(100_000),
      c: "3".repeat(5_000),
    });
    const output = (limitTimelineItem(item) as { detail: { output: Record<string, string> } })
      .detail.output;
    expect(output.a!.length).toBeGreaterThan(60_000);
    expect(output.b!.startsWith("2".repeat(1024))).toBe(true);
    expect(output.b!.length).toBeLessThan(1200);
    expect(output.c!.length).toBeLessThan(1200);
  });

  test("图片块（type=image / source.base64）整体替换为占位文本，按 3/4 估算大小", () => {
    const data = "A".repeat(Math.round((1_048_576 * 4) / 3)); // 约 1 MB 原始数据
    const limited = limitTimelineItem(
      unknownTool([
        { type: "image", source: { type: "base64", media_type: "image/png", data } },
        { type: "text", text: "说明" },
        { type: "image", file: { base64: "B".repeat(2048), type: "image/png" } },
      ]),
    ) as { detail: { output: Array<{ type: string; text: string }> } };
    expect(limited.detail.output).toEqual([
      { type: "text", text: "[图片 约 1024 KB，已省略]" },
      { type: "text", text: "说明" },
      { type: "text", text: "[图片 约 2 KB，已省略]" },
    ]);
    expect(imagePlaceholder(10)).toBe("[图片 约 1 KB，已省略]");
  });

  test("带 image mime 的 data/base64 字段、data:image URL 字符串也被占位", () => {
    const limited = limitTimelineItem(
      unknownTool({
        shot: { mimeType: "image/jpeg", data: "Z".repeat(4096) },
        url: `data:image/png;base64,${"Q".repeat(8192)}`,
        notImage: { mimeType: "text/plain", data: "t".repeat(4096) },
      }),
    ) as { detail: { output: Record<string, unknown> } };
    expect(limited.detail.output.shot).toEqual({ type: "text", text: "[图片 约 3 KB，已省略]" });
    expect(limited.detail.output.url).toBe("[图片 约 6 KB，已省略]");
    expect(limited.detail.output.notImage).toEqual({
      mimeType: "text/plain",
      data: "t".repeat(4096),
    });
  });

  test("不在代理对中间截断", () => {
    // 预算 2000，其中 "assistant_message"（17 字符）先占用，text 可用 1983 字符
    const text = `${"a".repeat(1982)}😀${"b".repeat(100)}`;
    const limited = limitTimelineItem({ type: "assistant_message", text }, 2000) as {
      text: string;
    };
    expect(limited.text.slice(0, 1982)).toBe("a".repeat(1982));
    expect(limited.text.charCodeAt(1982)).toBe(0x2026);
  });
});
