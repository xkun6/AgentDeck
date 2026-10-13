// @vitest-environment jsdom
// 输入框为空时按 ↑ 触发撤回（design.md 4.16）；有内容时保持默认行为。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { GooseComposer } from "./goose-composer";

afterEach(cleanup);

function renderComposer(props: Parameters<typeof GooseComposer>[0]) {
  render(
    <MemoryRouter>
      <GooseComposer {...props} />
    </MemoryRouter>,
  );
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

describe("GooseComposer ↑ 撤回", () => {
  it("输入框为空时 ↑ 调用 onEmptyArrowUp 并阻止默认行为", () => {
    const onEmptyArrowUp = vi.fn(() => true);
    const textarea = renderComposer({ onEmptyArrowUp });
    const notPrevented = fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(onEmptyArrowUp).toHaveBeenCalledTimes(1);
    expect(notPrevented).toBe(false);
  });

  it("宿主返回 false 时不阻止默认行为", () => {
    const textarea = renderComposer({ onEmptyArrowUp: () => false });
    expect(fireEvent.keyDown(textarea, { key: "ArrowUp" })).toBe(true);
  });

  it("输入框有内容时 ↑ 不触发", () => {
    const onEmptyArrowUp = vi.fn(() => true);
    const textarea = renderComposer({ onEmptyArrowUp, initial: "草稿" });
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(onEmptyArrowUp).not.toHaveBeenCalled();
  });
});
