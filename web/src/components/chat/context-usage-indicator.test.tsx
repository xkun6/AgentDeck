// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  const usage = { contextWindowUsedTokens: 84_100, contextWindowMaxTokens: 200_000 };

  it("渲染圆环与提示文案；没有数据时不渲染", () => {
    const { container, rerender } = render(<ContextUsageIndicator usage={usage} />);
    const ring = screen.getByRole("img", { name: "上下文窗口：已用 42%，84.1k / 200k tokens" });
    expect(ring.getAttribute("tabindex")).toBe("0");
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute("data-level")).toBe("normal");
    const description = document.getElementById(ring.getAttribute("aria-describedby")!);
    expect(description?.textContent).toBe(
      "上下文窗口：已用 42%84.1k / 200k tokens接近上限时 Agent 会自动压缩上下文",
    );
    expect(screen.queryByRole("button")).toBeNull();

    rerender(<ContextUsageIndicator usage={{ contextWindowUsedTokens: 196_000, contextWindowMaxTokens: 200_000 }} />);
    expect((container.firstElementChild as HTMLElement).getAttribute("data-level")).toBe("danger");

    rerender(<ContextUsageIndicator usage={{ contextWindowMaxTokens: 200_000 }} />);
    expect(container.innerHTML).toBe("");
  });

  it("传 onCompact 时渲染「立即压缩上下文」按钮，点击触发并失焦", () => {
    const onCompact = vi.fn();
    render(<ContextUsageIndicator usage={usage} onCompact={onCompact} />);
    expect(screen.getByText("接近上限时 Agent 会自动压缩，也可以手动压缩")).toBeTruthy();
    const button = screen.getByRole("button", { name: "立即压缩上下文" }) as HTMLButtonElement;
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(onCompact).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(button);
  });

  it("compactDisabled 时按钮禁用并以 title 显示原因", () => {
    const onCompact = vi.fn();
    render(
      <ContextUsageIndicator
        usage={usage}
        onCompact={onCompact}
        compactDisabled
        compactDisabledReason="Agent 正在响应，结束后再压缩"
      />,
    );
    const button = screen.getByRole("button", { name: "立即压缩上下文" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Agent 正在响应，结束后再压缩");
    fireEvent.click(button);
    expect(onCompact).not.toHaveBeenCalled();
  });
});
