import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./chat-types";
import { findMessageIdForSeq, parseFocusSeq } from "./focus-seq";

const msg = (id: string, firstSeq?: number): ChatMessage => ({
  id,
  role: "assistant",
  createdAt: 0,
  ...(firstSeq !== undefined ? { firstSeq } : {}),
});

describe("parseFocusSeq", () => {
  it("只接受正整数", () => {
    expect(parseFocusSeq("12")).toBe(12);
    expect(parseFocusSeq("0")).toBeNull();
    expect(parseFocusSeq("-3")).toBeNull();
    expect(parseFocusSeq("1.5")).toBeNull();
    expect(parseFocusSeq("abc")).toBeNull();
    expect(parseFocusSeq(null)).toBeNull();
  });
});

describe("findMessageIdForSeq", () => {
  const messages = [msg("u1", 1), msg("a1", 2), msg("u2", 10), msg("n", undefined), msg("a2", 11)];
  it("取首个 seq 不大于目标的最后一条消息", () => {
    expect(findMessageIdForSeq(messages, 1)).toBe("u1");
    expect(findMessageIdForSeq(messages, 5)).toBe("a1");
    expect(findMessageIdForSeq(messages, 10)).toBe("u2");
    expect(findMessageIdForSeq(messages, 99)).toBe("a2");
  });
  it("找不到时返回 undefined", () => {
    expect(findMessageIdForSeq([msg("x", 5)], 3)).toBeUndefined();
    expect(findMessageIdForSeq([msg("x")], 3)).toBeUndefined();
    expect(findMessageIdForSeq([], 3)).toBeUndefined();
  });
});
