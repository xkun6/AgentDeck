// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { stubRadixGlobals } from "@/test-utils/radix";
import type { ComposerAttachment } from "./composer-types";
import { AttachmentTray } from "./goose-composer-attachments";
import { MessageImage } from "./message-image";

stubRadixGlobals();
afterEach(() => cleanup());

function image(id: string, name: string): ComposerAttachment {
  return {
    id,
    source: "browser",
    name,
    kind: "image",
    status: "ready",
    previewUrl: `data:image/png;base64,${id}`,
  };
}

const ATTACHMENTS = [image("AAAA", "a.png"), image("BBBB", "b.png"), image("CCCC", "c.png")];

describe("图片查看器", () => {
  it("点击附件缩略图打开对应图片", () => {
    render(<AttachmentTray attachments={ATTACHMENTS} onRemove={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看大图：b.png" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,BBBB");
    expect(screen.getByTestId("lightbox-counter").textContent).toBe("2 / 3");
  });

  it("点击删除按钮不打开查看器", () => {
    const onRemove = vi.fn();
    render(<AttachmentTray attachments={ATTACHMENTS} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "移除 a.png" }));
    expect(onRemove).toHaveBeenCalledWith("AAAA");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Esc 关闭查看器", () => {
    render(<AttachmentTray attachments={ATTACHMENTS} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "查看大图：a.png" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("多图时方向键切换并更新序号", () => {
    render(<AttachmentTray attachments={ATTACHMENTS} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "查看大图：a.png" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(screen.getByTestId("lightbox-counter").textContent).toBe("2 / 3");
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,BBBB");
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    expect(screen.getByTestId("lightbox-counter").textContent).toBe("1 / 3");
  });

  it("双击图片放大 / 还原", () => {
    render(<AttachmentTray attachments={ATTACHMENTS} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "查看大图：a.png" }));
    const img = screen.getByRole("dialog").querySelector("img")!;
    expect(img.getAttribute("data-zoomed")).toBe("false");
    fireEvent.doubleClick(img);
    expect(img.getAttribute("data-zoomed")).toBe("true");
    fireEvent.doubleClick(img);
    expect(img.getAttribute("data-zoomed")).toBe("false");
  });

  it("放大 / 缩小按钮", () => {
    render(<AttachmentTray attachments={ATTACHMENTS} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "查看大图：a.png" }));
    const img = screen.getByRole("dialog").querySelector("img")!;
    const zoomOut = screen.getByRole("button", { name: "缩小" }) as HTMLButtonElement;
    expect(zoomOut.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    expect(img.getAttribute("data-zoomed")).toBe("true");
    expect(zoomOut.disabled).toBe(false);
    fireEvent.click(zoomOut);
    expect(img.getAttribute("data-zoomed")).toBe("false");
  });

  it("切换图片时还原缩放", () => {
    render(<AttachmentTray attachments={ATTACHMENTS} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "查看大图：a.png" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    expect(dialog.querySelector("img")?.getAttribute("data-zoomed")).toBe("true");
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(dialog.querySelector("img")?.getAttribute("data-zoomed")).toBe("false");
  });

  it("点击消息图片打开查看器，单图无序号", () => {
    render(<MessageImage image={{ url: "data:image/png;base64,ZZZZ", alt: "截图" } as never} />);
    fireEvent.click(screen.getByRole("button", { name: "查看大图：截图" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,ZZZZ");
    expect(screen.queryByTestId("lightbox-counter")).toBeNull();
  });
});
