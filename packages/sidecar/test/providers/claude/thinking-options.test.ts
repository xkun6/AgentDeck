import { describe, expect, test } from "vitest";

import {
  claudeStandardThinkingOptions,
  claudeThinkingArgs,
  claudeThinkingOptionsFor,
  isClaudeThinkingOption,
  normalizeClaudeManifestModelId,
} from "../../../src/providers/claude/thinking-options.js";

const ids = (options: { id: string }[] | undefined) => options?.map((option) => option.id);

describe("Claude 思考档位（paseo 清单规则）", () => {
  test("模型 id 归一化到清单", () => {
    expect(normalizeClaudeManifestModelId("claude-opus-4-6")).toBe("claude-opus-4-6");
    expect(normalizeClaudeManifestModelId("claude-opus-4-6-20260101")).toBe("claude-opus-4-6");
    expect(normalizeClaudeManifestModelId("claude-sonnet-4-6[1m]")).toBe("claude-sonnet-4-6[1m]");
    expect(normalizeClaudeManifestModelId("claude-fable-5-1[1m]")).toBe("claude-fable-5-1");
    expect(normalizeClaudeManifestModelId("opus-5")).toBe("claude-opus-5");
    expect(normalizeClaudeManifestModelId("opus")).toBeNull();
    expect(normalizeClaudeManifestModelId("glm-4.5")).toBeNull();
  });

  test("清单：xhigh 与关闭思考按模型能力；Haiku 4.5 无档位", () => {
    expect(ids(claudeThinkingOptionsFor("claude-opus-4-7"))).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(ids(claudeThinkingOptionsFor("claude-opus-4-6"))).toEqual(["off", "low", "medium", "high", "max"]);
    expect(ids(claudeThinkingOptionsFor("claude-fable-5"))).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(claudeThinkingOptionsFor("claude-haiku-4-5")).toBeUndefined();
  });

  test("无法判断的模型（别名、设置里的模型）给标准组", () => {
    for (const id of ["default", "opus", "sonnet", "haiku", "glm-4.5-air", "opus[1m]"]) {
      expect(ids(claudeThinkingOptionsFor(id))).toEqual(["low", "medium", "high", "max"]);
    }
    expect(ids(claudeStandardThinkingOptions())).toEqual(["low", "medium", "high", "max"]);
  });

  test("initialize 报告的档位优先；resolvedModel 决定能否关闭思考", () => {
    expect(
      ids(claudeThinkingOptionsFor("opus", { supportedEffortLevels: ["low", "xhigh"], resolvedModel: "claude-opus-4-8" })),
    ).toEqual(["off", "low", "xhigh"]);
    expect(ids(claudeThinkingOptionsFor("sonnet", { supportedEffortLevels: ["low", "medium"] }))).toEqual([
      "low",
      "medium",
    ]);
    expect(claudeThinkingOptionsFor("opus", { supportsEffort: false })).toBeUndefined();
    // 报告了空列表 / 全是未知值：视为不支持
    expect(claudeThinkingOptionsFor("opus", { supportedEffortLevels: ["turbo"] })).toBeUndefined();
  });

  test("档位校验与启动参数", () => {
    expect(isClaudeThinkingOption("off")).toBe(true);
    expect(isClaudeThinkingOption("xhigh")).toBe(true);
    expect(isClaudeThinkingOption("ultracode")).toBe(false);
    expect(claudeThinkingArgs(null)).toEqual([]);
    expect(claudeThinkingArgs("off")).toEqual(["--thinking", "disabled"]);
    expect(claudeThinkingArgs("medium")).toEqual(["--effort", "medium"]);
  });
});
