import type { AgentSnapshot, AgentStreamEnvelope, AgentStreamEvent, AttentionNotice, ScheduleNotice } from "@agentdeck/protocol";
import { afterEach, describe, expect, test } from "vitest";

import type { AgentManagerListener } from "../../src/agent/agent-manager.js";
import { ATTENTION_BODY_MAX_CHARS, AttentionService } from "../../src/remote/attention.js";
import { PresenceTracker } from "../../src/remote/presence.js";
import type { SchedulerListener } from "../../src/scheduler/scheduler.js";
import type { RpcClientConnection } from "../../src/server/client-connection.js";
import { FakeClock, startHarness, type Harness } from "./harness.js";

// ---------------------------------------------------------------------------
// 单元：用假的 manager / scheduler 精确控制事件
// ---------------------------------------------------------------------------

function setupUnit(agents: Record<string, Partial<AgentSnapshot>> = { a1: { title: "修复登录" } }) {
  const clock = new FakeClock();
  const presence = new PresenceTracker(clock.now);
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
    presence,
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
  const desktop: RpcClientConnection = { kind: "local", send: () => undefined, close: () => undefined };
  return { clock, presence, sent, service, emit, desktop, scheduleNotice: (n: ScheduleNotice) => schedulerListener.onNotice?.(n) };
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

  test("desktop 可见时不发；窗口不可见后发；心跳超过 120 秒后发", () => {
    const t = setupUnit();
    t.presence.update(t.desktop, "desktop", true);
    t.emit("a1", { type: "turn_completed", turnId: "t1" });
    expect(t.sent).toHaveLength(0);

    t.clock.advance(60_000);
    t.presence.update(t.desktop, "desktop", false);
    t.emit("a1", { type: "turn_completed", turnId: "t2" });
    expect(t.sent).toHaveLength(1);

    t.presence.update(t.desktop, "desktop", true);
    t.emit("a1", { type: "turn_completed", turnId: "t3" });
    expect(t.sent).toHaveLength(1);
    t.clock.advance(121_000);
    t.emit("a1", { type: "turn_completed", turnId: "t4" });
    expect(t.sent).toHaveLength(2);
  });

  test("desktop 可见时审批与调度通知同样不发", () => {
    const t = setupUnit();
    t.presence.update(t.desktop, "desktop", true);
    t.emit("a1", { type: "permission_requested", request: { id: "r", provider: "mock", name: "Bash", kind: "tool" } });
    t.scheduleNotice({ scheduleId: "s", name: "x", kind: "done", message: "完成" });
    expect(t.sent).toHaveLength(0);
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

  test("question / plan 类审批使用固定中文摘要", () => {
    const t = setupUnit();
    t.emit("a1", { type: "permission_requested", request: { id: "q", provider: "mock", name: "AskUserQuestion", kind: "question", input: { q: "机密" } } });
    t.emit("a1", { type: "permission_requested", request: { id: "p", provider: "mock", name: "ExitPlanMode", kind: "plan" } });
    expect(t.sent.map((n) => n.body)).toEqual(["Agent 提出了问题，等待你的回答", "Agent 提交了计划，等待你确认"]);
  });
});

// ---------------------------------------------------------------------------
// 集成：真实 manager + mock provider + 远程网关
// ---------------------------------------------------------------------------

describe("client.presence / client.attention 端到端", () => {
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

  test("没有 desktop 在线：回合完成后手机收到 finished，本机客户端收不到", async () => {
    const { phone, agent } = await setup();
    await h.local.call("agent.send", { agentId: agent.id, prompt: "hello" });
    await phone.waitFor(() => attentions(phone).length > 0);
    expect(attentions(phone)[0]).toMatchObject({ kind: "finished", agentId: agent.id, title: "集成会话" });
    expect(h.local.notifications.filter((n) => n.method === "client.attention")).toEqual([]);
    phone.close();
  });

  test("desktop 报告可见：不发；报告不可见：发", async () => {
    const { phone, agent } = await setup();
    await h.local.call("client.presence", { kind: "desktop", visible: true });
    await h.local.call("agent.send", { agentId: agent.id, prompt: "one" });
    await h.local.waitForTurnEnd(agent.id, 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(attentions(phone)).toHaveLength(0);

    await h.local.call("client.presence", { kind: "desktop", visible: false });
    await h.local.call("agent.send", { agentId: agent.id, prompt: "two" });
    await phone.waitFor(() => attentions(phone).length > 0);
    expect(attentions(phone)).toHaveLength(1);
    phone.close();
  });

  test("手机自报 desktop 可见不能压制通知（远程连接一律算 mobile）", async () => {
    const { phone, agent } = await setup();
    await phone.call("client.presence", { kind: "desktop", visible: true });
    await h.local.call("agent.send", { agentId: agent.id, prompt: "x" });
    await phone.waitFor(() => attentions(phone).length > 0);
    phone.close();
  });

  test("desktop 本机连接断开后不再算在电脑前", async () => {
    const { phone, agent } = await setup();
    const desktop = await (await import("../rpc-test-client.js")).TestRpcClient.connect(
      `ws://127.0.0.1:${h.localPort}/rpc?token=test-token-0123456789abcdef`,
    );
    await desktop.call("client.presence", { kind: "desktop", visible: true });
    await desktop.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await h.local.call("agent.send", { agentId: agent.id, prompt: "x" });
    await phone.waitFor(() => attentions(phone).length > 0);
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
    phone.close();
  });

  test("client.presence 参数校验", async () => {
    const { phone } = await setup();
    const bad = await h.local.request("client.presence", { kind: "tv", visible: true });
    expect(bad.error?.code).toBe(-32602);
    const bad2 = await h.local.request("client.presence", { kind: "desktop" });
    expect(bad2.error?.code).toBe(-32602);
    phone.close();
  });
});
