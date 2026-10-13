// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSidePanelSelection } from "./use-side-panel-selection";

describe("useSidePanelSelection", () => {
  it("子代理面板与后台任务面板互斥：打开一个关闭另一个", () => {
    const { result } = renderHook(() => useSidePanelSelection("a1"));
    expect(result.current.openSubagentId).toBeNull();
    expect(result.current.openTaskId).toBeNull();

    act(() => result.current.openSubagent("sub1"));
    expect(result.current.openSubagentId).toBe("sub1");
    expect(result.current.openTaskId).toBeNull();

    act(() => result.current.openTask("bk1"));
    expect(result.current.openSubagentId).toBeNull();
    expect(result.current.openTaskId).toBe("bk1");

    act(() => result.current.openSubagent("sub2"));
    expect(result.current.openTaskId).toBeNull();
    expect(result.current.openSubagentId).toBe("sub2");

    act(() => result.current.close());
    expect(result.current.openSubagentId).toBeNull();
    expect(result.current.openTaskId).toBeNull();
  });

  it("换会话时全部关闭", () => {
    const { result, rerender } = renderHook(({ id }) => useSidePanelSelection(id), { initialProps: { id: "a1" } });
    act(() => result.current.openTask("bk1"));
    expect(result.current.openTaskId).toBe("bk1");
    rerender({ id: "a2" });
    expect(result.current.openTaskId).toBeNull();
  });
});
