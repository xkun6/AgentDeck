// @vitest-environment jsdom
// 运行中输入框的「排队」与「插话」（design.md 4.22）
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GooseComposer } from "./goose-composer";

afterEach(cleanup);

function renderRunning(props: { onSteer?: () => void; onSend?: () => void; queueWhileLoading?: boolean }) {
  return render(
    <MemoryRouter>
      <GooseComposer
        loading
        queueWhileLoading={props.queueWhileLoading ?? true}
        onSend={props.onSend ?? (() => undefined)}
        onSteer={props.onSteer}
        onStop={() => undefined}
        submitShortcut="enter"
        initial="补充一句"
      />
    </MemoryRouter>,
  );
}

describe("GooseComposer 运行中（loading）", () => {
  it("支持插话时同时显示「排队」与「插话」；不支持时只显示「排队」", () => {
    renderRunning({ onSteer: () => undefined });
    expect(screen.getByRole("button", { name: "排队" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "插话" })).toBeTruthy();
    cleanup();

    renderRunning({});
    expect(screen.getByRole("button", { name: "排队" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "插话" })).toBeNull();
  });

  it("没有 queueWhileLoading 时运行中不出现排队 / 插话按钮", () => {
    renderRunning({ queueWhileLoading: false, onSteer: () => undefined });
    expect(screen.queryByRole("button", { name: "排队" })).toBeNull();
    expect(screen.queryByRole("button", { name: "插话" })).toBeNull();
  });

  it("Enter 排队、Ctrl+Enter 插话", async () => {
    const onSend = vi.fn();
    const onSteer = vi.fn();
    renderRunning({ onSend, onSteer });
    const textarea = screen.getByLabelText("输入消息");

    fireEvent.keyDown(textarea, { key: "Enter" });
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSteer).not.toHaveBeenCalled();
    expect(onSend.mock.calls[0]![0]).toMatchObject({ text: "补充一句" });
  });

  it("Ctrl+Enter 调用 onSteer，不触发排队", async () => {
    const onSend = vi.fn();
    const onSteer = vi.fn();
    renderRunning({ onSend, onSteer });
    fireEvent.keyDown(screen.getByLabelText("输入消息"), { key: "Enter", ctrlKey: true });
    await vi.waitFor(() => expect(onSteer).toHaveBeenCalledTimes(1));
    expect(onSend).not.toHaveBeenCalled();
    expect(onSteer.mock.calls[0]![0]).toMatchObject({ text: "补充一句" });
  });

  it("点击「插话」按钮调用 onSteer", async () => {
    const onSteer = vi.fn();
    renderRunning({ onSteer });
    fireEvent.click(screen.getByRole("button", { name: "插话" }));
    await vi.waitFor(() => expect(onSteer).toHaveBeenCalledTimes(1));
  });
});
