import type { AgentStreamEnvelope } from "@agentdeck/protocol";
import { describe, expect, test } from "vitest";

import { compactToolCallUpdates } from "../src/agent/timeline-compact.js";

function tool(seq: number, callId: string): AgentStreamEnvelope {
  return {
    agentId: "a",
    seq,
    epoch: "e",
    timestamp: seq,
    event: {
      type: "timeline",
      item: { type: "tool_call", callId, name: "Agent", status: "running", detail: { type: "unknown", input: seq, output: null } },
    },
  };
}

function msg(seq: number): AgentStreamEnvelope {
  return {
    agentId: "a",
    seq,
    epoch: "e",
    timestamp: seq,
    event: { type: "timeline", item: { type: "assistant_message", text: `m${seq}` } },
  };
}

const seqs = (entries: AgentStreamEnvelope[]): number[] => entries.map((e) => e.seq);

describe("compactToolCallUpdates", () => {
  test("同一 callId 5 次更新只剩首尾 2 条", () => {
    const input = [1, 2, 3, 4, 5].map((n) => tool(n, "c1"));
    const result = compactToolCallUpdates(input);
    expect(seqs(result.entries)).toEqual([1, 5]);
    expect(result.dropped).toBe(3);
  });

  test("多个 callId 交错", () => {
    const input = [tool(1, "a"), tool(2, "b"), tool(3, "a"), tool(4, "b"), tool(5, "a"), tool(6, "b")];
    const result = compactToolCallUpdates(input);
    expect(seqs(result.entries)).toEqual([1, 2, 5, 6]);
    expect(result.dropped).toBe(2);
  });

  test("只出现 1 次的 callId 原样保留", () => {
    const input = [tool(1, "a"), tool(2, "b")];
    const result = compactToolCallUpdates(input);
    expect(result.entries).toEqual(input);
    expect(result.dropped).toBe(0);
  });

  test("非 tool_call 条目不受影响、顺序不变", () => {
    const input = [msg(1), tool(2, "a"), msg(3), tool(4, "a"), msg(5), tool(6, "a"), msg(7)];
    const result = compactToolCallUpdates(input);
    expect(seqs(result.entries)).toEqual([1, 2, 3, 5, 6, 7]);
    expect(result.dropped).toBe(1);
  });
});
