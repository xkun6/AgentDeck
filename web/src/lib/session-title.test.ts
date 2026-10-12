import { describe, expect, it } from "vitest";
import {
  sessionDisplayTitle,
  titleFromPrompt,
  titleWithSessionSuffix,
} from "./session-title";

describe("session title helpers", () => {
  it("builds a compact title from the first prompt", () => {
    expect(titleFromPrompt("  分析一下\n\n这个项目的架构  ")).toBe(
      "分析一下 这个项目的架构",
    );
  });

  it("falls back from title to preview to id for display", () => {
    expect(
      sessionDisplayTitle({
        id: "20260426_000000_abcd",
        title: "",
        preview: "帮我检查 UI 会话标题",
      }),
    ).toBe("帮我检查 UI 会话标题");

    expect(
      sessionDisplayTitle({
        id: "20260426_000000_abcd",
        title: null,
        preview: "",
      }),
    ).toBe("20260426_000000_abcd");
  });

  it("can add a session suffix after duplicate-title failures", () => {
    expect(titleWithSessionSuffix("重复标题", "20260426_000000_abcd12")).toBe(
      "重复标题 abcd12",
    );
  });
});
