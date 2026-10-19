import type { AgentSnapshot, AgentStreamEnvelope, AgentStreamEvent, AttentionNotice, ScheduleNotice } from "@agentdeck/protocol";
import { afterEach, describe, expect, test } from "vitest";

import type { AgentManagerListener } from "../../src/agent/agent-manager.js";
import { ATTENTION_BODY_MAX_CHARS, AttentionService } from "../../src/remote/attention.js";
import type { SchedulerListener } from "../../src/scheduler/scheduler.js";
import { FakeClock, startHarness, type Harness } from "./harness.js";

// ---------------------------------------------------------------------------
// 单元：用假的 manager / scheduler 精确控制事件
// ---------------------------------------------------------------------------

function setupUnit(agents: Record<string, Partial<AgentSnapshot>> = { a1: { title: "修复登录" } }) {
  const clock = new FakeClock();
  const sent: AttentionNotice[] = [];
  let managerListener: AgentManagerListener = {};
  let schedulerListener: SchedulerListener = {};
  const service = new AttentionService({
    manager: {
      subscribe: (listener) => {
        managerListener = listener;
        return () => undefined;
      },
      getAgent: (agentId) => {
        const snapshot = agents[agentId];
        if (!snapshot) {
          throw new Error("找不到会话");
        }
        return { id: agentId, ...snapshot } as AgentSnapshot;
      },
    },
    scheduler: {
      subscribe: (listener) => {
        schedulerListener = listener;
        return () => undefined;
      },
    },
    sendToRemote: (notice) => {
      sent.push(notice);
      return 1;
    },
    now: clock.now,
  });
  let seq = 0;
  const emit = (agentId: string, event: AgentStreamEvent) => {
    const envelope: AgentStreamEnvelope = { agentId, seq: ++seq, epoch: "e", timestamp: clock.t, event };
    managerListener.onStream?.(envelope);
  };
  return { clock, sent, service, emit, scheduleNotice: (n: ScheduleNotice) => schedulerListener.onNotice?.(n) };
}

describe("AttentionService 判定", () => {
  test("回合完成 / 失败 / 审批 / 调度通知都会发，字段符合契约", () => {
    const t = setupUnit();
    t.emit("a1", { type: "turn_started", turnId: "t1" });
    t.emit("a1", { type: "turn_completed", turnId: "t1" });
    t.emit("a1", { type: "turn_started", turnId: "t2" });
    t.emit("a1", { type: "turn_failed", turnId: "t2", error: "模型连接超时" });
    t.emit("a1", {
      type: "permission_requested",
      request: { id: "r1", provider: "mock", name: "Bash", kind: "tool", title: "运行命令", input: { command: "rm -rf /secret" } },
    });
    t.scheduleNotice({ scheduleId: "s1", name: "每日巡检", kind: "failed", message: "任务执行失败", agentId: "a1" });

    expect(t.sent.map((n) => n.kind)).toEqual(["finished", "failed", "permission", "schedule"]);
    expect(t.sent[0]).toMatchObject({ agentId: "a1", title: "修复登录", body: "本轮已完成", timestamp: t.clock.t });
    expect(t.sent[1]!.body).toBe("本轮失败：模型连接超时");
    expect(t.sent[2]!.body).toBe("Agent 请求审批：运行命令");
    expect(t.sent[2]!.body).not.toContain("rm -rf");
    expect(t.sent[3]).toMatchObject({ title: "每日巡检", body: "任务执行失败", agentId: "a1" });
    expect(new Set(t.sent.map((n) => n.id)).size).toBe(4);
  });

  test("CLI 自发轮次（background）的完成 / 失败不发，且不影响之后的普通回合", () => {
    const t = setupUnit();
    t.emit("a1", { type: "turn_started", turnId: "bg1", origin: "background" });
    t.emit("a1", { type: "turn_completed", turnId: "bg1" });
    t.emit("a1", { type: "turn_started", turnId: "bg2", origin: "background" });
    t.emit("a1", { type: "turn_failed", turnId: "bg2", error: "x" });
    expect(t.sent).toHaveLength(0);
    t.emit("a1", { type: "turn_started", turnId: "t1" });
    t.emit("a1", { type: "turn_completed", turnId: "t1" });
    expect(t.sent).toHaveLength(1);
  });

  test("缓存保活回合（keepalive，design.md 4.36）的完成 / 失败不发", () => {
    const t = setupUnit();
    t.emit("a1", { type: "turn_started", turnId: "k1", origin: "keepalive" });
    t.emit("a1", { type: "turn_completed", turnId: "k1" });
    t.emit("a1", { type: "turn_started", turnId: "k2", origin: "keepalive" });
    t.emit("a1", { type: "turn_failed", turnId: "k2", error: "x" });
    expect(t.sent).toHaveLength(0);
    t.emit("a1", { type: "turn_started", turnId: "t1" });
    t.emit("a1", { type: "turn_completed", turnId: "t1" });
    expect(t.sent).toHaveLength(1);
  });

  test("background 回合被取消后不再残留标记", () => {
    const t = setupUnit();
    t.emit("a1", { type: "turn_started", turnId: "bg1", origin: "background" });
    t.emit("a1", { type: "turn_canceled", turnId: "bg1", reason: "interrupted" });
    // 同 id 的普通回合（理论上不会发生）也应按普通处理
    t.emit("a1", { type: "turn_completed", turnId: "bg1" });
    expect(t.sent).toHaveLength(1);
  });

  test("judge 会话（目标循环评判）的任何事件都不发", () => {
    const t = setupUnit({ j1: { title: "评判", origin: "judge" } });
    t.emit("j1", { type: "turn_completed", turnId: "t1" });
    t.emit("j1", { type: "turn_failed", turnId: "t2", error: "x" });
    t.emit("j1", { type: "permission_requested", request: { id: "r", provider: "mock", name: "Bash", kind: "tool" } });
    expect(t.sent).toHaveLength(0);
  });

  test("已删除（找不到）的会话不发", () => {
    const t = setupUnit({});
    t.emit("gone", { type: "turn_completed", turnId: "t1" });
    expect(t.sent).toHaveLength(0);
  });

  test("其它事件（流式文本、用量等）不触发", () => {
    const t = setupUnit();
    t.emit("a1", { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "hi" } });
    t.emit("a1", { type: "usage_updated", usage: {} as never });
    t.emit("a1", { type: "turn_canceled", turnId: "t1", reason: "x" });
    expect(t.sent).toHaveLength(0);
  });

  test("摘要 ≤ 120 字、单行；标题缺省取预览；不含 permission 的输入原文", () => {
    const t = setupUnit({ a1: { preview: "首条消息预览" } });
    t.emit("a1", { type: "turn_failed", turnId: "t1", error: `第一行\n${"很长的错误".repeat(100)}` });
    const failed = t.sent[0]!;
    expect(Array.from(failed.body).length).toBeLessThanOrEqual(ATTENTION_BODY_MAX_CHARS);
    expect(failed.body).not.toContain("\n");
    expect(failed.title).toBe("首条消息预览");
    t.scheduleNotice({ scheduleId: "s", name: "", kind: "failed", message: "字".repeat(500) });
    expect(Array.from(t.sent[1]!.body).length).toBeLessThanOrEqual(ATTENTION_BODY_MAX_CHARS);
    expect(t.sent[1]!.title).toBe("定时任务");
  });

  test("permission 带 requestId 与 permissionKind；permission_resolved 发 resolved 撤回信号（带 agentId + requestId）", () => {
    const t = setupUnit();
    t.emit("a1", { type: "permission_requested", request: { id: "r1", provider: "mock", name: "AskUserQuestion", kind: "question" } });
    t.emit("a1", {
      type: "permission_resolved",
      requestId: "r1",
      response: { behavior: "allow" },
    });
    expect(t.sent).toHaveLength(2);
    expect(t.sent[0]).toMatchObject({ kind: "permission", agentId: "a1", requestId: "r1", permissionKind: "question" });
    expect(t.sent[1]).toMatchObject({ kind: "resolved", agentId: "a1", requestId: "r1", title: "修复登录", body: "审批已处理" });
    expect(t.sent[1]!.id).not.toBe(t.sent[0]!.id);
  });

  test("judge 会话与已删除会话的 permission_resolved 不发撤回", () => {
    const t = setupUnit({ j1: { title: "评判", origin: "judge" } });
    t.emit("j1", { type: "permission_resolved", requestId: "r", response: { behavior: "deny" } });
    t.emit("gone", { type: "permission_resolved", requestId: "r", response: { behavior: "deny" } });
    expect(t.sent).toHaveLength(0);
  });

  test("question / plan 类审批使用固定中文摘要", () => {
    const t = setupUnit();
    t.emit("a1", { type: "permission_requested", request: { id: "q", provider: "mock", name: "AskUserQuestion", kind: "question", input: { q: "机密" } } });
    t.emit("a1", { type: "permission_requested", request: { id: "p", provider: "mock", name: "ExitPlanMode", kind: "plan" } });
    expect(t.sent.map((n) => n.body)).toEqual(["Agent 提出了问题，等待你的回答", "Agent 提交了计划，等待你确认"]);
  });

  test("elicitation 类审批只引用服务名：表单「需要你填写表单」，url「需要你在浏览器中完成操作」", () => {
    const t = setupUnit();
    t.emit("a1", {
      type: "permission_requested",
      request: {
        id: "e1",
        provider: "claude",
        name: "mcp:forms",
        kind: "elicitation",
        title: "含机密的标题",
        detail: { type: "elicitation", serverName: "forms", mode: "form", message: "密码是 123456", fields: [] },
      },
    });
    t.emit("a1", {
      type: "permission_requested",
      request: {
        id: "e2",
        provider: "codex",
        name: "mcp:oauth",
        kind: "elicitation",
        detail: { type: "elicitation", serverName: "oauth", mode: "url", message: "授权", url: "https://example.com/?token=abc" },
      },
    });
    expect(t.sent.map((n) => n.body)).toEqual([
      "Agent 需要你填写表单：forms",
      "Agent 需要你在浏览器中完成操作：oauth",
    ]);
    expect(t.sent[0]).toMatchObject({ kind: "permission", permissionKind: "elicitation" });
  });
});

// ---------------------------------------------------------------------------
// 集成：真实 manager + mock provider + 远程网关
// ---------------------------------------------------------------------------

describe("client.attention 端到端", () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  async function setup() {
    h = await startHarness({ enable: true });
    const { phone } = await h.pairPhone();
    const { agent } = await h.local.call("agent.create", { provider: "mock", cwd: process.cwd(), title: "集成会话" });
    return { phone, agent };
  }

  const attentions = (phone: { notificationsOf(m: string): unknown[] }) =>
    phone.notificationsOf("client.attention") as AttentionNotice[];

  test("回合完成后手机收到 finished，本机客户端收不到", async () => {
    const { phone, agent } = await setup();
    await h.local.call("agent.send", { agentId: agent.id, prompt: "hello" });
    await phone.waitFor(() => attentions(phone).length > 0);
    expect(attentions(phone)[0]).toMatchObject({ kind: "finished", agentId: agent.id, title: "集成会话" });
    expect(h.local.notifications.filter((n) => n.method === "client.attention")).toEqual([]);
    phone.close();
  });

  test("回合失败（/fail）与审批请求（/approve）分别发 failed / permission", async () => {
    const { phone, agent } = await setup();
    await h.local.call("agent.send", { agentId: agent.id, prompt: "/fail" });
    await phone.waitFor(() => attentions(phone).some((n) => n.kind === "failed"));
    const failed = attentions(phone).find((n) => n.kind === "failed")!;
    expect(failed.body).toContain("Mock 模拟失败");

    await h.local.call("agent.send", { agentId: agent.id, prompt: "/approve" });
    await phone.waitFor(() => attentions(phone).some((n) => n.kind === "permission"));
    const permission = attentions(phone).find((n) => n.kind === "permission")!;
    expect(permission.body).toBe("Agent 请求审批：运行命令");
    expect(permission.body).not.toContain("echo");
    // 审批通过后回合完成，也会再来一条 finished
    const request = (await h.local.waitForEvent(agent.id, "permission_requested")).request;
    await h.local.call("agent.permission.respond", {
      agentId: agent.id,
      requestId: request.id,
      response: { behavior: "allow" },
    });
    await phone.waitFor(() => attentions(phone).filter((n) => n.kind === "finished").length > 0);
    // 别处处理后手机收到撤回：同一个 agentId + requestId
    const resolved = attentions(phone).find((n) => n.kind === "resolved")!;
    expect(resolved).toMatchObject({ agentId: agent.id, requestId: request.id });
    expect(permission).toMatchObject({ requestId: request.id, permissionKind: "tool" });
    phone.close();
  });
});
