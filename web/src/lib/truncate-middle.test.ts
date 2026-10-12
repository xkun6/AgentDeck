import { describe, expect, it } from "vitest";
import { truncateMiddle } from "./truncate-middle";

describe("truncateMiddle", () => {
  it("returns empty string for nullish input", () => {
    expect(truncateMiddle(null)).toBe("");
    expect(truncateMiddle(undefined)).toBe("");
    expect(truncateMiddle("")).toBe("");
  });

  it("returns input unchanged when within maxLength", () => {
    expect(truncateMiddle("short", 10)).toBe("short");
    expect(truncateMiddle("exactly10c", 10)).toBe("exactly10c");
  });

  it("preserves both ends with ellipsis in the middle", () => {
    const path = "/Users/claw/Documents/GithubProjects/hermes/hermes-agent-cn-ui-v2/apps/web/src/lib";
    const out = truncateMiddle(path, 30);
    expect(out.length).toBe(30);
    expect(out).toContain("…");
    expect(out.startsWith("/Users/claw/Doc")).toBe(true);
    expect(out.endsWith("/web/src/lib")).toBe(true);
  });

  it("keeps file basename visible at the tail", () => {
    const path = "/very/long/path/that/keeps/going/and/going/somefile.tsx";
    const out = truncateMiddle(path, 30);
    expect(out.endsWith("somefile.tsx")).toBe(true);
  });

  it("falls back to head slice when maxLength is too small for ellipsis", () => {
    expect(truncateMiddle("hello world", 2)).toBe("he");
  });
});
