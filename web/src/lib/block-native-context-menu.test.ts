// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { handleNativeContextMenu } from "./block-native-context-menu";

function fire(target: Element): boolean {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  target.addEventListener("contextmenu", handleNativeContextMenu as EventListener, { once: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

describe("全局屏蔽浏览器右键菜单", () => {
  it("普通元素被阻止", () => {
    document.body.innerHTML = `<div id="a">文本</div>`;
    expect(fire(document.getElementById("a")!)).toBe(true);
  });

  it("textarea / input 不阻止", () => {
    document.body.innerHTML = `<textarea id="t"></textarea><input id="i" />`;
    expect(fire(document.getElementById("t")!)).toBe(false);
    expect(fire(document.getElementById("i")!)).toBe(false);
  });

  it("有非空文本选区时不阻止", () => {
    document.body.innerHTML = `<p id="p">选中的文字</p>`;
    const p = document.getElementById("p")!;
    window.getSelection()!.selectAllChildren(p);
    expect(fire(p)).toBe(false);
  });

  it("事件已被自定义菜单处理（defaultPrevented）时不重复处理", () => {
    document.body.innerHTML = `<div id="a">文本</div>`;
    const el = document.getElementById("a")!;
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    event.preventDefault();
    handleNativeContextMenu(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
