// AgentDeck 新增：覆盖移植后适配精简 ToolCallDetail 的部分，以及 zod v4 下 schema 的解析行为。
import { describe, expect, it } from "vitest";

import {
  ToolEditInputSchema,
  ToolGlobOutputSchema,
  ToolGrepOutputSchema,
  ToolReadOutputSchema,
  ToolSearchInputSchema,
  ToolShellInputSchema,
  ToolShellOutputSchema,
  ToolWebFetchInputSchema,
  ToolWebFetchOutputSchema,
  ToolWebSearchOutputSchema,
  ToolWriteInputSchema,
  toEditToolDetail,
  toFetchToolDetail,
  toSearchToolDetail,
  toShellToolDetail,
  toWriteToolDetail,
  toolDetailBranchByName,
} from "./tool-call-detail-primitives.js";
import {
  coerceToolCallId,
  extractCodexShellOutput,
  normalizeToolCallStatus,
  truncateDiffText,
} from "./tool-call-mapper-utils.js";

describe("shell", () => {
  it("parses command arrays and codex output envelopes", () => {
    const input = ToolShellInputSchema.parse({ cmd: ["git", " status "], directory: "/repo" });
    const output = ToolShellOutputSchema.parse({
      aggregated_output: "Chunk ID: 1\nWall time: 0.1s\nProcess exited with code 0\nOutput:\nclean",
      exit_code: 0,
    });
    expect(toShellToolDetail(input, output)).toEqual({
      type: "shell",
      command: "git status",
      cwd: "/repo",
      output: "clean",
      exitCode: 0,
    });
  });

  it("returns undefined without a command", () => {
    expect(toShellToolDetail(null, ToolShellOutputSchema.parse("x"))).toBeUndefined();
  });
});

describe("edit / write", () => {
  it("maps edit input aliases", () => {
    const input = ToolEditInputSchema.parse({
      file_path: " /repo/a.ts ",
      old_string: "a",
      new_string: "b",
    });
    expect(toEditToolDetail(input, null)).toEqual({
      type: "edit",
      filePath: "/repo/a.ts",
      oldString: "a",
      newString: "b",
    });
  });

  it("maps write input and applies normalizePath", () => {
    const input = ToolWriteInputSchema.parse({ path: "a.ts", content: "x" });
    expect(toWriteToolDetail(input, null, { normalizePath: (p) => `/repo/${p}` })).toEqual({
      type: "write",
      filePath: "/repo/a.ts",
      content: "x",
    });
  });
});

describe("read output", () => {
  it("parses xml read output", () => {
    expect(
      ToolReadOutputSchema.parse("<path>/a&amp;b.ts</path><content>\nconst a = 1;\n</content>"),
    ).toEqual({ filePath: "/a&b.ts", content: "const a = 1;" });
  });
});

describe("search（适配精简协议）", () => {
  it("keeps grep content and file paths, drops statistics", () => {
    const output = ToolGrepOutputSchema.parse({
      mode: "content",
      numFiles: 1,
      filenames: ["a.ts"],
      content: "a.ts:1:foo",
      numMatches: 1,
    });
    expect(
      toSearchToolDetail({
        input: ToolSearchInputSchema.parse({ pattern: "foo" }),
        output,
        toolName: "grep",
      }),
    ).toEqual({
      type: "search",
      query: "foo",
      toolName: "grep",
      content: "a.ts:1:foo",
      filePaths: ["a.ts"],
    });
  });

  it("keeps glob file paths only", () => {
    const output = ToolGlobOutputSchema.parse({
      durationMs: 3,
      numFiles: 2,
      filenames: ["a.ts", "b.ts"],
      truncated: false,
    });
    expect(
      toSearchToolDetail({ input: { query: "*.ts" }, output, toolName: "glob" }),
    ).toEqual({ type: "search", query: "*.ts", toolName: "glob", filePaths: ["a.ts", "b.ts"] });
  });

  it("folds web search hits and annotations into content", () => {
    const output = ToolWebSearchOutputSchema.parse({
      query: "zod",
      results: [
        { tool_use_id: "t1", content: [{ title: "Zod", url: "https://zod.dev" }] },
        "summary note",
      ],
      durationSeconds: 1.5,
    });
    expect(
      toSearchToolDetail({ input: { query: "zod" }, output, toolName: "web_search" }),
    ).toEqual({
      type: "search",
      query: "zod",
      toolName: "web_search",
      content: "- Zod (https://zod.dev)\nsummary note",
    });
  });

  it("returns undefined without a query", () => {
    expect(toSearchToolDetail({ input: null })).toBeUndefined();
  });
});

describe("fetch（适配精简协议）", () => {
  it("keeps url / prompt / result only", () => {
    const input = ToolWebFetchInputSchema.parse({ url: "https://a.dev", prompt: "summarize" });
    const output = ToolWebFetchOutputSchema.parse({
      bytes: 10,
      code: 200,
      codeText: "OK",
      result: "done",
      durationMs: 5,
      url: "https://a.dev",
    });
    expect(toFetchToolDetail(input, output)).toEqual({
      type: "fetch",
      url: "https://a.dev",
      prompt: "summarize",
      result: "done",
    });
  });
});

describe("toolDetailBranchByName", () => {
  it("dispatches by tool name and passes parsed input/output", () => {
    const branch = toolDetailBranchByName(
      "Bash",
      ToolShellInputSchema,
      ToolShellOutputSchema,
      toShellToolDetail,
    );
    expect(branch.parse({ name: "Bash", input: { command: "ls" }, output: null })).toEqual({
      type: "shell",
      command: "ls",
    });
    expect(branch.safeParse({ name: "Read", input: {}, output: null }).success).toBe(false);
  });
});

describe("mapper utils", () => {
  it("normalizes tool call status vocabulary", () => {
    expect(normalizeToolCallStatus("Cancelled", null, null)).toBe("canceled");
    expect(normalizeToolCallStatus("success", null, null)).toBe("completed");
    expect(normalizeToolCallStatus("in_progress", null, null)).toBe("running");
    expect(normalizeToolCallStatus(undefined, "boom", null)).toBe("failed");
    expect(normalizeToolCallStatus(undefined, null, "out")).toBe("completed");
  });

  it("leaves non-envelope shell output untouched", () => {
    expect(extractCodexShellOutput("plain output")).toBe("plain output");
  });

  it("truncates long diff text", () => {
    expect(truncateDiffText("abcdef", 3)).toBe("abc\n...[truncated 3 chars]");
  });

  it("coerces missing call ids deterministically", () => {
    const a = coerceToolCallId({ providerPrefix: "acp", rawCallId: "", toolName: "x", input: 1 });
    const b = coerceToolCallId({ providerPrefix: "acp", rawCallId: null, toolName: "x", input: 1 });
    expect(a).toBe(b);
    expect(a.startsWith("acp-")).toBe(true);
    expect(
      coerceToolCallId({ providerPrefix: "acp", rawCallId: "id-1", toolName: "x", input: 1 }),
    ).toBe("id-1");
  });
});
