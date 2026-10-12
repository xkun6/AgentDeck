import { describe, expect, it } from "vitest";
import { buildConfigUpdateRequest } from "./use-config";

describe("buildConfigUpdateRequest", () => {
  it("wraps the config object for PUT /api/config", () => {
    expect(buildConfigUpdateRequest({ model: "qwen", approval: { mode: "manual" } }))
      .toEqual({
        config: { model: "qwen", approval: { mode: "manual" } },
      });
  });
});
