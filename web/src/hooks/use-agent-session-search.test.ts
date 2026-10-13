// agent.search / usage.summary 的动作层封装（design.md 4.19 / 4.20）
import { describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import type { SidecarClient } from "@/lib/sidecar-client";
import { createAgentSessionActions } from "./use-agent-session";

function fakeClient(result: unknown) {
  return { request: vi.fn(async () => result) } as unknown as SidecarClient & {
    request: ReturnType<typeof vi.fn>;
  };
}

describe("agent.search / usage.summary", () => {
  it("searchSessions 只传 query（带 limit 时一并传），返回命中", async () => {
    const hit = { agentId: "a", seq: 3, timestamp: 1, role: "user", snippet: "x", matchStart: 0, matchLength: 1 };
    const client = fakeClient({ hits: [hit], truncated: false });
    const actions = createAgentSessionActions(client, createStore());
    expect(await actions.searchSessions("关键词")).toEqual({ hits: [hit], truncated: false });
    expect(client.request).toHaveBeenLastCalledWith("agent.search", { query: "关键词" }, { timeoutMs: 60_000 });
    await actions.searchSessions("abc", { limit: 20 });
    expect(client.request).toHaveBeenLastCalledWith("agent.search", { query: "abc", limit: 20 }, { timeoutMs: 60_000 });
  });

  it("usageSummary 透传时间范围", async () => {
    const client = fakeClient({ backfilling: false });
    const actions = createAgentSessionActions(client, createStore());
    await actions.usageSummary({ sinceMs: 5 });
    expect(client.request).toHaveBeenLastCalledWith("usage.summary", { sinceMs: 5 }, { timeoutMs: 60_000 });
    await actions.usageSummary();
    expect(client.request).toHaveBeenLastCalledWith("usage.summary", {}, { timeoutMs: 60_000 });
  });
});
