// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DesktopWindowControls } from "@/lib/runtime";
import { useWindowControls } from "@/hooks/use-window-controls";
import { WindowControls } from "./window-controls";

afterEach(() => {
  cleanup();
  delete window.hermesDesktop;
});

function Harness() {
  const state = useWindowControls();
  return state ? <WindowControls {...state} /> : <span>无窗口控制</span>;
}

function fakeControls(maximized: { value: boolean }) {
  let resized: (() => void) | null = null;
  const controls: DesktopWindowControls = {
    minimize: vi.fn(() => Promise.resolve()),
    toggleMaximize: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    isMaximized: vi.fn(() => Promise.resolve(maximized.value)),
    onResized: vi.fn((handler: () => void) => {
      resized = handler;
      return () => {
        resized = null;
      };
    }),
  };
  return { controls, fireResize: () => resized?.() };
}

describe("WindowControls", () => {
  it("没有 windowControls（纯 web / macOS）时不渲染", () => {
    render(<Harness />);
    expect(screen.getByText("无窗口控制")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
  });

  it("按钮调用窗口 API，最大化图标随 resize 后的 isMaximized 切换", async () => {
    const maximized = { value: false };
    const { controls, fireResize } = fakeControls(maximized);
    window.hermesDesktop = { windowType: "tauri", windowControls: controls };
    render(<Harness />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "最小化" }));
    fireEvent.click(screen.getByRole("button", { name: "最大化" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(controls.minimize).toHaveBeenCalledTimes(1);
    expect(controls.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(controls.close).toHaveBeenCalledTimes(1);

    maximized.value = true;
    await act(async () => {
      fireResize();
    });
    expect(screen.getByRole("button", { name: "还原" })).toBeTruthy();

    maximized.value = false;
    await act(async () => {
      fireResize();
    });
    expect(screen.getByRole("button", { name: "最大化" })).toBeTruthy();
  });
});
