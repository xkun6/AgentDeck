import { describe, expect, it } from "vitest";
import { getSourceMeta, groupSourcesByCategory } from "./source-meta";

describe("getSourceMeta", () => {
  it("returns known builtin metadata", () => {
    expect(getSourceMeta("cli")).toMatchObject({ key: "cli", group: "builtin", label: "CLI" });
    expect(getSourceMeta("web")).toMatchObject({ key: "web", group: "builtin", label: "网页" });
    expect(getSourceMeta("tui")).toMatchObject({ key: "tui", group: "builtin", label: "TUI" });
  });

  it("normalizes case and whitespace", () => {
    expect(getSourceMeta(" CLI ").key).toBe("cli");
    expect(getSourceMeta("Wechat").key).toBe("wechat");
  });

  it("classifies known IM platforms", () => {
    expect(getSourceMeta("wechat").group).toBe("im");
    expect(getSourceMeta("feishu").group).toBe("im");
    expect(getSourceMeta("telegram").group).toBe("im");
  });

  it("falls back to webhook group for unknown sources", () => {
    expect(getSourceMeta("zapier")).toMatchObject({ group: "webhook", label: "zapier" });
    expect(getSourceMeta("custom-bot").group).toBe("webhook");
  });

  it("returns unknown placeholder for empty input", () => {
    expect(getSourceMeta(undefined)).toMatchObject({ key: "unknown", label: "未知" });
    expect(getSourceMeta("")).toMatchObject({ key: "unknown" });
    expect(getSourceMeta(null).key).toBe("unknown");
  });
});

describe("groupSourcesByCategory", () => {
  it("groups sources into builtin / im / webhook in order, preserving input order within a group", () => {
    const groups = groupSourcesByCategory([
      { key: "zapier", count: 2 },
      { key: "wechat", count: 8 },
      { key: "cli", count: 23 },
      { key: "web", count: 89 },
    ]);
    expect(groups.map((g) => g.group)).toEqual(["builtin", "im", "webhook"]);
    expect(groups[0].items.map((i) => i.key)).toEqual(["cli", "web"]);
    expect(groups[1].items.map((i) => i.key)).toEqual(["wechat"]);
    expect(groups[2].items.map((i) => i.key)).toEqual(["zapier"]);
  });

  it("omits empty groups", () => {
    const groups = groupSourcesByCategory([
      { key: "cli", count: 23 },
      { key: "web", count: 89 },
    ]);
    expect(groups.map((g) => g.group)).toEqual(["builtin"]);
  });
});
