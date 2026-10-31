// @vitest-environment jsdom
// 覆盖层与 Android 返回键：返回键先关覆盖层，页面不动；代码关闭时退掉自己压的 history，不多占一次返回。
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ConfirmDialog, Modal } from "./modal";

function Harness({ initialOpen = false }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开
      </button>
      <Modal open={open} onClose={() => setOpen(false)} label="选择" title="选择">
        <button type="button" onClick={() => setOpen(false)}>
          选项
        </button>
      </Modal>
    </>
  );
}

/** 等关闭后推迟一拍的 history.back 发出 */
const flushTimers = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const popstate = () =>
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });

describe("Modal", () => {
  let back: MockInstance<() => void>;
  /** 已发出、还没落地的 history.back：由用例决定它的 popstate 何时到达 */
  let inFlight = 0;
  const landBacks = () => {
    while (inFlight > 0) {
      inFlight -= 1;
      popstate();
    }
  };

  beforeEach(() => {
    window.history.replaceState(null, "", "#/new");
    inFlight = 0;
    back = vi.spyOn(window.history, "back").mockImplementation(() => {
      inFlight += 1;
    });
  });

  afterEach(async () => {
    cleanup();
    await flushTimers();
    landBacks();
    back.mockRestore();
  });

  it("返回键（popstate）只关覆盖层，地址不变，也不再额外退一层 history", async () => {
    render(<Harness />);
    const before = window.history.length;
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    expect(screen.getByRole("dialog", { name: "选择" })).toBeTruthy();
    expect(window.history.length).toBe(before + 1);

    popstate();
    expect(screen.queryByRole("dialog")).toBeNull();
    await flushTimers();
    expect(back).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#/new");
  });

  it("代码关闭时退掉自己压的那条 history", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    fireEvent.click(screen.getByRole("button", { name: "选项" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await flushTimers();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("关闭的同时已经导航走：不退 history，否则会撤销那次导航", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    window.history.replaceState(null, "", "#/hosts");
    fireEvent.click(screen.getByRole("button", { name: "选项" }));
    await flushTimers();
    expect(back).not.toHaveBeenCalled();
  });

  it("关闭后立刻打开下一个：复用 history 记录，新覆盖层不会被关掉", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    const length = window.history.length;
    fireEvent.click(screen.getByRole("button", { name: "选项" }));
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    await flushTimers();
    expect(screen.getByRole("dialog", { name: "选择" })).toBeTruthy();
    expect(window.history.length).toBe(length);
    expect(back).not.toHaveBeenCalled();
  });

  it("自己发起的 back 还在途中时打开新覆盖层，落地的 popstate 不会关掉它", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    fireEvent.click(screen.getByRole("button", { name: "选项" }));
    await flushTimers();
    expect(back).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    landBacks();
    expect(screen.getByRole("dialog", { name: "选择" })).toBeTruthy();
    // 之后真正的返回键仍然能关
    popstate();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("退场动画期间再点选项不会重复触发", () => {
    const fakeAnimation = { cancel: () => {}, onfinish: null };
    const proto = HTMLElement.prototype as unknown as { animate?: () => typeof fakeAnimation };
    proto.animate = () => fakeAnimation;
    try {
      const onPick = vi.fn();
      function Picker() {
        const [open, setOpen] = useState(true);
        return (
          <Modal open={open} onClose={() => setOpen(false)} label="选择">
            <button
              type="button"
              onClick={() => {
                onPick();
                setOpen(false);
              }}
            >
              选项
            </button>
          </Modal>
        );
      }
      render(<Picker />);
      const option = screen.getByRole("button", { name: "选项" });
      fireEvent.click(option);
      // 动画没结束，面板还在
      expect(screen.getByRole("dialog")).toBeTruthy();
      fireEvent.click(option);
      expect(onPick).toHaveBeenCalledTimes(1);
    } finally {
      delete proto.animate;
    }
  });

  it("Esc 能关", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("把手下拉超过阈值关闭，没到阈值回弹", () => {
    render(<Harness initialOpen />);
    const panel = screen.getByRole("dialog");
    const handle = panel.firstElementChild!;
    const drag = (to: number) => {
      fireEvent.touchStart(handle, { touches: [{ clientY: 0 }] });
      fireEvent.touchMove(handle, { touches: [{ clientY: to }] });
      fireEvent.touchEnd(handle);
    };
    // 拖动很慢才不会被算成快速下滑
    let t = 0;
    const now = vi.spyOn(Event.prototype, "timeStamp", "get").mockImplementation(() => (t += 1000));
    drag(40);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(panel.style.transform).toBe("");
    drag(200);
    expect(screen.queryByRole("dialog")).toBeNull();
    now.mockRestore();
  });
});

describe("ConfirmDialog", () => {
  afterEach(cleanup);

  it("确认与取消各走各的回调", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ConfirmDialog open title="删除？" body="说明" confirmLabel="确认删除" danger onConfirm={onConfirm} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
