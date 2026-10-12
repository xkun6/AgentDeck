import { describe, expect, it } from "vitest";
import { TOP_TABS } from "./use-active-top-tab";
import { SETTINGS_ITEMS } from "./settings-sidebar";

function tabFor(path: string) {
  return TOP_TABS.find((tab) => tab.matches(path))?.id;
}

describe("TOP_TABS", () => {
  it("把会话、历史、工作空间与终端归到 01 工作台", () => {
    expect(tabFor("/")).toBe("workbench");
    expect(tabFor("/tasks/abc")).toBe("workbench");
    expect(tabFor("/history")).toBe("workbench");
    expect(tabFor("/projects")).toBe("workbench");
    expect(tabFor("/projects/C%3A%5Crepo")).toBe("workbench");
    expect(tabFor("/console")).toBe("workbench");
  });

  it("把设置页归到 02 设置", () => {
    for (const path of ["/common", "/notifications", "/theme", "/coding-agents", "/env", "/about"]) {
      expect(tabFor(path)).toBe("settings");
    }
  });

  it("设置侧栏的每个入口都落在设置标签下", () => {
    for (const item of SETTINGS_ITEMS) {
      expect(tabFor(item.path)).toBe("settings");
    }
  });

  it("只有工作台与设置两个顶部标签", () => {
    expect(TOP_TABS.map((tab) => [tab.num, tab.label])).toEqual([
      ["01", "工作台"],
      ["02", "设置"],
    ]);
  });
});
