// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GooseComposer } from "./goose-composer";
import { filterSlashCommands, slashQueryFromInput } from "./slash-command-menu";
import type { ComposerSlashCommand } from "./composer-types";

afterEach(() => cleanup());

describe("slashQueryFromInput", () => {
  it("以 / 开头且光标在首个空白之前时返回查询串", () => {
    expect(slashQueryFromInput("/", 1)).toBe("");
    expect(slashQueryFromInput("/co", 3)).toBe("co");
    expect(slashQueryFromInput("/co", 1)).toBe("co");
    expect(slashQueryFromInput("/co arg", 3)).toBe("co");
  });

  it("不以 / 开头或光标越过首个空白时返回 null", () => {
    expect(slashQueryFromInput("co", 2)).toBeNull();
    expect(slashQueryFromInput(" /co", 4)).toBeNull();
    expect(slashQueryFromInput("/co ", 4)).toBeNull();
    expect(slashQueryFromInput("/co arg", 6)).toBeNull();
  });
});

describe("filterSlashCommands", () => {
  const commands: ComposerSlashCommand[] = [
    { name: "init" },
    { name: "compact" },
    { name: "mcp-compact" },
    { name: "clear", aliases: ["reset", "new"] },
    { name: "Config" },
  ];
  const names = (query: string) => filterSlashCommands(commands, query).map((command) => command.name);

  it("空查询返回全部并保持原顺序", () => {
    expect(names("")).toEqual(["init", "compact", "mcp-compact", "clear", "Config"]);
  });

  it("name 前缀优先，其次 alias 前缀，最后 name 包含；不区分大小写", () => {
    expect(names("co")).toEqual(["compact", "Config", "mcp-compact"]);
    expect(names("CO")).toEqual(["compact", "Config", "mcp-compact"]);
    expect(names("re")).toEqual(["clear"]);
    expect(names("n")).toEqual(["clear", "init", "Config"]);
    expect(names("zzz")).toEqual([]);
  });

  it("alias 前缀排在 name 包含之前", () => {
    expect(names("ne")).toEqual(["clear"]);
    expect(filterSlashCommands([{ name: "xnew" }, { name: "clear", aliases: ["new"] }], "new").map((c) => c.name))
      .toEqual(["clear", "xnew"]);
  });
});

function setup(slashCommands?: ComposerSlashCommand[]) {
  const onSend = vi.fn();
  const onSlashMenuOpen = vi.fn();
  // 用 Enter 发送，才能验证「菜单打开时 Enter 只补全不发送」
  render(
    <GooseComposer
      onSend={onSend}
      submitShortcut="enter"
      slashCommands={slashCommands}
      onSlashMenuOpen={onSlashMenuOpen}
    />,
  );
  const textarea = screen.getByLabelText("输入消息") as HTMLTextAreaElement;
  act(() => textarea.focus());
  const type = (value: string) => fireEvent.change(textarea, { target: { value } });
  return { onSend, onSlashMenuOpen, textarea, type };
}

describe("GooseComposer 斜杠命令补全", () => {
  const commands: ComposerSlashCommand[] = [
    { name: "cost", description: "查看费用" },
    { name: "compact", description: "压缩上下文", argumentHint: "[说明]" },
    { name: "mcp", description: "查看 MCP 服务器", badge: "AgentDeck" },
  ];

  it("输入 /co 出现菜单；↓ + Enter 补全为 /compact 且不发送", () => {
    const { onSend, onSlashMenuOpen, textarea, type } = setup(commands);
    type("/co");
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["/cost查看费用", "/compact[说明]压缩上下文"]);
    expect(onSlashMenuOpen).toHaveBeenCalledTimes(1);
    expect(textarea.getAttribute("aria-activedescendant")).toBe(options[0]!.id);

    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(textarea.value).toBe("/compact ");
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("↑ 从第一项循环到最后一项；Tab 补全；鼠标点击项同样补全", () => {
    const { textarea, type } = setup(commands);
    type("/");
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(textarea.value).toBe("/mcp ");

    type("/c");
    fireEvent.click(screen.getByText("/compact"));
    expect(textarea.value).toBe("/compact ");
  });

  it("Esc 关闭菜单；继续输入后重新出现", () => {
    const { textarea, type } = setup(commands);
    type("/co");
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    type("/com");
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("输入空格、删掉 / 或无匹配时菜单关闭", () => {
    const { type } = setup(commands);
    type("/co");
    expect(screen.getByRole("listbox")).toBeTruthy();
    type("/co ");
    expect(screen.queryByRole("listbox")).toBeNull();
    type("co");
    expect(screen.queryByRole("listbox")).toBeNull();
    type("/zzz");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("菜单关闭时 Enter 照常发送", async () => {
    const { onSend, textarea, type } = setup(commands);
    type("/compact ");
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter" });
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0].text).toBe("/compact");
  });

  it("不传 slashCommands 时输入 / 不出菜单", () => {
    const { textarea, type } = setup();
    type("/");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(textarea.getAttribute("aria-autocomplete")).toBeNull();
  });
});
