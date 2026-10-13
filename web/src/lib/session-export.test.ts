import { describe, expect, it } from "vitest";
import type { AgentSnapshot, AgentStreamEnvelope, AgentStreamEvent } from "@agentdeck/protocol";
import { buildSessionJson, buildSessionMarkdown, sessionExportFileName } from "./session-export";

const AGENT: AgentSnapshot = {
  id: "a1",
  provider: "claude",
  cwd: "J:/work/demo",
  title: "我的会话",
  model: "opus",
  modeId: "plan",
  status: "idle",
  activeTurnId: "t9",
  pendingPermissions: [{ id: "p", provider: "claude", name: "Bash", kind: "tool" }],
  persistence: { provider: "claude", sessionId: "s1" },
  totalUsage: { inputTokens: 100, outputTokens: 20 },
  lastSeq: 20,
  resumable: true,
  createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
  updatedAt: Date.UTC(2026, 0, 2, 4, 4, 5),
};

function envelopes(events: AgentStreamEvent[]): AgentStreamEnvelope[] {
  return events.map((event, index) => ({
    agentId: "a1",
    seq: index + 1,
    epoch: "e",
    timestamp: 1000 + index,
    event,
  }));
}

const ENTRIES = envelopes([
  { type: "timeline", item: { type: "user_message", text: "你好", clientMessageId: "c1" } },
  { type: "turn_started", turnId: "t1" },
  { type: "timeline", turnId: "t1", item: { type: "reasoning", text: "先想" } },
  { type: "timeline", turnId: "t1", item: { type: "reasoning", text: "一下" } },
  { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "第一", messageId: "m1" } },
  { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "段。", messageId: "m1" } },
  {
    type: "timeline",
    turnId: "t1",
    item: { type: "tool_call", callId: "k1", name: "Bash", status: "running", detail: { type: "shell", command: "ls\n-la" } },
  },
  {
    type: "timeline",
    turnId: "t1",
    item: { type: "tool_call", callId: "k1", name: "Bash", status: "completed", detail: { type: "shell", command: "ls\n-la" } },
  },
  {
    type: "timeline",
    turnId: "t1",
    item: { type: "tool_call", callId: "k2", name: "Read", status: "failed", detail: { type: "read", filePath: "a.ts" } },
  },
  { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "第二段", messageId: "m2" } },
  { type: "turn_completed", turnId: "t1" },
  { type: "timeline", item: { type: "user_message", text: "撤回我", clientMessageId: "c2" } },
  { type: "turn_started", turnId: "t2" },
  { type: "user_message_retracted", turnId: "t2", clientMessageId: "c2" },
  { type: "turn_canceled", turnId: "t2", reason: "retract" },
  { type: "timeline", item: { type: "user_message", text: "   " } },
  { type: "turn_started", turnId: "t3" },
  { type: "timeline", turnId: "t3", item: { type: "error", message: "出错了" } },
  { type: "turn_failed", turnId: "t3", error: "回合失败" },
]);

describe("buildSessionJson", () => {
  it("包含格式头、去掉内部字段并原样带上全部条目", () => {
    const parsed = JSON.parse(buildSessionJson(AGENT, ENTRIES, 12345));
    expect(parsed.format).toBe("agentdeck.session");
    expect(parsed.version).toBe(1);
    expect(parsed.exportedAt).toBe(12345);
    expect(parsed.agent.id).toBe("a1");
    expect(parsed.agent.title).toBe("我的会话");
    expect("persistence" in parsed.agent).toBe(false);
    expect("pendingPermissions" in parsed.agent).toBe(false);
    expect("activeTurnId" in parsed.agent).toBe(false);
    expect(parsed.entries).toEqual(ENTRIES);
  });
});

describe("buildSessionMarkdown", () => {
  const md = buildSessionMarkdown(AGENT, ENTRIES, { title: "我的会话", providerLabel: "Claude Code" });

  it("标题与元信息", () => {
    expect(md.startsWith("# 我的会话\n")).toBe(true);
    expect(md).toContain("- Agent：Claude Code");
    expect(md).toContain("- 模型：opus");
    expect(md).toContain("- 模式：plan");
    expect(md).toContain("- 工作目录：`J:/work/demo`");
    expect(md).toContain("- 累计 tokens：输入 100 / 输出 20");
    expect(md).toMatch(/- 创建时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });

  it("按 messageId 拼接助手文本，不同 messageId 分段", () => {
    expect(md).toContain("### 助手\n\n第一段。");
    expect(md).toContain("### 助手\n\n第二段");
    expect(md.match(/### 助手/g)).toHaveLength(2);
  });

  it("思考放进 details 且连续片段合并", () => {
    expect(md).toContain("<details><summary>思考</summary>\n\n先想一下\n\n</details>");
  });

  it("工具一行：同 callId 取最终状态，shell 附命令，连续工具合并为列表", () => {
    expect(md).toContain("- 工具 `Bash` · 已完成 · `ls -la`\n- 工具 `Read` · 失败");
    expect(md).not.toContain("运行中");
  });

  it("被撤回的用户消息及其中断提示不输出；空文本的用户消息写 [图片]", () => {
    expect(md).not.toContain("撤回我");
    expect(md).not.toContain("已中断本轮");
    expect(md).toContain("### 用户\n\n你好");
    expect(md).toContain("### 用户\n\n[图片]");
  });

  it("错误与系统提示以引用块输出", () => {
    expect(md).toContain("> 错误：出错了");
    expect(md).toContain("> 错误：回合失败");
  });

  it("没有撤回事件时 turn_canceled 输出「已中断本轮」；缺省 clientMessageId 的撤回取最近用户消息", () => {
    const canceled = buildSessionMarkdown(
      AGENT,
      envelopes([
        { type: "timeline", item: { type: "user_message", text: "A" } },
        { type: "turn_canceled", turnId: "t1", reason: "user" },
        { type: "timeline", item: { type: "user_message", text: "B" } },
        { type: "user_message_retracted", turnId: "t2" },
        { type: "turn_canceled", turnId: "t2", reason: "retract" },
      ]),
      { title: "T" },
    );
    expect(canceled).toContain("> 已中断本轮");
    expect(canceled).toContain("### 用户\n\nA");
    expect(canceled).not.toContain("\nB");
    expect(canceled.match(/已中断本轮/g)).toHaveLength(1);
  });
});

describe("sessionExportFileName", () => {
  const now = new Date(2026, 0, 2, 3, 4);
  it("去掉非法字符、截取前 40 字并附时间戳", () => {
    expect(sessionExportFileName('修复: a/b*c?"d"', now)).toBe("修复 a b c d-20260102-0304");
    const long = sessionExportFileName("字".repeat(60), now);
    expect(long).toBe(`${"字".repeat(40)}-20260102-0304`);
  });
  it("标题清空后回退到「会话」", () => {
    expect(sessionExportFileName(' /:* ', now)).toBe("会话-20260102-0304");
  });
});
