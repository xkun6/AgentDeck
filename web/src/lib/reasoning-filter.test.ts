import { describe, expect, it } from "vitest";
import {
  isCliThinkingPlaceholder,
  normalizeCliThinkingProgress,
  normalizeReasoningText,
} from "./reasoning-filter";

describe("reasoning filter", () => {
  it("detects CLI spinner placeholders", () => {
    const placeholder = "ಠ_ಠ deliberating... (⌐■_■) contemplating...";

    expect(isCliThinkingPlaceholder(placeholder)).toBe(true);
    expect(normalizeCliThinkingProgress(placeholder)).toBe(placeholder);
    expect(normalizeReasoningText(placeholder)).toBe("");
  });

  it("keeps real reasoning text", () => {
    const reasoning = "Analyzing the request and checking constraints...";

    expect(isCliThinkingPlaceholder(reasoning)).toBe(false);
    expect(normalizeReasoningText(reasoning)).toBe(reasoning);
  });
});
