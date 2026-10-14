import { describe, expect, test } from "vitest";

import {
  buildPermissionDecision,
  codexTurnCompletedUsage,
  type CodexTurnTokens,
  planToTodoItems,
  toAgentRateLimits,
  toAgentUsage,
  toModelDefinition,
  toSandboxPolicy,
  updateCodexTurnTokens,
} from "../../../src/providers/codex/codex-agent.js";
import { stripCwdPrefix } from "../../../src/providers/codex/tool-call-detail-parser.js";
import {
  mapCodexToolCallFromThreadItem,
  normalizeCommandExecutionCommand,
} from "../../../src/providers/codex/tool-call-mapper.js";

describe("normalizeCommandExecutionCommand", () => {
  test("剥掉 pwsh / bash 外壳", () => {
    // codex 0.162.1 在 Windows 上的真实形状
    expect(
      normalizeCommandExecutionCommand("\"J:\\\\PowerShell\\\\7\\\\pwsh.exe\" -Command 'echo agentdeck-smoke'"),
    ).toBe("echo agentdeck-smoke");
    expect(normalizeCommandExecutionCommand("/bin/bash -lc 'ls -la'")).toBe("ls -la");
    expect(normalizeCommandExecutionCommand(["bash", "-lc", "pwd"])).toBe("pwd");
    expect(normalizeCommandExecutionCommand(["cmd.exe", "/c", "dir"])).toBe("dir");
    expect(normalizeCommandExecutionCommand("git status")).toBe("git status");
    expect(normalizeCommandExecutionCommand(42)).toBeUndefined();
  });
});

describe("mapCodexToolCallFromThreadItem", () => {
  test("commandExecution 进行中 → running shell", () => {
    expect(
      mapCodexToolCallFromThreadItem({
        type: "commandExecution",
        id: "exec_1",
        command: "/bin/zsh -lc 'npm test'",
        cwd: "/repo",
        status: "inProgress",
        aggregatedOutput: null,
        exitCode: null,
      }),
    ).toEqual({
      type: "tool_call",
      callId: "exec_1",
      name: "shell",
      status: "running",
      error: null,
      detail: { type: "shell", command: "npm test", cwd: "/repo" },
    });
  });

  test("commandExecution 完成 → 输出与退出码；declined → failed", () => {
    const done = mapCodexToolCallFromThreadItem({
      type: "commandExecution",
      id: "exec_1",
      command: "echo hi",
      cwd: "/repo",
      status: "completed",
      aggregatedOutput: "hi\n",
      exitCode: 0,
    });
    expect(done).toMatchObject({
      status: "completed",
      detail: { type: "shell", command: "echo hi", output: "hi\n", exitCode: 0 },
    });
    const declined = mapCodexToolCallFromThreadItem({
      type: "commandExecution",
      id: "exec_2",
      command: "rm -rf /",
      status: "declined",
    });
    expect(declined).toMatchObject({ status: "failed", error: "用户拒绝了该操作" });
  });

  test("fileChange（0.162 的对象 kind）→ edit + unifiedDiff，路径相对 cwd", () => {
    const item = mapCodexToolCallFromThreadItem(
      {
        type: "fileChange",
        id: "p1",
        status: "completed",
        changes: [
          { path: "C:\\repo\\src\\main.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b" },
        ],
      },
      { cwd: "C:\\repo" },
    );
    expect(item).toMatchObject({
      name: "apply_patch",
      status: "completed",
      detail: { type: "edit", filePath: "src/main.ts", unifiedDiff: "@@ -1 +1 @@\n-a\n+b" },
    });
  });

  test("fileChange 新增文件（非 diff 内容）→ write；删除 → 删除 diff", () => {
    expect(
      mapCodexToolCallFromThreadItem(
        { type: "fileChange", id: "p2", status: "completed", changes: [{ path: "/repo/new.md", kind: { type: "add" }, diff: "# hi\n" }] },
        { cwd: "/repo" },
      )?.detail,
    ).toEqual({ type: "write", filePath: "new.md", content: "# hi\n" });

    const deleted = mapCodexToolCallFromThreadItem(
      { type: "fileChange", id: "p3", status: "completed", changes: [{ path: "/repo/old.md", kind: { type: "delete" }, diff: "x\ny\n" }] },
      { cwd: "/repo" },
    );
    expect(deleted?.detail).toMatchObject({ type: "edit", filePath: "old.md" });
    expect(deleted?.detail.type === "edit" && deleted.detail.unifiedDiff).toContain("+++ /dev/null");
  });

  test("apply_patch 文本转换为 unified diff", () => {
    const patch = "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch";
    const item = mapCodexToolCallFromThreadItem({
      type: "fileChange",
      id: "p4",
      status: "completed",
      changes: { "a.txt": { diff: patch } },
    });
    expect(item?.detail).toMatchObject({ type: "edit", filePath: "a.txt" });
    expect(item?.detail.type === "edit" && item.detail.unifiedDiff).toContain("--- a/a.txt");
  });

  test("mcpToolCall → server.tool，图片块替换为占位；失败带错误字符串", () => {
    const ok = mapCodexToolCallFromThreadItem({
      type: "mcpToolCall",
      id: "m1",
      server: "fs",
      tool: "read",
      status: "completed",
      arguments: { a: 1 },
      result: { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] },
    });
    expect(ok?.name).toBe("fs.read");
    expect(JSON.stringify(ok?.detail)).not.toContain("AAAA");

    const failed = mapCodexToolCallFromThreadItem({
      type: "mcpToolCall",
      id: "m2",
      server: "fs",
      tool: "read",
      status: "failed",
      error: { message: "denied" },
    });
    expect(failed).toMatchObject({ status: "failed", error: "denied" });
  });

  test("webSearch 从 action 取 query", () => {
    expect(
      mapCodexToolCallFromThreadItem({
        type: "webSearch",
        id: "w1",
        action: { type: "search", query: "vitest", queries: null },
      }),
    ).toMatchObject({
      name: "web_search",
      status: "completed",
      detail: { type: "search", query: "vitest", toolName: "web_search" },
    });
  });

  test("collabAgentToolCall / subAgentActivity 映射为 sub_agent；消息类 item 返回 null", () => {
    expect(
      mapCodexToolCallFromThreadItem({
        type: "collabAgentToolCall",
        id: "c1",
        status: "inProgress",
        prompt: "调查 bug",
        agentsStates: {},
      }),
    ).toMatchObject({
      name: "Sub-agent",
      status: "running",
      detail: { type: "sub_agent", subAgentType: "Sub-agent", description: "调查 bug", log: "" },
    });
    expect(
      mapCodexToolCallFromThreadItem({
        type: "subAgentActivity",
        id: "s1",
        kind: "interrupted",
        agentThreadId: "t2",
        agentPath: "/root/code_reviewer",
      }),
    ).toMatchObject({
      status: "canceled",
      detail: { type: "sub_agent", subAgentType: "Code reviewer", description: "code_reviewer" },
    });
    // agentsStates 汇总状态：任一失败 → failed；shutdown → canceled；全部完成 → completed
    const collab = (agentsStates: Record<string, unknown>) =>
      mapCodexToolCallFromThreadItem({
        type: "collabAgentToolCall",
        id: "c2",
        status: "completed",
        tool: "spawnAgent",
        receiverThreadIds: ["t1", "t2"],
        agentsStates,
      });
    expect(collab({ t1: { status: "completed" }, t2: { status: "running" } })?.status).toBe("running");
    expect(collab({ t1: { status: "completed" }, t2: { status: "completed" } })?.status).toBe(
      "completed",
    );
    expect(collab({ t1: { status: "notFound" }, t2: { status: "completed" } })?.status).toBe("failed");
    expect(collab({ t1: { status: "shutdown" } })?.status).toBe("canceled");
    expect(mapCodexToolCallFromThreadItem({ type: "agentMessage", id: "x", text: "hi" })).toBeNull();
    expect(mapCodexToolCallFromThreadItem({ type: "userMessage", id: "u", content: [] })).toBeNull();
  });
});

describe("toAgentRateLimits（design.md 4.30）", () => {
  const NOW = 1_700_000_000_000;
  const response = (extra: Record<string, unknown> = {}) => ({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 23.4, windowDurationMins: 300, resetsAt: 1_791_920_000 },
      secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: null },
      rateLimitReachedType: null,
      ...extra,
    },
  });

  test("窗口按 windowDurationMins 命名，resetsAt 为秒、转毫秒，低于 80% 为 allowed", () => {
    expect(toAgentRateLimits(response(), NOW)).toEqual({
      windows: [
        { id: "primary", label: "5 小时", usedPercent: 23.4, resetsAt: 1_791_920_000_000 },
        { id: "secondary", label: "每周", usedPercent: 60 },
      ],
      status: "allowed",
      updatedAt: NOW,
    });
  });

  test("其它时长按天 / 小时 / 分钟命名，没有时长退回主要 / 次要；毫秒量级的 resetsAt 原样保留", () => {
    const limits = toAgentRateLimits(
      {
        rateLimits: {
          primary: { usedPercent: 1, windowDurationMins: 1440, resetsAt: 1_791_920_000_000 },
          secondary: { usedPercent: 2, windowDurationMins: null, resetsAt: null },
        },
      },
      NOW,
    );
    expect(limits?.windows.map((w) => w.label)).toEqual(["1 天", "次要"]);
    expect(limits?.windows[0]?.resetsAt).toBe(1_791_920_000_000);
    expect(toAgentRateLimits({ rateLimits: { primary: { usedPercent: 1, windowDurationMins: 90 } } }, NOW)?.windows[0]?.label).toBe("90 分钟");
    expect(toAgentRateLimits({ rateLimits: { primary: { usedPercent: 1 } } }, NOW)?.windows[0]?.label).toBe("主要");
  });

  test("status：任一窗口 ≥ 80% 为 warning；rateLimitReachedType 非空为 rejected（优先）", () => {
    expect(toAgentRateLimits(response({ secondary: { usedPercent: 80, windowDurationMins: 10080 } }), NOW)?.status).toBe("warning");
    expect(toAgentRateLimits(response({ rateLimitReachedType: "rate_limit_reached" }), NOW)?.status).toBe("rejected");
    expect(
      toAgentRateLimits(
        response({ primary: { usedPercent: 100, windowDurationMins: 300 }, rateLimitReachedType: "workspace_member_usage_limit_reached" }),
        NOW,
      )?.status,
    ).toBe("rejected");
  });

  test("稀疏更新：null 窗口沿用上一份；没有任何窗口返回 null", () => {
    const first = toAgentRateLimits(response(), NOW)!;
    const second = toAgentRateLimits(
      { rateLimits: { primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 1_791_930_000 }, secondary: null } },
      NOW + 1,
      first,
    );
    expect(second?.windows).toEqual([
      { id: "primary", label: "5 小时", usedPercent: 50, resetsAt: 1_791_930_000_000 },
      { id: "secondary", label: "每周", usedPercent: 60 },
    ]);
    expect(second?.updatedAt).toBe(NOW + 1);
    expect(toAgentRateLimits({ rateLimits: { primary: null, secondary: null } }, NOW)).toBeNull();
    expect(toAgentRateLimits(null, NOW)).toBeNull();
  });
});

describe("codex 协议小工具", () => {
  test("stripCwdPrefix 兼容 Windows 分隔符与大小写", () => {
    expect(stripCwdPrefix("C:\\Repo\\src\\a.ts", "c:\\repo")).toBe("src/a.ts");
    expect(stripCwdPrefix("/other/a.ts", "/repo")).toBe("/other/a.ts");
  });

  test("toAgentUsage 取 last 与上下文窗口（兼容 snake_case）", () => {
    expect(
      toAgentUsage({
        last: { totalTokens: 10, inputTokens: 7, cachedInputTokens: 2, outputTokens: 3 },
        modelContextWindow: 1000,
      }),
    ).toEqual({
      inputTokens: 7,
      cachedInputTokens: 2,
      outputTokens: 3,
      contextWindowMaxTokens: 1000,
      contextWindowUsedTokens: 10,
    });
    expect(
      toAgentUsage({ last_token_usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 }, model_context_window: 9 }),
    ).toEqual({ inputTokens: 1, outputTokens: 2, contextWindowMaxTokens: 9, contextWindowUsedTokens: 3 });
    expect(toAgentUsage(null)).toBeUndefined();
  });

  /** 按 Codex 的处理顺序跑一串 tokenUsage 更新，返回 turn_completed 的 usage */
  function turnUsageOf(updates: unknown[]) {
    let usage: ReturnType<typeof toAgentUsage>;
    let tokens: CodexTurnTokens | undefined;
    for (const update of updates) {
      usage = toAgentUsage(update) ?? usage;
      tokens = updateCodexTurnTokens(tokens, update);
    }
    return codexTurnCompletedUsage(usage, tokens);
  }

  test("turn_completed 的 token 为本轮合计：最新 total − 本轮起点（起点 = 首条 total − last）", () => {
    expect(
      turnUsageOf([
        {
          total: { inputTokens: 1100, outputTokens: 120 },
          last: { totalTokens: 120, inputTokens: 100, outputTokens: 20 },
          modelContextWindow: 1000,
        },
        {
          total: { inputTokens: 1300, outputTokens: 150 },
          last: { totalTokens: 230, inputTokens: 200, cachedInputTokens: 50, outputTokens: 30 },
          modelContextWindow: 1000,
        },
      ]),
    ).toEqual({
      inputTokens: 300,
      outputTokens: 50,
      cachedInputTokens: 50,
      contextWindowMaxTokens: 1000,
      contextWindowUsedTokens: 230,
    });
    // snake_case：total_token_usage / last_token_usage
    expect(
      turnUsageOf([
        {
          total_token_usage: { input_tokens: 50, output_tokens: 5 },
          last_token_usage: { input_tokens: 10, output_tokens: 1 },
        },
        {
          total_token_usage: { input_tokens: 70, output_tokens: 9 },
          last_token_usage: { input_tokens: 20, output_tokens: 4 },
        },
      ]),
    ).toEqual({ inputTokens: 30, outputTokens: 5 });
  });

  test("没有 total 时 turn_completed 退回最近一次 last；没有更新时为 undefined", () => {
    expect(
      turnUsageOf([
        { last: { inputTokens: 100, outputTokens: 20 } },
        { last: { inputTokens: 200, outputTokens: 30 }, modelContextWindow: 9 },
      ]),
    ).toEqual({ inputTokens: 200, outputTokens: 30, contextWindowMaxTokens: 9 });
    expect(turnUsageOf([])).toBeUndefined();
  });

  test("planToTodoItems / toModelDefinition / toSandboxPolicy", () => {
    expect(planToTodoItems([{ step: "a", status: "completed" }, { step: " ", status: "pending" }])).toEqual([
      { text: "a", completed: true },
    ]);
    expect(toModelDefinition({ id: "m", displayName: "M", description: "", isDefault: true })).toEqual({
      provider: "codex",
      id: "m",
      label: "M",
      isDefault: true,
    });
    expect(toModelDefinition({ id: "h", hidden: true })).toBeNull();
    expect(toSandboxPolicy("read-only")).toEqual({ type: "readOnly", networkAccess: false });
    expect(toSandboxPolicy("workspace-write")).toMatchObject({ type: "workspaceWrite", writableRoots: [] });
  });

  test("buildPermissionDecision：v2 accept/decline/cancel、旧版 approved/denied/abort、elicitation", () => {
    expect(buildPermissionDecision("command", { behavior: "allow" })).toEqual({ decision: "accept" });
    expect(buildPermissionDecision("file", { behavior: "deny" })).toEqual({ decision: "decline" });
    expect(buildPermissionDecision("file", { behavior: "deny", interrupt: true })).toEqual({ decision: "cancel" });
    expect(buildPermissionDecision("legacy-exec", { behavior: "allow" })).toEqual({ decision: "approved" });
    expect(buildPermissionDecision("legacy-patch", { behavior: "deny", interrupt: true })).toEqual({
      decision: "abort",
    });
    expect(buildPermissionDecision("legacy-exec", { behavior: "deny", message: "no" })).toEqual({
      decision: { denied: { rejection: "no" } },
    });
    expect(buildPermissionDecision("elicitation", { behavior: "allow" })).toEqual({
      action: "accept",
      content: {},
      _meta: null,
    });
  });

  test("buildPermissionDecision：selectedActionId 命中 decisions 表时直接用表里的决定", () => {
    const decisions = new Map<string, unknown>([
      ["allow_session", "acceptForSession"],
      ["allow_project", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] } }],
    ]);
    expect(
      buildPermissionDecision("command", { behavior: "allow", selectedActionId: "allow_session" }, decisions),
    ).toEqual({ decision: "acceptForSession" });
    expect(
      buildPermissionDecision("command", { behavior: "allow", selectedActionId: "allow_project" }, decisions),
    ).toEqual({ decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] } } });
    // 表里没有的 id（如 accept / decline）回退到按 behavior 构造
    expect(buildPermissionDecision("command", { behavior: "deny", selectedActionId: "decline" }, decisions)).toEqual({
      decision: "decline",
    });
    // 旧版 decline 的表项为 undefined：按 denied + 理由构造
    expect(
      buildPermissionDecision(
        "legacy-exec",
        { behavior: "deny", selectedActionId: "decline", message: "不行" },
        new Map([["decline", undefined]]),
      ),
    ).toEqual({ decision: { denied: { rejection: "不行" } } });
  });
});
