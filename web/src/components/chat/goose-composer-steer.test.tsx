// @vitest-environment jsdom
// 运行中输入框的「排队」与「插话」（design.md 4.22）
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GooseComposer } from "./goose-composer";

afterEach(cleanup);

// jsdom 没有 createObjectURL
URL.createObjectURL = () => "blob:test";
URL.revokeObjectURL = () => undefined;

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

  it("可排队时附件入口可用；不可排队时仍禁用", () => {
    renderRunning({ onSteer: () => undefined });
    expect((screen.getByRole("button", { name: "添加附件" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "添加剪贴板图片" }) as HTMLButtonElement).disabled).toBe(false);
    cleanup();

    renderRunning({ queueWhileLoading: false });
    expect((screen.getByRole("button", { name: "添加附件" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "添加剪贴板图片" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("运行中粘贴的图片随排队与插话一起提交", async () => {
    const onSend = vi.fn();
    const onSteer = vi.fn();
    renderRunning({ onSend, onSteer });
    const textarea = screen.getByLabelText("输入消息");

    fireEvent.paste(textarea, { clipboardData: clipboardWith(imageFile("a.png")) });
    await screen.findByText("a.png");
    fireEvent.click(screen.getByRole("button", { name: "插话" }));
    await vi.waitFor(() => expect(onSteer).toHaveBeenCalledTimes(1));
    expect(onSteer.mock.calls[0]![0].attachments).toMatchObject([{ name: "a.png", source: "browser" }]);
    await vi.waitFor(() => expect(screen.queryByText("a.png")).toBeNull());

    fireEvent.paste(textarea, { clipboardData: clipboardWith(imageFile("b.png")) });
    await screen.findByText("b.png");
    fireEvent.click(screen.getByRole("button", { name: "排队" }));
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]![0].attachments).toMatchObject([{ name: "b.png", source: "browser" }]);
  });

  it("提交过程中新加的附件不会被清掉", async () => {
    let finish!: () => void;
    const onSend = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    renderRunning({ onSend });
    const textarea = screen.getByLabelText("输入消息");

    fireEvent.paste(textarea, { clipboardData: clipboardWith(imageFile("a.png")) });
    await screen.findByText("a.png");
    fireEvent.click(screen.getByRole("button", { name: "排队" }));
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));

    fireEvent.paste(textarea, { clipboardData: clipboardWith(imageFile("b.png")) });
    await screen.findByText("b.png");
    finish();
    await vi.waitFor(() => expect(screen.queryByText("a.png")).toBeNull());
    expect(screen.getByText("b.png")).toBeTruthy();
  });

  it("initialAttachments 随 initialNonce 回填，路径附件与浏览器文件都能再次提交", async () => {
    const onSend = vi.fn();
    render(
      <MemoryRouter>
        <GooseComposer
          loading
          queueWhileLoading
          onSend={onSend}
          onStop={() => undefined}
          initial="排队的文字"
          initialNonce={1}
          initialAttachments={[
            { id: "p", source: "path", path: "C:/x/spec.md", name: "spec.md", kind: "file", status: "ready" },
            {
              id: "f",
              source: "browser",
              file: imageFile("c.png"),
              name: "c.png",
              kind: "image",
              status: "ready",
              previewUrl: "blob:revoked",
            },
          ]}
        />
      </MemoryRouter>,
    );
    await screen.findByText("spec.md");
    await screen.findByText("c.png");
    fireEvent.click(screen.getByRole("button", { name: "排队" }));
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const { text, attachments } = onSend.mock.calls[0]![0];
    expect(text).toBe("排队的文字");
    expect(attachments).toHaveLength(2);
    expect(attachments[1].previewUrl).not.toBe("blob:revoked");
  });
});

function imageFile(name: string): File {
  return new File(["x"], name, { type: "image/png" });
}

function clipboardWith(file: File) {
  return {
    files: [file],
    items: [{ kind: "file", type: file.type, getAsFile: () => file }],
    types: ["Files"],
    getData: () => "",
  };
}
