import { describe, expect, it } from "vitest";
import type { AgentStreamEnvelope, ToolCallTimelineItem } from "@agentdeck/protocol";
import { agentUIMessagesToChatMessages } from "@/components/chat/message-adapter";
import { createEmptyChatRuntime, reduceAgentEvent } from "@/stores/chat";
import { describeInteropCall, interopToolName } from "./interop-tools";

function toolCall(
  name: string,
  input: unknown,
  output: unknown,
  status: ToolCallTimelineItem["status"] = "completed",
  error?: string,
): ToolCallTimelineItem {
  return {
    type: "tool_call",
    callId: "c1",
    name,
    status,
    detail: { type: "unknown", input, output },
    ...(error ? { error } : {}),
  };
}

const DELEGATE_JSON = JSON.stringify({ agentId: "child-1", status: "completed", reply: "做完了" }, null, 2);

describe("interopToolName", () => {
  it("识别 Claude 的 mcp__agentdeck__ 前缀与 Codex 的 agentdeck. 前缀，其它 MCP 工具不识别", () => {
    expect(interopToolName("mcp__agentdeck__delegate")).toBe("delegate");
    expect(interopToolName("agentdeck.send_to_agent")).toBe("send_to_agent");
    expect(interopToolName("agentdeck__wait_agent")).toBe("wait_agent");
    expect(interopToolName("mcp__agentdeck__list_agents")).toBeNull();
    expect(interopToolName("mcp__other__delegate")).toBeNull();
    expect(interopToolName("Bash")).toBeNull();
  });
});

describe("describeInteropCall", () => {
  it("Claude 形态：输出是字符串；delegate 的目标会话取结果里的 agentId", () => {
    const info = describeInteropCall(
      toolCall("mcp__agentdeck__delegate", { provider: "codex", prompt: "写测试", title: "子任务" }, DELEGATE_JSON),
    );
    expect(info).toMatchObject({
      tool: "delegate",
      agentId: "child-1",
      provider: "codex",
      title: "子任务",
      request: "写测试",
      result: { agentId: "child-1", status: "completed", reply: "做完了" },
    });
    expect(info?.errorText).toBeUndefined();
  });

  it("Codex 形态：输出是 { content: [{ type: text, text }] }；send_to_agent 的目标取入参 agentId", () => {
    const info = describeInteropCall(
      toolCall(
        "agentdeck.send_to_agent",
        { agentId: "target-9", message: "继续" },
        { content: [{ type: "text", text: JSON.stringify({ agentId: "target-9", status: "running" }) }] },
      ),
    );
    expect(info).toMatchObject({ tool: "send_to_agent", agentId: "target-9", request: "继续", result: { status: "running" } });
  });

  it("工具错误文本（非 JSON / failed）记为 errorText", () => {
    const failed = describeInteropCall(
      toolCall("mcp__agentdeck__delegate", { provider: "claude", prompt: "x" }, "委派深度已达上限（3 层）", "failed"),
    );
    expect(failed?.errorText).toBe("委派深度已达上限（3 层）");
    expect(failed?.agentId).toBeUndefined();
    const plain = describeInteropCall(
      toolCall("mcp__agentdeck__send_to_agent", { agentId: "t", message: "x" }, "目标会话正在运行，请稍后再试"),
    );
    expect(plain?.errorText).toBe("目标会话正在运行，请稍后再试");
  });

  it("非互通工具或非 unknown detail 返回 undefined；read_agent 的输出不当作 JSON 解析", () => {
    expect(describeInteropCall(toolCall("Bash", {}, "x"))).toBeUndefined();
    expect(
      describeInteropCall({
        type: "tool_call",
        callId: "c",
        name: "mcp__agentdeck__delegate",
        status: "completed",
        detail: { type: "shell", command: "x" },
      }),
    ).toBeUndefined();
    const read = describeInteropCall(toolCall("mcp__agentdeck__read_agent", { agentId: "a1" }, "用户：你好\n\n助手：嗨"));
    expect(read).toMatchObject({ tool: "read_agent", agentId: "a1" });
    expect(read?.result).toBeUndefined();
    expect(read?.errorText).toBeUndefined();
  });
});

describe("时间线 → 委派卡片数据", () => {
  it("tool_call 经 reduceAgentEvent 与消息适配后，ChatToolItem 带 delegate；普通工具没有", () => {
    const events: AgentStreamEnvelope[] = [
      {
        agentId: "a",
        seq: 1,
        epoch: "e",
        timestamp: 1,
        event: {
          type: "timeline",
          turnId: "t1",
          item: toolCall("mcp__agentdeck__delegate", { provider: "codex", prompt: "写测试" }, DELEGATE_JSON),
        },
      },
      {
        agentId: "a",
        seq: 2,
        epoch: "e",
        timestamp: 2,
        event: {
          type: "timeline",
          turnId: "t1",
          item: { ...toolCall("Bash", { command: "ls" }, "ok"), callId: "c2" },
        },
      },
    ];
    const runtime = events.reduce((acc, envelope) => reduceAgentEvent(acc, envelope, 1), createEmptyChatRuntime(0));
    const tools = agentUIMessagesToChatMessages(runtime.messages).flatMap((message) => message.tools ?? []);
    const delegate = tools.find((tool) => tool.tool_id === "c1");
    expect(delegate?.delegate).toMatchObject({ tool: "delegate", agentId: "child-1" });
    expect(tools.find((tool) => tool.tool_id === "c2")?.delegate).toBeUndefined();
  });
});
