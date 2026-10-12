import { describe, expect, it } from "vitest";
import { titleFromPrompt } from "./session-title";

describe("session title helpers", () => {
  it("builds a compact title from the first prompt", () => {
    expect(titleFromPrompt("  分析一下\n\n这个项目的架构  ")).toBe(
      "分析一下 这个项目的架构",
    );
  });
});
