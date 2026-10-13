import { describe, expect, it } from "vitest";
import type { CronSchedule, GoalSchedule, HeartbeatSchedule, Schedule } from "@agentdeck/protocol";
import {
  CRON_PRESETS,
  automationActionDraft,
  automationBarItems,
  buildScheduleDraft,
  describeSchedulePlan,
  describeTrigger,
  emptyScheduleForm,
  formFromSchedule,
  isValidCronExpression,
  nextCronRuns,
  selectableAgents,
  toDatetimeLocal,
} from "./schedule-display";

const NOW = new Date(2026, 0, 5, 9, 0, 0).getTime();

function cron(patch: Partial<CronSchedule> = {}): CronSchedule {
  return {
    id: "c1",
    name: "每日巡检",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    kind: "cron",
    trigger: { cron: "0 9 * * *" },
    target: { type: "agent", agentId: "a1" },
    prompt: "巡检",
    onBusy: "skip",
    ...patch,
  };
}

function heartbeat(patch: Partial<HeartbeatSchedule> = {}): HeartbeatSchedule {
  return { id: "h1", name: "心跳", enabled: true, createdAt: 1, updatedAt: 1, kind: "heartbeat", agentId: "a1", idleMinutes: 30, prompt: "在吗", runs: 0, ...patch };
}

function goal(patch: Partial<GoalSchedule> = {}): GoalSchedule {
  return {
    id: "g1", name: "目标", enabled: true, createdAt: 1, updatedAt: 1, kind: "goal", agentId: "a1",
    goal: "修测试", doneMarker: "GOAL_DONE", maxIterations: 10, iterations: 3, stopOnFailure: true, state: "running", ...patch,
  };
}

describe("cron 预设与预览", () => {
  it("所有预设都是合法的 5 段表达式", () => {
    for (const preset of CRON_PRESETS) expect(isValidCronExpression(preset.cron)).toBe(true);
  });

  it("拒绝非 5 段与非法字段", () => {
    expect(isValidCronExpression("* * * *")).toBe(false);
    expect(isValidCronExpression("0 0 9 * * *")).toBe(false);
    expect(isValidCronExpression("99 * * * *")).toBe(false);
    expect(isValidCronExpression("")).toBe(false);
  });

  it("nextCronRuns 返回未来 5 次触发，非法表达式返回空", () => {
    const runs = nextCronRuns("*/5 * * * *", 5, NOW);
    expect(runs).toHaveLength(5);
    expect(runs[0]).toBe(NOW + 5 * 60_000);
    expect(runs[4]).toBe(NOW + 25 * 60_000);
    expect(nextCronRuns("bad", 5, NOW)).toEqual([]);
  });
});

describe("buildScheduleDraft：定时任务", () => {
  const base = () => emptyScheduleForm("cron", { name: "巡检", agentId: "a1", prompt: " 请巡检 " });

  it("cron + 现有会话：构造草稿并去空白", () => {
    const result = buildScheduleDraft(base(), NOW);
    expect(result).toEqual({
      ok: true,
      draft: {
        name: "巡检", enabled: true, kind: "cron", trigger: { cron: "0 9 * * *" },
        target: { type: "agent", agentId: "a1" }, prompt: "请巡检", onBusy: "skip",
      },
    });
  });

  it("缺名称 / cron 非法 / 缺目标 / 缺提示都报错", () => {
    const result = buildScheduleDraft(emptyScheduleForm("cron", { cron: "nope" }), NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(["agentId", "cron", "name", "prompt"]);
    }
  });

  it("间隔必须是不小于 1 的整数", () => {
    for (const bad of ["0", "-1", "1.5", "abc", ""]) {
      const result = buildScheduleDraft({ ...base(), triggerType: "every", everyMinutes: bad }, NOW);
      expect(result.ok).toBe(false);
    }
    const ok = buildScheduleDraft({ ...base(), triggerType: "every", everyMinutes: "15" }, NOW);
    expect(ok.ok && ok.draft.kind === "cron" && ok.draft.trigger).toEqual({ everyMinutes: 15 });
  });

  it("一次性：时间已过且启用时报错，未来时间通过", () => {
    const past = buildScheduleDraft({ ...base(), triggerType: "at", at: toDatetimeLocal(NOW - 60_000) }, NOW);
    expect(past.ok).toBe(false);
    const future = buildScheduleDraft({ ...base(), triggerType: "at", at: toDatetimeLocal(NOW + 3_600_000) }, NOW);
    expect(future.ok).toBe(true);
    const missing = buildScheduleDraft({ ...base(), triggerType: "at", at: "" }, NOW);
    expect(missing.ok).toBe(false);
  });

  it("新建会话目标：必须选 Agent 与工作目录，可选模型 / 标题", () => {
    const bad = buildScheduleDraft({ ...base(), targetType: "new" }, NOW);
    expect(bad.ok).toBe(false);
    const ok = buildScheduleDraft(
      { ...base(), targetType: "new", provider: "claude", cwd: " D:/repo ", model: "opus", title: "日报" },
      NOW,
    );
    expect(ok.ok && ok.draft.kind === "cron" && ok.draft.target).toEqual({
      type: "new", provider: "claude", cwd: "D:/repo", model: "opus", title: "日报",
    });
  });
});

describe("buildScheduleDraft：心跳与目标循环", () => {
  it("心跳：空闲分钟 ≥ 1，maxRuns 留空 = 不限", () => {
    const form = emptyScheduleForm("heartbeat", { name: "hb", agentId: "a1", prompt: "ping", idleMinutes: "20" });
    const ok = buildScheduleDraft(form, NOW);
    expect(ok).toEqual({
      ok: true,
      draft: { name: "hb", enabled: true, kind: "heartbeat", agentId: "a1", idleMinutes: 20, prompt: "ping" },
    });
    expect(buildScheduleDraft({ ...form, idleMinutes: "0" }, NOW).ok).toBe(false);
    const limited = buildScheduleDraft({ ...form, maxRuns: "3" }, NOW);
    expect(limited.ok && limited.draft.kind === "heartbeat" && limited.draft.maxRuns).toBe(3);
    expect(buildScheduleDraft({ ...form, maxRuns: "x" }, NOW).ok).toBe(false);
  });

  it("目标循环：必填目标 / 标记 / 轮数上限，开启评判时必须选 Agent", () => {
    const form = emptyScheduleForm("goal", { name: "g", agentId: "a1", goal: " 修好测试 " });
    const ok = buildScheduleDraft(form, NOW);
    expect(ok).toEqual({
      ok: true,
      draft: {
        name: "g", enabled: true, kind: "goal", agentId: "a1", goal: "修好测试",
        doneMarker: "GOAL_DONE", maxIterations: 10, stopOnFailure: true,
      },
    });
    expect(buildScheduleDraft({ ...form, goal: " " }, NOW).ok).toBe(false);
    expect(buildScheduleDraft({ ...form, maxIterations: "1001" }, NOW).ok).toBe(false);
    expect(buildScheduleDraft({ ...form, doneMarker: "" }, NOW).ok).toBe(false);
    expect(buildScheduleDraft({ ...form, judgeEnabled: true }, NOW).ok).toBe(false);
    const judged = buildScheduleDraft({ ...form, judgeEnabled: true, judgeProvider: "claude", judgeModel: "haiku" }, NOW);
    expect(judged.ok && judged.draft.kind === "goal" && judged.draft.judge).toEqual({ provider: "claude", model: "haiku" });
  });

  it("编辑时带上 id；formFromSchedule 与 buildScheduleDraft 往返一致", () => {
    for (const schedule of [cron(), cron({ trigger: { everyMinutes: 10 } }), heartbeat({ maxRuns: 2 }), goal({ judge: { provider: "claude" } })] as Schedule[]) {
      const result = buildScheduleDraft(formFromSchedule(schedule), NOW);
      expect(result.ok && result.draft.id).toBe(schedule.id);
      expect(result.ok && result.draft.kind).toBe(schedule.kind);
    }
  });
});

describe("展示文案", () => {
  it("describeTrigger 识别预设", () => {
    expect(describeTrigger(cron())).toBe("每天 09:00（0 9 * * *）");
    expect(describeTrigger(cron({ trigger: { cron: "1 2 3 4 5" } }))).toBe("cron 1 2 3 4 5");
    expect(describeTrigger(cron({ trigger: { everyMinutes: 30 } }))).toBe("每 30 分钟");
  });

  it("describeSchedulePlan：cron 给出下次触发时间，停用 / 心跳 / 目标给出状态", () => {
    expect(describeSchedulePlan(cron(), NOW)).toBe("下次 2026-01-06 09:00");
    expect(describeSchedulePlan(cron({ enabled: false }), NOW)).toBe("已停用");
    expect(describeSchedulePlan(heartbeat({ maxRuns: 3, runs: 1 }), NOW)).toBe("空闲 30 分钟后发送（1/3）");
    expect(describeSchedulePlan(goal(), NOW)).toBe("进行中（3/10）");
    expect(describeSchedulePlan(goal({ state: "exhausted", enabled: false, iterations: 10 }), NOW)).toBe("已达最大轮数（10/10）");
  });
});

describe("会话状态条", () => {
  it("进行中的目标循环与心跳：文案与动作", () => {
    const items = automationBarItems([goal(), heartbeat()], "a1");
    expect(items.map((item) => [item.label, item.action.label])).toEqual([
      ["目标循环 3/10", "停止"],
      ["心跳：空闲 30 分钟后发送", "停止"],
    ]);
  });

  it("已暂停的目标可继续，停用的心跳可启用；已完成 / 失败的目标不显示", () => {
    const items = automationBarItems(
      [goal({ state: "stopped", enabled: false }), heartbeat({ enabled: false }), goal({ id: "g2", state: "done", enabled: false })],
      "a1",
    );
    expect(items.map((item) => [item.label, item.action.kind, item.action.label])).toEqual([
      ["目标循环已暂停 3/10", "resume", "继续"],
      ["心跳已停用", "resume", "启用"],
    ]);
  });

  it("只显示本会话的项；agentId 为空返回空", () => {
    expect(automationBarItems([goal({ agentId: "other" })], "a1")).toEqual([]);
    expect(automationBarItems([goal()], null)).toEqual([]);
  });

  it("automationActionDraft：停止 / 继续", () => {
    expect(automationActionDraft(goal(), "stop")).toMatchObject({ enabled: false, state: "stopped" });
    expect(automationActionDraft(goal({ state: "stopped", enabled: false }), "resume")).toMatchObject({ enabled: true, state: "running" });
    expect(automationActionDraft(heartbeat(), "stop")).toMatchObject({ enabled: false });
  });

  it("selectableAgents 排除隐藏的评判会话", () => {
    const agents = [{ id: "a" }, { id: "j", origin: "judge" }] as never[];
    expect(selectableAgents(agents).map((agent: { id: string }) => agent.id)).toEqual(["a"]);
  });
});
