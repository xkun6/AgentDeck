// @vitest-environment jsdom
// 下拉刷新：过阈值松手才刷新，刷新中不重入，手势被系统取消时指示器复位。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePullToRefresh } from "./visual";

function List({ refreshing = false, onRefresh }: { refreshing?: boolean; onRefresh: () => void }) {
  const { handlers, indicator } = usePullToRefresh(onRefresh, refreshing);
  return (
    <>
      <span data-testid="indicator">{indicator}</span>
      <ul data-testid="list" {...handlers} />
    </>
  );
}

const pullTo = (y: number) => {
  const list = screen.getByTestId("list");
  fireEvent.touchStart(list, { touches: [{ clientY: 0 }] });
  fireEvent.touchMove(list, { touches: [{ clientY: y }] });
  return list;
};

describe("usePullToRefresh", () => {
  afterEach(cleanup);

  it("过阈值松手触发刷新，没到阈值不触发", () => {
    const onRefresh = vi.fn();
    render(<List onRefresh={onRefresh} />);
    fireEvent.touchEnd(pullTo(50));
    expect(onRefresh).not.toHaveBeenCalled();
    fireEvent.touchEnd(pullTo(200));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("刷新进行中再次下拉不重复发起", () => {
    const onRefresh = vi.fn();
    render(<List refreshing onRefresh={onRefresh} />);
    fireEvent.touchEnd(pullTo(200));
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("手势被系统取消：指示器消失，不刷新", () => {
    const onRefresh = vi.fn();
    render(<List onRefresh={onRefresh} />);
    const list = pullTo(200);
    expect(screen.getByTestId("indicator").childElementCount).toBe(1);
    fireEvent.touchCancel(list);
    expect(screen.getByTestId("indicator").childElementCount).toBe(0);
    fireEvent.touchEnd(list);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
