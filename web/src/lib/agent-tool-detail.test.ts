import { describe, expect, it } from "vitest";
import type { ToolCallDetail } from "@agentdeck/protocol";
import { describeToolCall, describeToolDetail } from "./agent-tool-detail";

const QUESTION: Extract<ToolCallDetail, { type: "question" }> = {
  type: "question",
  questions: [
    { question: "用哪个库？", header: "库", multiSelect: false, options: [{ label: "dayjs" }] },
    { question: "启用哪些功能？", multiSelect: true, options: [{ label: "缓存" }, { label: "日志" }] },
  ],
};

describe("describeToolDetail：question（design.md 4.13）", () => {
  it("运行中未作答显示「等待回答」，不出现原始 JSON", () => {
    expect(describeToolDetail(QUESTION, "running")).toEqual({
      context: "用哪个库？（共 2 题）",
      preview: "库",
      output: "用哪个库？ → 等待回答\n启用哪些功能？ → 等待回答",
    });
  });

  it("完成后逐行「问题 → 回答」，缺答案的题显示「未回答」", () => {
    const display = describeToolCall({
      type: "tool_call",
      callId: "q1",
      name: "AskUserQuestion",
      status: "completed",
      detail: { ...QUESTION, answers: { "用哪个库？": "dayjs" } },
    });
    expect(display.output).toBe("用哪个库？ → dayjs\n启用哪些功能？ → 未回答");
  });

  it("只有一题且没有 header 时 preview 退回问题文本", () => {
    const single: ToolCallDetail = {
      type: "question",
      questions: [{ question: "继续吗？", multiSelect: false, options: [{ label: "是" }] }],
      answers: { "继续吗？": "是" },
    };
    expect(describeToolDetail(single, "completed")).toEqual({
      context: "继续吗？",
      preview: "继续吗？",
      output: "继续吗？ → 是",
    });
  });
});
