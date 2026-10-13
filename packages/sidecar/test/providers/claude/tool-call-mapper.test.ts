// Derived from paseo packages/server/src/server/agent/providers/claude/tool-call-mapper.test.ts (Apache-2.0); modified for AgentDeck
// 改动：协议 detail 为精简版（统计字段丢弃、web_search 结果折叠进 content），error 为字符串；去掉 speak；新增 Task / outputCandidates 用例。
import { describe, expect, it } from "vitest";

import {
  mapClaudeCanceledToolCall,
  mapClaudeCompletedToolCall,
  mapClaudeFailedToolCall,
  mapClaudeRunningToolCall,
} from "../../../src/providers/claude/tool-call-mapper.js";

function expectMapped<T>(item: T | null): T {
  expect(item).toBeTruthy();
  if (!item) {
    throw new Error("Expected mapped tool call");
  }
  return item;
}

describe("claude tool-call mapper", () => {
  it("running 的 Bash 映射为 shell detail", () => {
    const item = expectMapped(
      mapClaudeRunningToolCall({
        callId: "claude-call-1",
        name: "Bash",
        input: { command: "pwd", cwd: "/tmp/repo" },
        output: null,
      }),
    );
    expect(item).toMatchObject({
      type: "tool_call",
      status: "running",
      error: null,
      callId: "claude-call-1",
      name: "Bash",
      detail: { type: "shell", command: "pwd", cwd: "/tmp/repo" },
    });
  });

  it("Windows 上的 PowerShell 工具同样映射为 shell", () => {
    const item = expectMapped(
      mapClaudeCompletedToolCall({
        callId: "ps-1",
        name: "PowerShell",
        input: { command: "echo agentdeck-smoke", description: "打印" },
        outputCandidates: ["agentdeck-smoke", null],
      }),
    );
    expect(item.name).toBe("PowerShell");
    expect(item.detail).toEqual({
      type: "shell",
      command: "echo agentdeck-smoke",
      output: "agentdeck-smoke",
    });
  });

  it("running 状态下已知工具也给出 detail", () => {
    expect(
      expectMapped(
        mapClaudeRunningToolCall({ callId: "r", name: "Read", input: { file_path: "README.md" } }),
      ).detail,
    ).toEqual({ type: "read", filePath: "README.md" });
    expect(
      expectMapped(
        mapClaudeRunningToolCall({ callId: "w", name: "Write", input: { file_path: "src/new.ts" } }),
      ).detail,
    ).toEqual({ type: "write", filePath: "src/new.ts" });
    expect(
      expectMapped(
        mapClaudeRunningToolCall({ callId: "e", name: "Edit", input: { file_path: "src/index.ts" } }),
      ).detail,
    ).toEqual({ type: "edit", filePath: "src/index.ts" });
    expect(
      expectMapped(
        mapClaudeRunningToolCall({
          callId: "s",
          name: "WebSearch",
          input: { query: "tool call mapping" },
        }),
      ).detail,
    ).toEqual({ type: "search", query: "tool call mapping", toolName: "web_search" });
  });

  it("completed 的 Bash 带文本输出", () => {
    const item = expectMapped(
      mapClaudeCompletedToolCall({
        callId: "c1",
        name: "Bash",
        input: { command: "echo hi" },
        outputCandidates: ["hi\n", { output: "hi\n" }, null],
      }),
    );
    expect(item.status).toBe("completed");
    expect(item.detail).toEqual({ type: "shell", command: "echo hi", output: "hi\n" });
  });

  it("completed 的 Read 剥离行号槽并保留内容", () => {
    const item = expectMapped(
      mapClaudeCompletedToolCall({
        callId: "c2",
        name: "Read",
        input: { file_path: "README.md" },
        outputCandidates: ["     1\thello\n     2\tworld", null],
      }),
    );
    expect(item.detail).toMatchObject({ type: "read", filePath: "README.md", content: "hello\nworld" });
  });

  it("read 输出的数组 / 对象变体", () => {
    const arrayContent = expectMapped(
      mapClaudeCompletedToolCall({
        callId: "claude-read-array",
        name: "read_file",
        input: { file_path: "README.md" },
        output: {
          content: [
            { type: "output_text", text: "alpha" },
            { type: "output_text", content: "beta" },
          ],
        },
      }),
    );
    expect(arrayContent.detail).toMatchObject({ type: "read", content: "alpha\nbeta" });
  });

  it("failed 调用 error 为字符串", () => {
    const item = expectMapped(
      mapClaudeFailedToolCall({
        callId: "claude-call-3",
        name: "Bash",
        input: { command: "false" },
        output: null,
        error: { message: "Command failed" },
      }),
    );
    expect(item.status).toBe("failed");
    expect(item.error).toBe("Command failed");
    expect(item.detail).toEqual({ type: "shell", command: "false" });

    const plain = expectMapped(
      mapClaudeFailedToolCall({ callId: "x", name: "Bash", input: { command: "x" }, error: "boom" }),
    );
    expect(plain.error).toBe("boom");
  });

  it("canceled 状态", () => {
    const item = expectMapped(
      mapClaudeCanceledToolCall({ callId: "x", name: "Bash", input: { command: "sleep 9" } }),
    );
    expect(item.status).toBe("canceled");
    expect(item.error).toBeNull();
  });

  it("write / edit 使用输入构造 detail", () => {
    const writeItem = expectMapped(
      mapClaudeCompletedToolCall({
        callId: "claude-write-1",
        name: "Write",
        input: { file_path: "src/new.ts", content: "export const x = 1;" },
      }),
    );
    expect(writeItem.detail).toEqual({
      type: "write",
      filePath: "src/new.ts",
      content: "export const x = 1;",
    });

    const editItem = expectMapped(
      mapClaudeCompletedToolCall({
        callId: "claude-edit-1",
        name: "Edit",
        input: { file_path: "src/index.ts", old_string: "old", new_string: "new" },
      }),
    );
    expect(editItem.detail).toEqual({
      type: "edit",
      filePath: "src/index.ts",
      oldString: "old",
      newString: "new",
    });
  });

  it("未知工具映射为 unknown 并保留原始输入输出", () => {
    const item = expectMapped(
      mapClaudeCompletedToolCall({
        callId: "claude-call-4",
        name: "my_custom_tool",
        input: { foo: "bar" },
        output: { ok: true },
      }),
    );
    expect(item.detail).toEqual({ type: "unknown", input: { foo: "bar" }, output: { ok: true } });
  });

  it("未知工具 + outputCandidates：取第一个非空候选作为 unknown 输出", () => {
    const item = expectMapped(
      mapClaudeCompletedToolCall({
        callId: "mcp-1",
        name: "mcp__foo__bar",
        input: { a: 1 },
        outputCandidates: ["文本结果", { output: "文本结果" }, null],
      }),
    );
    expect(item.detail).toEqual({ type: "unknown", input: { a: 1 }, output: "文本结果" });
  });

  it("Glob 结构化输出映射为 search（统计字段丢弃）", () => {
    const item = expectMapped(
      mapClaudeCompletedToolCall({
        callId: "claude-glob-1",
        name: "Glob",
        input: { pattern: "**/*.ts" },
        output: { durationMs: 7, numFiles: 2, filenames: ["a.ts", "b.ts"], truncated: false },
      }),
    );
    expect(item.detail).toEqual({
      type: "search",
      query: "**/*.ts",
      toolName: "glob",
      filePaths: ["a.ts", "b.ts"],
    });
  });

  it("Grep 结构化输出与字符串包装两种形状", () => {
    const structured = expectMapped(
      mapClaudeCompletedToolCall({
        callId: "claude-grep-1",
        name: "Grep",
        input: { pattern: "cli", output_mode: "content" },
        output: {
          mode: "content",
          numFiles: 1,
          filenames: ["src/main.rs"],
          content: "12:const cli = true;",
        },
      }),
    );
    expect(structured.detail).toEqual({
      type: "search",
      query: "cli",
      toolName: "grep",
      content: "12:const cli = true;",
      filePaths: ["src/main.rs"],
    });

    const wrapped = expectMapped(
      mapClaudeCompletedToolCall({
        callId: "claude-grep-2",
        name: "Grep",
        input: { pattern: "MaskedView" },
        outputCandidates: ["Found 2 files\nsrc/foo.tsx", { output: "Found 2 files\nsrc/foo.tsx" }],
      }),
    );
    expect(wrapped.detail).toEqual({
      type: "search",
      query: "MaskedView",
      toolName: "grep",
      content: "Found 2 files\nsrc/foo.tsx",
    });
  });

  it("WebSearch 结果折叠进 content", () => {
    const item = expectMapped(
      mapClaudeCompletedToolCall({
        callId: "claude-web-search-1",
        name: "WebSearch",
        input: { query: "news" },
        output: {
          query: "news",
          results: [
            "Top results:",
            { tool_use_id: "toolu_123", content: [{ title: "A", url: "https://example.com/1" }] },
          ],
          durationSeconds: 1.5,
        },
      }),
    );
    expect(item.detail).toEqual({
      type: "search",
      query: "news",
      toolName: "web_search",
      content: "- A (https://example.com/1)\nTop results:",
    });
  });

  it("WebFetch 结构化输出；结构不符时退回只有 url / prompt", () => {
    const item = expectMapped(
      mapClaudeCompletedToolCall({
        callId: "claude-web-fetch-1",
        name: "WebFetch",
        input: { url: "https://example.com/a", prompt: "总结" },
        outputCandidates: [
          {
            bytes: 5120,
            code: 200,
            codeText: "OK",
            result: "摘要",
            durationMs: 250,
            url: "https://example.com/a",
          },
          null,
        ],
      }),
    );
    expect(item.detail).toEqual({
      type: "fetch",
      url: "https://example.com/a",
      prompt: "总结",
      result: "摘要",
    });

    const fallback = expectMapped(
      mapClaudeCompletedToolCall({
        callId: "claude-web-fetch-2",
        name: "WebFetch",
        input: { url: "https://example.com/b", prompt: "总结" },
        outputCandidates: ["纯文本", { output: "纯文本" }, null],
      }),
    );
    expect(fallback.detail).toEqual({ type: "fetch", url: "https://example.com/b", prompt: "总结" });
  });

  it("Task / Agent 子代理映射为 sub_agent，Skill 映射为 plain_text", () => {
    const task = expectMapped(
      mapClaudeCompletedToolCall({
        callId: "task-1",
        name: "Task",
        input: { subagent_type: "Explore", description: "查找入口", prompt: "..." },
        outputCandidates: ["找到了 main.ts", null],
      }),
    );
    expect(task.detail).toEqual({
      type: "sub_agent",
      subAgentType: "Explore",
      description: "查找入口",
      log: "",
    });

    const running = expectMapped(
      mapClaudeRunningToolCall({ callId: "task-2", name: "Agent", input: { description: "调研" } }),
    );
    expect(running.detail).toEqual({ type: "sub_agent", description: "调研", log: "" });

    const skill = expectMapped(
      mapClaudeCompletedToolCall({
        callId: "skill-1",
        name: "Skill",
        input: { skill: "pdf" },
        outputCandidates: ["已加载", null],
      }),
    );
    expect(skill.detail).toEqual({ type: "plain_text", label: "pdf", text: "已加载" });
  });

  it("缺少 callId 时丢弃", () => {
    expect(
      mapClaudeCompletedToolCall({
        callId: null,
        name: "Read",
        input: { file_path: "README.md" },
        output: { content: "hello" },
      }),
    ).toBeNull();
  });
});
