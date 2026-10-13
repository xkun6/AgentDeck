import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentStreamEnvelope,
  AgentStreamEvent,
  AgentTimelineItem,
} from "@agentdeck/protocol";
import { afterEach, describe, expect, test } from "vitest";

import { AgentStore } from "../src/agent/agent-store.js";
import { searchEntries, searchSources } from "../src/agent/timeline-search.js";

let seq = 0;
function env(event: AgentStreamEvent, agentId = "a1"): AgentStreamEnvelope {
  seq += 1;
  return { agentId, seq, epoch: "e", timestamp: 1000 + seq, event };
}
function tl(item: AgentTimelineItem, turnId?: string): AgentStreamEnvelope {
  return env({ type: "timeline", ...(turnId ? { turnId } : {}), item });
}
const user = (text: string, clientMessageId?: string) =>
  tl({ type: "user_message", text, ...(clientMessageId ? { clientMessageId } : {}) });
const assistant = (text: string, messageId?: string) =>
  tl({ type: "assistant_message", text, ...(messageId ? { messageId } : {}) }, "t1");
const reasoning = (text: string) => tl({ type: "reasoning", text }, "t1");
const turnDone = () => env({ type: "turn_completed", turnId: "t1" });

async function search(entries: AgentStreamEnvelope[], query: string) {
  seq = 0;
  return searchEntries("a1", entries, query.trim().toLocaleLowerCase());
}

describe("searchEntries", () => {
  test("中文与大小写不敏感", async () => {
    seq = 0;
    const entries = [user("请修复 Login 页面的崩溃"), assistant("好的，开始处理 LOGIN 逻辑")];
    const hits = await searchEntries("a1", entries, "login");
    expect(hits.map((h) => h.role)).toEqual(["user", "assistant"]);
    const zh = await searchEntries("a1", entries, "崩溃");
    expect(zh).toHaveLength(1);
    expect(zh[0]!.snippet.slice(zh[0]!.matchStart, zh[0]!.matchStart + zh[0]!.matchLength)).toBe("崩溃");
  });

  test("assistant 按 messageId 分段拼接后跨段命中，seq 取首段", async () => {
    seq = 0;
    const first = assistant("正在检查 sidec", "m1");
    const second = assistant("ar 的日志", "m1");
    const hits = await searchEntries("a1", [first, second], "sidecar");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.seq).toBe(first.seq);
    expect(hits[0]!.snippet).toBe("正在检查 sidecar 的日志");
  });

  test("无 messageId 的连续分段也拼接", async () => {
    seq = 0;
    const entries = [assistant("hel"), assistant("lo world")];
    const hits = await searchEntries("a1", entries, "hello");
    expect(hits).toHaveLength(1);
  });

  test("reasoning 连续分段拼接", async () => {
    seq = 0;
    const entries = [reasoning("先想想怎么拆分"), reasoning("模块边界")];
    const hits = await searchEntries("a1", entries, "拆分模块");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.role).toBe("reasoning");
    expect(hits[0]!.seq).toBe(entries[0]!.seq);
  });

  test("tool_call 命中命令与路径，同 callId 取最新内容", async () => {
    seq = 0;
    const running = tl(
      {
        type: "tool_call",
        callId: "c1",
        name: "Bash",
        status: "running",
        detail: { type: "unknown", input: {}, output: null },
      },
      "t1",
    );
    const done = tl(
      {
        type: "tool_call",
        callId: "c1",
        name: "Bash",
        status: "completed",
        detail: { type: "shell", command: "pnpm run build:Sidecar" },
      },
      "t1",
    );
    const read = tl(
      {
        type: "tool_call",
        callId: "c2",
        name: "Read",
        status: "completed",
        detail: { type: "read", filePath: "J:/proj/src/Main.rs" },
      },
      "t1",
    );
    const byCommand = await searchEntries("a1", [running, done, read], "build:sidecar");
    expect(byCommand).toHaveLength(1);
    expect(byCommand[0]).toMatchObject({ role: "tool", seq: running.seq });
    const byPath = await searchEntries("a1", [running, done, read], "src/main.rs");
    expect(byPath.map((h) => h.seq)).toEqual([read.seq]);
  });

  test("被撤回的用户消息不命中（按 clientMessageId 与缺省取最近用户消息）", async () => {
    seq = 0;
    const u1 = user("撤回的秘密", "cm1");
    const retract1 = env({ type: "user_message_retracted", turnId: "t1", clientMessageId: "cm1" });
    const u2 = user("另一条秘密");
    const retract2 = env({ type: "user_message_retracted", turnId: "t2" });
    const u3 = user("保留的秘密");
    const hits = await searchEntries("a1", [u1, retract1, u2, retract2, u3], "秘密");
    expect(hits.map((h) => h.seq)).toEqual([u3.seq]);
  });

  test("每个会话最多 5 条命中", async () => {
    seq = 0;
    const entries = Array.from({ length: 9 }, (_, i) => user(`hit ${i}`));
    const hits = await searchEntries("a1", entries, "hit");
    expect(hits).toHaveLength(5);
    expect(hits.map((h) => h.seq)).toEqual(entries.slice(0, 5).map((e) => e.seq));
  });

  test("snippet 前后各约 60 字、换行压成空格、位置正确", async () => {
    seq = 0;
    const text = `${"前".repeat(100)}\n目标词\r\n${"后".repeat(100)}`;
    const hits = await searchEntries("a1", [user(text)], "目标词");
    const hit = hits[0]!;
    // 命中后紧跟的 \r\n 压成一个空格，所以比 60+3+60 少 1
    expect(hit.snippet).toHaveLength(60 + 3 + 59);
    expect(hit.snippet).not.toMatch(/[\r\n]/);
    expect(hit.matchStart).toBe(60);
    expect(hit.matchLength).toBe(3);
    expect(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)).toBe("目标词");
    // 换行被压成空格后，前 60 字里包含一个空格（原文的 \n）
    expect(hit.snippet.slice(0, 60)).toContain(" ");
  });

  test("小写化会改变长度的字符不会让位置错位", async () => {
    seq = 0;
    const hits = await searchEntries("a1", [user("İİ foo bar")], "foo");
    const hit = hits[0]!;
    expect(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)).toBe("foo");
  });

  test("没有命中返回空", async () => {
    expect(await search([user("hello")], "不存在")).toEqual([]);
  });
});

describe("searchSources", () => {
  test("按会话顺序扫描，limit 截断并置 truncated", async () => {
    seq = 0;
    const mk = (agentId: string, n: number) => ({
      agentId,
      entries: () => Array.from({ length: n }, (_, i) => ({ ...user(`kw ${i}`), agentId })),
    });
    const result = await searchSources([mk("a", 4), mk("b", 4), mk("c", 4)], "KW", 6);
    expect(result.truncated).toBe(true);
    expect(result.hits).toHaveLength(6);
    expect(result.hits.map((h) => h.agentId)).toEqual(["a", "a", "a", "a", "b", "b"]);

    const all = await searchSources([mk("a", 2), mk("b", 1)], "kw", 100);
    expect(all.truncated).toBe(false);
    expect(all.hits).toHaveLength(3);
  });

  test("单个会话读取失败不影响其它会话", async () => {
    seq = 0;
    const errors: string[] = [];
    const result = await searchSources(
      [
        {
          agentId: "bad",
          entries: () => {
            throw new Error("boom");
          },
        },
        { agentId: "ok", entries: () => [{ ...user("kw"), agentId: "ok" }] },
      ],
      "kw",
      10,
      (agentId) => errors.push(agentId),
    );
    expect(errors).toEqual(["bad"]);
    expect(result.hits.map((h) => h.agentId)).toEqual(["ok"]);
  });
});

describe("AgentStore.streamTimeline", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("流式逐行读取，坏行与乱序行跳过", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agentdeck-search-"));
    dirs.push(dir);
    mkdirSync(path.join(dir, "agents", "a1"), { recursive: true });
    seq = 0;
    const good1 = user("第一条 keyword");
    const good2 = user("第二条 keyword");
    writeFileSync(
      path.join(dir, "agents", "a1", "timeline.jsonl"),
      [JSON.stringify(good1), "{坏行", JSON.stringify(good2), JSON.stringify(good1)].join("\n") + "\n",
    );
    const store = new AgentStore({ dataDir: dir });
    const hits = await searchEntries("a1", store.streamTimeline("a1"), "keyword");
    expect(hits.map((h) => h.seq)).toEqual([good1.seq, good2.seq]);
    // 文件不存在
    const none = await searchEntries("zzz", store.streamTimeline("zzz"), "keyword");
    expect(none).toEqual([]);
  });
});
