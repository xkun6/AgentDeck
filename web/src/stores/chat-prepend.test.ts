// 时间线向前分页（design.md 4.31）：更早的一页前插后，消息顺序必须与整段回放一致。
import { describe, expect, it } from "vitest";
import type { AgentStreamEnvelope, AgentStreamEvent } from "@agentdeck/protocol";
import { createEmptyChatRuntime, prependAgentHistory, reduceAgentEvent, type ChatSessionRuntime } from "./chat";

const AGENT = "agent-1";

function env(seq: number, event: AgentStreamEvent): AgentStreamEnvelope {
  return { agentId: AGENT, seq, epoch: "e1", timestamp: 10_000 + seq, event };
}

/** 三个完整回合，每回合 4 条：user_message / turn_started / assistant_message / turn_completed */
function threeTurns(): AgentStreamEnvelope[] {
  const entries: AgentStreamEnvelope[] = [];
  for (let turn = 1; turn <= 3; turn += 1) {
    const base = (turn - 1) * 4;
    entries.push(
      env(base + 1, { type: "timeline", item: { type: "user_message", text: `问题${turn}` } }),
      env(base + 2, { type: "turn_started", turnId: `t${turn}` }),
      env(base + 3, { type: "timeline", turnId: `t${turn}`, item: { type: "assistant_message", text: `回答${turn}` } }),
      env(base + 4, { type: "turn_completed", turnId: `t${turn}` }),
    );
  }
  return entries;
}

function reduceAll(entries: AgentStreamEnvelope[]): ChatSessionRuntime {
  return entries.reduce((acc, e) => reduceAgentEvent(acc, e, 1), createEmptyChatRuntime(0));
}

const summarize = (runtime: ChatSessionRuntime) =>
  runtime.messages.map((m) => [m.id, m.role, m.parts.map((p) => (p.type === "text" ? p.text : p.type)).join("")]);

describe("prependAgentHistory", () => {
  const all = threeTurns();

  it("先取最近一页、再逐页前插，消息顺序与 id 和整段回放完全一致", () => {
    let runtime = reduceAll(all.slice(8)); // 只有第 3 回合
    expect(runtime.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    runtime = prependAgentHistory(runtime, all.slice(4, 8), 1);
    runtime = prependAgentHistory(runtime, all.slice(0, 4), 1);
    expect(summarize(runtime)).toEqual(summarize(reduceAll(all)));
    expect(runtime.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
  });

  it("前插不影响当前回合的流式状态与最后序号", () => {
    const tail = [...all.slice(8, 10)]; // 第 3 回合进行到一半
    let runtime = reduceAll(tail);
    expect(runtime.streamStatus).toBe("streaming");
    const lastSeq = runtime.agentLastSeq;
    runtime = prependAgentHistory(runtime, all.slice(0, 8), 1);
    expect(runtime.streamStatus).toBe("streaming");
    expect(runtime.agentLastSeq).toBe(lastSeq);
    expect(runtime.activeAssistantId).toBeDefined();
    // 流式继续追加，仍落在最后一条助手消息里
    runtime = reduceAgentEvent(runtime, all[10]!, 2);
    runtime = reduceAgentEvent(runtime, all[11]!, 3);
    expect(summarize(runtime)).toEqual(summarize(reduceAll(all)));
  });

  it("重复前插同一页不会产生重复消息", () => {
    let runtime = reduceAll(all.slice(4));
    runtime = prependAgentHistory(runtime, all.slice(0, 4), 1);
    const again = prependAgentHistory(runtime, all.slice(0, 4), 1);
    expect(again.messages).toHaveLength(runtime.messages.length);
  });

  it("回合被页边界从中间截开：前半段并到已有的同回合助手消息之前，与整段回放一致", () => {
    const turn: AgentStreamEnvelope[] = [
      env(1, { type: "timeline", item: { type: "user_message", text: "问题" } }),
      env(2, { type: "turn_started", turnId: "t1" }),
      env(3, { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "前半" } }),
      env(4, { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "后半" } }),
      env(5, { type: "turn_completed", turnId: "t1" }),
    ];
    // 页边界落在 seq 4 之前：新页 [4, 5] 不是回合起点，older 页 [1, 2, 3] 末尾属于同一回合
    let runtime = reduceAll(turn.slice(3));
    expect(runtime.messages.map((m) => m.id)).toEqual(["agent-turn-t1"]);
    runtime = prependAgentHistory(runtime, turn.slice(0, 3), 1);
    expect(summarize(runtime)).toEqual(summarize(reduceAll(turn)));
    expect(runtime.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    // 重复前插同一页仍然幂等
    expect(summarize(prependAgentHistory(runtime, turn.slice(0, 3), 1))).toEqual(summarize(runtime));
  });

  it("页首不是回合起点（以 tool_call / turn_completed 开头）也能归约出消息，不抛错", () => {
    const entries: AgentStreamEnvelope[] = [
      env(10, { type: "timeline", turnId: "t9", item: { type: "assistant_message", text: "尾巴" } }),
      env(11, { type: "turn_completed", turnId: "t9" }),
    ];
    const runtime = reduceAll(entries);
    expect(runtime.messages.map((m) => m.role)).toEqual(["assistant"]);
    expect(runtime.streamStatus).not.toBe("streaming");
  });

  it("空页原样返回", () => {
    const runtime = reduceAll(all.slice(8));
    expect(prependAgentHistory(runtime, [], 1)).toBe(runtime);
  });
});
