// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ContextUsageIndicator, summarizeContextUsage } from "./context-usage-indicator";

afterEach(() => cleanup());

describe("summarizeContextUsage", () => {
  it("按已用 / 上限计算百分比与阈值：>= 80% 警告，>= 95% 危险", () => {
    expect(summarizeContextUsage({ contextWindowUsedTokens: 84_100, contextWindowMaxTokens: 200_000 })).toEqual({
      used: 84_100,
      max: 200_000,
      percent: 42,
      level: "normal",
    });
    expect(summarizeContextUsage({ contextWindowUsedTokens: 160_000, contextWindowMaxTokens: 200_000 })?.level).toBe("warning");
    expect(summarizeContextUsage({ contextWindowUsedTokens: 190_000, contextWindowMaxTokens: 200_000 })?.level).toBe("danger");
    expect(summarizeContextUsage({ contextWindowUsedTokens: 250_000, contextWindowMaxTokens: 200_000 })?.percent).toBe(100);
  });

  it("缺已用或上限时返回 null", () => {
    expect(summarizeContextUsage(undefined)).toBeNull();
    expect(summarizeContextUsage({ contextWindowMaxTokens: 200_000 })).toBeNull();
    expect(summarizeContextUsage({ contextWindowUsedTokens: 1_000 })).toBeNull();
    expect(summarizeContextUsage({ contextWindowUsedTokens: 0, contextWindowMaxTokens: 200_000 })).toBeNull();
  });
});

describe("ContextUsageIndicator", () => {
  it("渲染圆环与提示文案；没有数据时不渲染", () => {
    const { container, rerender } = render(
      <ContextUsageIndicator usage={{ contextWindowUsedTokens: 84_100, contextWindowMaxTokens: 200_000 }} />,
    );
    const indicator = screen.getByRole("img", { name: "上下文窗口：已用 42%，84.1k / 200k tokens" });
    expect(indicator.getAttribute("data-level")).toBe("normal");
    expect(indicator.getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("tooltip").textContent).toBe(
      "上下文窗口：已用 42%84.1k / 200k tokens接近上限时 Agent 会自动压缩上下文",
    );

    rerender(<ContextUsageIndicator usage={{ contextWindowUsedTokens: 196_000, contextWindowMaxTokens: 200_000 }} />);
    expect(screen.getByRole("img").getAttribute("data-level")).toBe("danger");

    rerender(<ContextUsageIndicator usage={{ contextWindowMaxTokens: 200_000 }} />);
    expect(container.innerHTML).toBe("");
  });
});
