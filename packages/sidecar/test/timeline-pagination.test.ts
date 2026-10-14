import type { AgentStreamEnvelope, AgentStreamEvent } from "@agentdeck/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { AgentManager } from "../src/agent/agent-manager.js";
import { pageTimeline, turnStartFlags } from "../src/agent/timeline-page.js";
import { MockAgentClient } from "../src/providers/mock/index.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { RpcServer } from "../src/server/rpc-server.js";
import { TestRpcClient } from "./rpc-test-client.js";

// ---------------------------------------------------------------------------
// 纯函数：合成时间线
// ---------------------------------------------------------------------------

function entries(events: AgentStreamEvent[]): AgentStreamEnvelope[] {
  return events.map((event, i) => ({ agentId: "a", seq: i + 1, epoch: "e", timestamp: i, event }));
}

const user = (text: string, steer = false): AgentStreamEvent => ({
  type: "timeline",
  item: { type: "user_message", text, ...(steer ? { steer: true as const } : {}) },
});
const started = (turnId: string, origin?: "background"): AgentStreamEvent => ({
  type: "turn_started",
  turnId,
  ...(origin ? { origin } : {}),
});
const reply = (text: string): AgentStreamEvent => ({
  type: "timeline",
  item: { type: "assistant_message", text },
});
const done = (turnId: string): AgentStreamEvent => ({ type: "turn_completed", turnId });

/** 三个回合：用户回合 A（user,started,reply×2,done）、后台回合 B（started,reply,done）、用户回合 C（含插话） */
function sample(): AgentStreamEnvelope[] {
  return entries([
    { type: "thread_started", sessionId: "s" }, // 1
    user("A"), // 2  回合 A 起点
    started("tA"), // 3
    reply("a1"), // 4
    reply("a2"), // 5
    done("tA"), // 6
    started("tB", "background"), // 7  回合 B 起点（无 user_message）
    reply("b1"), // 8
    done("tB"), // 9
    user("C"), // 10 回合 C 起点
    started("tC"), // 11
    reply("c1"), // 12
    user("插话", true), // 13 插话，不是起点
    reply("c2"), // 14
    done("tC"), // 15
  ]);
}

describe("turnStartFlags", () => {
  test("user_message 取代同回合的 turn_started；后台回合取 turn_started；插话不是起点", () => {
    const flags = turnStartFlags(sample());
    const starts = flags.map((f, i) => (f ? i + 1 : 0)).filter(Boolean);
    expect(starts).toEqual([2, 7, 10]);
  });
});

describe("pageTimeline", () => {
  test("缺省 beforeSeq = 末尾：取最近 limit 条后补齐到回合起点", () => {
    // limit=3 → 起点下标对应 seq 13（插话）→ 往前补到回合 C 的 user_message（seq 10）
    const page = pageTimeline(sample(), { limit: 3 });
    expect(page.entries.map((e) => e.seq)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(page.hasOlder).toBe(true);
  });

  test("起点恰好是回合起点时不再扩展", () => {
    const page = pageTimeline(sample(), { limit: 6 });
    expect(page.entries.map((e) => e.seq)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(page.hasOlder).toBe(true);
  });

  test("beforeSeq 往前翻页，页首落在后台回合的 turn_started", () => {
    const page = pageTimeline(sample(), { beforeSeq: 10, limit: 2 });
    // seq<10 共 9 条，取最近 2 条是 8、9 → 补到后台回合起点 7
    expect(page.entries.map((e) => e.seq)).toEqual([7, 8, 9]);
    expect(page.hasOlder).toBe(true);
  });

  test("再往前翻到头：hasOlder=false", () => {
    const page = pageTimeline(sample(), { beforeSeq: 7, limit: 3 });
    // seq<7 共 6 条，最近 3 条是 4、5、6 → 补到回合 A 的 user_message(2)（共 5 条，不超过 2×limit）；seq 1 (thread_started) 在更早，仍算更早
    expect(page.entries.map((e) => e.seq)).toEqual([2, 3, 4, 5, 6]);
    expect(page.hasOlder).toBe(true);
    const first = pageTimeline(sample(), { beforeSeq: 2, limit: 10 });
    expect(first.entries.map((e) => e.seq)).toEqual([1]);
    expect(first.hasOlder).toBe(false);
  });

  test("limit 足够大：返回全部且 hasOlder=false", () => {
    const page = pageTimeline(sample(), { limit: 2000 });
    expect(page.entries).toHaveLength(15);
    expect(page.hasOlder).toBe(false);
  });

  test("回合比 limit 长但不超过 2 倍：整回合保留", () => {
    const page = pageTimeline(sample(), { limit: 3 });
    expect(page.entries.map((e) => e.seq)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(page.hasOlder).toBe(true);
  });

  test("回合超过 limit 的 2 倍：从回合中间截断，条数不超过 2×limit，hasOlder 仍为 true", () => {
    const page = pageTimeline(sample(), { limit: 2 });
    // 回合 C 共 6 条（10–15），上限 4 条 → 页首落在 seq 12（不是回合起点）
    expect(page.entries.map((e) => e.seq)).toEqual([12, 13, 14, 15]);
    expect(page.hasOlder).toBe(true);
    // 继续向前翻：从截断处接着取，最终能覆盖整条时间线且没有重叠
    const seen = page.entries.map((e) => e.seq);
    let beforeSeq = page.entries[0]!.seq;
    for (let guard = 0; guard < 20; guard++) {
      const older = pageTimeline(sample(), { beforeSeq, limit: 2 });
      seen.unshift(...older.entries.map((e) => e.seq));
      if (!older.hasOlder) break;
      beforeSeq = older.entries[0]!.seq;
    }
    expect(seen).toEqual(sample().map((e) => e.seq));
  });

  test("累计字节超过上限：从中间截断（至少保留最近一条），hasOlder 为 true", () => {
    const big = (text: string) => reply(text.repeat(400));
    const all = entries([user("A"), started("t"), big("a"), big("b"), big("c"), big("d"), done("t")]);
    const one = Buffer.byteLength(JSON.stringify(all[2]!));
    // 上限约 2.5 条大消息：从最近一条往前累计，吞到第 3 条大消息前停下
    const page = pageTimeline(all, { limit: 20 }, Math.floor(one * 2.5));
    expect(page.entries.map((e) => e.seq)).toEqual([5, 6, 7]);
    expect(page.hasOlder).toBe(true);
    // 单条就超过上限：仍返回最近一条，分页可以前进
    const tiny = pageTimeline(all, { limit: 20 }, 10);
    expect(tiny.entries.map((e) => e.seq)).toEqual([7]);
    expect(tiny.hasOlder).toBe(true);
  });

  test("补齐回合起点时字节上限同样生效", () => {
    const big = (text: string) => reply(text.repeat(400));
    // 回合起点（user_message）之后有三条大消息；基础窗口是最近 3 条，补齐到起点还要再吞一条大消息
    const all = entries([user("A"), started("t"), big("a"), big("b"), big("c"), done("t")]);
    const one = Buffer.byteLength(JSON.stringify(all[2]!));
    const page = pageTimeline(all, { limit: 3 }, Math.floor(one * 2.5));
    // 基础窗口 4–6 累计约 2 条大消息 + done 未超限；再多吞一条大消息就超过 2.5 条 → 停在回合中间
    expect(page.entries.map((e) => e.seq)).toEqual([4, 5, 6]);
    expect(page.hasOlder).toBe(true);
  });

  test("beforeSeq 位于条目之间（序号有空洞）按 < 过滤", () => {
    const all = sample().filter((e) => e.seq !== 12);
    const page = pageTimeline(all, { beforeSeq: 12, limit: 1 });
    expect(page.entries.map((e) => e.seq)).toEqual([10, 11]);
  });

  test("beforeSeq 不大于首条：空页，hasOlder=false", () => {
    expect(pageTimeline(sample(), { beforeSeq: 1, limit: 5 })).toEqual({ entries: [], hasOlder: false });
    expect(pageTimeline([], { limit: 5 })).toEqual({ entries: [], hasOlder: false });
  });

  test("连续分页拼起来恰好覆盖整条时间线、没有重叠", () => {
    const all = sample();
    const seen: number[] = [];
    let beforeSeq: number | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = pageTimeline(all, { limit: 3, ...(beforeSeq !== undefined ? { beforeSeq } : {}) });
      seen.unshift(...page.entries.map((e) => e.seq));
      if (!page.hasOlder) {
        break;
      }
      beforeSeq = page.entries[0]!.seq;
    }
    expect(seen).toEqual(all.map((e) => e.seq));
  });

  test("没有 user_message 的纯 turn_started 回合：页首取 turn_started", () => {
    const all = entries([started("t1"), reply("x"), done("t1"), started("t2"), reply("y"), reply("z"), done("t2")]);
    const page = pageTimeline(all, { limit: 2 });
    expect(page.entries.map((e) => e.seq)).toEqual([4, 5, 6, 7]);
    expect(page.hasOlder).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RPC：agent.timeline 参数与兼容性
// ---------------------------------------------------------------------------

const TOKEN = "test-token-0123456789abcdef";
let server: RpcServer;
let manager: AgentManager;
let client: TestRpcClient;
let agentId: string;

beforeEach(async () => {
  const registry = new ProviderRegistry([new MockAgentClient()]);
  manager = new AgentManager({ registry });
  server = new RpcServer({ token: TOKEN, version: "t", manager, registry });
  const port = await server.listen(0);
  client = await TestRpcClient.connect(`ws://127.0.0.1:${port}/rpc?token=${TOKEN}`);
  ({
    agent: { id: agentId },
  } = await client.call("agent.create", { provider: "mock", cwd: process.cwd() }));
  for (let turn = 1; turn <= 3; turn++) {
    await client.call("agent.send", { agentId, prompt: `第 ${turn} 轮` });
    await client.waitForTurnEnd(agentId, turn);
  }
});

afterEach(async () => {
  await client.close();
  await manager.shutdown();
  await server.close();
});

describe("agent.timeline RPC", () => {
  test("旧调用不变：不带分页参数不返回 hasOlder，sinceSeq 仍按序号过滤", async () => {
    const all = await client.call("agent.timeline", { agentId });
    expect(all).not.toHaveProperty("hasOlder");
    expect(all.entries.length).toBeGreaterThan(20);
    const since = await client.call("agent.timeline", { agentId, sinceSeq: 10 });
    expect(since).not.toHaveProperty("hasOlder");
    expect(since.entries.map((e) => e.seq)).toEqual(all.entries.filter((e) => e.seq > 10).map((e) => e.seq));
  });

  test("limit 取尾部并补齐回合：页首是 user_message，hasOlder 为 true", async () => {
    const all = (await client.call("agent.timeline", { agentId })).entries;
    const page = await client.call("agent.timeline", { agentId, limit: 5 });
    expect(page.hasOlder).toBe(true);
    const first = page.entries[0]!.event;
    expect(first.type === "timeline" && first.item.type === "user_message").toBe(true);
    expect(page.entries.at(-1)!.seq).toBe(all.at(-1)!.seq);
    expect(page.entries.length).toBeGreaterThanOrEqual(5);
    // 页首是第 3 轮的 user_message
    expect(first.type === "timeline" && first.item.type === "user_message" && first.item.text).toBe("第 3 轮");
  });

  test("beforeSeq 继续向前翻页直到头，拼接后与完整时间线一致", async () => {
    const all = (await client.call("agent.timeline", { agentId })).entries;
    const collected: number[] = [];
    let beforeSeq: number | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = await client.call("agent.timeline", {
        agentId,
        limit: 8,
        ...(beforeSeq !== undefined ? { beforeSeq } : {}),
      });
      collected.unshift(...page.entries.map((e) => e.seq));
      if (!page.hasOlder) {
        break;
      }
      beforeSeq = page.entries[0]!.seq;
    }
    expect(collected).toEqual(all.map((e) => e.seq));
  });

  test("limit 很大：全部返回且 hasOlder=false", async () => {
    const all = (await client.call("agent.timeline", { agentId })).entries;
    const page = await client.call("agent.timeline", { agentId, limit: 2000 });
    expect(page.entries).toHaveLength(all.length);
    expect(page.hasOlder).toBe(false);
  });

  test("sinceSeq 与 beforeSeq / limit 同时给出返回 -32602", async () => {
    for (const params of [
      { agentId, sinceSeq: 1, limit: 10 },
      { agentId, sinceSeq: 1, beforeSeq: 5 },
      { agentId, sinceSeq: 0, beforeSeq: 5, limit: 10 },
    ]) {
      const response = await client.request("agent.timeline", params);
      expect(response.error?.code, JSON.stringify(params)).toBe(-32602);
    }
  });

  test("beforeSeq 缺 limit、limit 越界、非整数都是 -32602", async () => {
    for (const params of [
      { agentId, beforeSeq: 5 },
      { agentId, limit: 0 },
      { agentId, limit: 2001 },
      { agentId, limit: 1.5 },
      { agentId, beforeSeq: 0, limit: 5 },
      { agentId, beforeSeq: -1, limit: 5 },
    ]) {
      const response = await client.request("agent.timeline", params);
      expect(response.error?.code, JSON.stringify(params)).toBe(-32602);
    }
  });

  test("未知会话仍返回 AGENT_NOT_FOUND", async () => {
    const response = await client.request("agent.timeline", { agentId: "nope", limit: 5 });
    expect(response.error).toMatchObject({ code: -32000, data: { code: "AGENT_NOT_FOUND" } });
  });
});
