// @vitest-environment jsdom
// 设置页「连接诊断」：最近 20 条（最新在上）、复制全部（剪贴板失败时退回文本框全选）、清空。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ConnectionEventLog } from "@/lib/connection-log";
import { ConnectionDiagnosticsSection, DIAGNOSTICS_VISIBLE } from "./connection-diagnostics";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function filledLog(count: number): ConnectionEventLog {
  const log = new ConnectionEventLog();
  for (let i = 0; i < count; i++) log.push({ event: i % 2 === 0 ? "open" : "close", code: 1000 + i, trigger: "hint" });
  return log;
}

describe("连接诊断小节", () => {
  it("空记录：显示暂无记录，按钮禁用", () => {
    render(<ConnectionDiagnosticsSection log={new ConnectionEventLog()} />);
    expect(screen.getByText("暂无记录")).toBeTruthy();
    expect((screen.getByRole("button", { name: "复制全部" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "清空" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("只显示最近 20 条，最新在上，每行含事件、触发路径与 code", () => {
    render(<ConnectionDiagnosticsSection log={filledLog(30)} />);
    const items = within(screen.getByRole("list", { name: "连接事件" })).getAllByRole("listitem");
    expect(items).toHaveLength(DIAGNOSTICS_VISIBLE);
    expect(items[0]!.textContent).toContain("code=1029");
    expect(items[0]!.textContent).toContain("hint(回前台)");
    expect(items[DIAGNOSTICS_VISIBLE - 1]!.textContent).toContain("code=1010");
  });

  it("复制全部：写入剪贴板的是全部条目的 JSON（不止显示的 20 条）", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<ConnectionDiagnosticsSection log={filledLog(30)} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复制全部" }));
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeText.mock.calls[0]![0] as string)).toHaveLength(30);
    expect(screen.getByRole("button", { name: "已复制" })).toBeTruthy();
  });

  it("剪贴板不可用：退回展示可全选的文本框", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    render(<ConnectionDiagnosticsSection log={filledLog(3)} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复制全部" }));
    });
    const area = screen.getByRole("textbox", { name: "连接诊断全文" }) as HTMLTextAreaElement;
    expect(JSON.parse(area.value)).toHaveLength(3);
  });

  it("清空：记录与列表清掉", () => {
    const log = filledLog(5);
    render(<ConnectionDiagnosticsSection log={log} />);
    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(log.entries()).toEqual([]);
    expect(screen.getByText("暂无记录")).toBeTruthy();
  });
});
