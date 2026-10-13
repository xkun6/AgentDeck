import { describe, expect, it } from "vitest";
import type { UsageSummary } from "@agentdeck/protocol";
import { fillDays, modelLabel, splitSnippet, tokenShares, usageSinceMs } from "./usage-stats";

const day = (key: string, input = 0): UsageSummary["byDay"][number] => ({
  day: key,
  inputTokens: input,
  outputTokens: 0,
  cachedInputTokens: 0,
  costUsd: 0,
  turns: input > 0 ? 1 : 0,
});

describe("usageSinceMs", () => {
  const now = new Date(2026, 5, 15, 13, 30).getTime();
  it("最近 N 天从 N-1 天前的本地零点算起", () => {
    expect(usageSinceMs("7d", now)).toBe(new Date(2026, 5, 9).getTime());
    expect(usageSinceMs("30d", now)).toBe(new Date(2026, 4, 17).getTime());
  });
  it("全部为 0", () => {
    expect(usageSinceMs("all", now)).toBe(0);
  });
});

describe("fillDays", () => {
  const now = new Date(2026, 5, 15, 13).getTime();
  it("有限范围按日补零并保留已有数据", () => {
    const result = fillDays([day("2026-06-14", 5)], new Date(2026, 5, 13).getTime(), now);
    expect(result.map((item) => [item.day, item.inputTokens])).toEqual([
      ["2026-06-13", 0],
      ["2026-06-14", 5],
      ["2026-06-15", 0],
    ]);
  });
  it("全部：从第一条数据起补到今天；无数据为空", () => {
    expect(fillDays([day("2026-06-14", 1)], 0, now).map((item) => item.day)).toEqual([
      "2026-06-14",
      "2026-06-15",
    ]);
    expect(fillDays([], 0, now)).toEqual([]);
  });
});

describe("tokenShares", () => {
  it("按 输入+输出 计算百分比", () => {
    const shares = tokenShares([
      { inputTokens: 60, outputTokens: 15 },
      { inputTokens: 20, outputTokens: 5 },
    ]);
    expect(shares.map((item) => item.percent)).toEqual([75, 25]);
    expect(tokenShares([{ inputTokens: 0, outputTokens: 0 }])[0]!.percent).toBe(0);
  });
});

describe("misc", () => {
  it("modelLabel", () => {
    expect(modelLabel(null)).toBe("默认模型");
    expect(modelLabel("opus")).toBe("opus");
  });
  it("splitSnippet 越界时收敛", () => {
    expect(splitSnippet("abcdef", 2, 2)).toEqual({ before: "ab", match: "cd", after: "ef" });
    expect(splitSnippet("abc", 2, 10)).toEqual({ before: "ab", match: "c", after: "" });
  });
});
