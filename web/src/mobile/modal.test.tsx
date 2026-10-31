// @vitest-environment jsdom
// 覆盖层与 Android 返回键：返回键先关覆盖层，页面不动；代码关闭时退掉自己压的 history，不多占一次返回。
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ConfirmDialog, Modal } from "./modal";
import { replaceOverlayEntry } from "./overlay-history";
import { useHashRoute } from "./use-route";

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

  it("同时开着两个：一次返回只关最上面一个，再按一次关下面的，历史不留多余记录", async () => {
    function Two() {
      const [a, setA] = useState(true);
      const [b, setB] = useState(true);
      return (
        <>
          <Modal open={a} onClose={() => setA(false)} label="下面">
            内容
          </Modal>
          <Modal open={b} onClose={() => setB(false)} label="上面">
            内容
          </Modal>
        </>
      );
    }
    const before = window.history.length;
    render(<Two />);
    expect(window.history.length).toBe(before + 1);

    popstate();
    expect(screen.queryByRole("dialog", { name: "上面" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "下面" })).toBeTruthy();
    popstate();
    expect(screen.queryByRole("dialog")).toBeNull();
    await flushTimers();
    expect(back).not.toHaveBeenCalled();
  });

  it("关闭其中一个时不退 history，全部关闭才退", async () => {
    function Two() {
      const [a, setA] = useState(true);
      const [b, setB] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setA(false)}>
            关A
          </button>
          <button type="button" onClick={() => setB(false)}>
            关B
          </button>
          <Modal open={a} onClose={() => setA(false)} label="A">
            内容
          </Modal>
          <Modal open={b} onClose={() => setB(false)} label="B">
            内容
          </Modal>
        </>
      );
    }
    render(<Two />);
    fireEvent.click(screen.getByRole("button", { name: "关A", hidden: true }));
    await flushTimers();
    expect(back).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "关B", hidden: true }));
    await flushTimers();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("覆盖层开着时跳转：新页面顶替那条记录并关掉覆盖层，历史不留重复项", async () => {
    function Page() {
      const { route, navigate } = useHashRoute();
      const [open, setOpen] = useState(true);
      return (
        <>
          <span>当前：{route.name}</span>
          <Modal open={open} onClose={() => setOpen(false)} label="确认">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                navigate({ name: "hosts" });
              }}
            >
              确认
            </button>
          </Modal>
        </>
      );
    }
    const before = window.history.length;
    render(<Page />);
    expect(window.history.length).toBe(before + 1);
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    expect(window.location.hash).toBe("#/hosts");
    expect(screen.getByText("当前：hosts")).toBeTruthy();
    // 没有再压一条，也没有退：[…, #/new, #/hosts]
    expect(window.history.length).toBe(before + 1);
    await flushTimers();
    expect(back).not.toHaveBeenCalled();
  });

  it("没有覆盖层时跳转照常走 hash，新增一条历史", () => {
    expect(replaceOverlayEntry("#/hosts")).toBe(false);
    expect(window.location.hash).toBe("#/new");
  });

  it("退场中被重新打开：取消遮罩动画，清掉拖动留下的位移", () => {
    const cancel = vi.fn();
    const proto = HTMLElement.prototype as unknown as { animate?: () => unknown };
    proto.animate = () => ({ cancel, onfinish: null });
    try {
      render(<Harness initialOpen />);
      const panel = screen.getByRole("dialog");
      panel.style.transform = "translateY(200px)";
      fireEvent.keyDown(panel, { key: "Escape" });
      expect(cancel).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "打开", hidden: true }));
      // 面板和遮罩的退场动画都取消了
      expect(cancel).toHaveBeenCalledTimes(2);
      expect(panel.style.transform).toBe("");
    } finally {
      delete proto.animate;
    }
  });

  it("退场动画期间内容保持关闭前的样子", () => {
    const proto = HTMLElement.prototype as unknown as { animate?: () => unknown };
    proto.animate = () => ({ cancel: () => {}, onfinish: null });
    try {
      const { rerender } = render(
        <ConfirmDialog open title="删除？" body="将删除与「书房电脑」的配对" confirmLabel="确认" onConfirm={() => {}} onClose={() => {}} />,
      );
      rerender(<ConfirmDialog open={false} title="删除？" body="将删除与「」的配对" confirmLabel="确认" onConfirm={() => {}} onClose={() => {}} />);
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(screen.getByText("将删除与「书房电脑」的配对")).toBeTruthy();
    } finally {
      delete proto.animate;
    }
  });

  it("手势被系统取消：面板复位，不关闭", () => {
    render(<Harness initialOpen />);
    const panel = screen.getByRole("dialog");
    const handle = panel.firstElementChild!;
    fireEvent.touchStart(handle, { touches: [{ clientY: 0 }] });
    fireEvent.touchMove(handle, { touches: [{ clientY: 200 }] });
    expect(panel.style.transform).toBe("translateY(200px)");
    fireEvent.touchCancel(handle);
    expect(panel.style.transform).toBe("");
    expect(panel.style.transition).toBe("");
    fireEvent.touchEnd(handle);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  describe("快速下滑", () => {
    let t = 0;
    let now: MockInstance;
    beforeEach(() => {
      t = 0;
      now = vi.spyOn(Event.prototype, "timeStamp", "get").mockImplementation(() => t);
    });
    afterEach(() => now.mockRestore());

    const gesture = (startY: number, moves: Array<[at: number, y: number]>, endAt: number) => {
      render(<Harness initialOpen />);
      const handle = screen.getByRole("dialog").firstElementChild!;
      fireEvent.touchStart(handle, { touches: [{ clientY: startY }] });
      for (const [at, y] of moves) {
        t = at;
        fireEvent.touchMove(handle, { touches: [{ clientY: y }] });
      }
      t = endAt;
      fireEvent.touchEnd(handle);
    };

    it("手指还在动就松手：距离不够也关闭", () => {
      gesture(0, [[10, 40]], 20);
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("快划后停住再松手：不关闭", () => {
      gesture(0, [[10, 40]], 500);
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    it("先上移到起点上方再快速下划，面板没被拖动过：不关闭", () => {
      gesture(100, [[10, 0], [20, 50]], 25);
      expect(screen.getByRole("dialog")).toBeTruthy();
    });
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
