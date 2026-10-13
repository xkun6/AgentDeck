// 调度器（design.md 4.25）在前端的展示与表单规则：cron 预设与触发预览、表单校验与草稿构造、
// 会话详情状态条文案。纯函数，便于 vitest 覆盖。
import { Cron } from "croner";
import type { AgentSnapshot, GoalSchedule, Schedule, ScheduleDraft, ScheduleTarget } from "@agentdeck/protocol";

export const DEFAULT_DONE_MARKER = "GOAL_DONE";
export const CRON_PREVIEW_COUNT = 5;

export interface CronPreset {
  id: string;
  label: string;
  cron: string;
}

export const CRON_PRESETS: readonly CronPreset[] = [
  { id: "every-5-minutes", label: "每 5 分钟", cron: "*/5 * * * *" },
  { id: "hourly", label: "每小时", cron: "0 * * * *" },
  { id: "daily-9", label: "每天 09:00", cron: "0 9 * * *" },
  { id: "weekday-9", label: "工作日 09:00", cron: "0 9 * * 1-5" },
  { id: "weekly-mon-9", label: "每周一 09:00", cron: "0 9 * * 1" },
  { id: "monthly-1-9", label: "每月 1 日 09:00", cron: "0 9 1 * *" },
];

/** 5 段表达式（分 时 日 月 周，本地时区）是否合法；与 sidecar 一致，不接受带秒的 6 段。 */
export function isValidCronExpression(expr: string): boolean {
  const text = expr.trim();
  if (text.split(/\s+/).length !== 5) return false;
  try {
    new Cron(text);
    return true;
  } catch {
    return false;
  }
}

/** 从 `from` 起的后 count 次触发时间（ms）；表达式非法返回空数组。 */
export function nextCronRuns(expr: string, count: number = CRON_PREVIEW_COUNT, from: number = Date.now()): number[] {
  if (!isValidCronExpression(expr)) return [];
  try {
    return new Cron(expr.trim()).nextRuns(count, new Date(from)).map((date) => date.getTime());
  } catch {
    return [];
  }
}

const pad = (value: number) => value.toString().padStart(2, "0");

export function formatScheduleTime(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `<input type="datetime-local">` 的值（本地时间）。 */
export function toDatetimeLocal(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromDatetimeLocal(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function describeTrigger(schedule: Extract<Schedule, { kind: "cron" }>): string {
  const trigger = schedule.trigger;
  if ("cron" in trigger) {
    const preset = CRON_PRESETS.find((item) => item.cron === trigger.cron.trim());
    return preset ? `${preset.label}（${trigger.cron}）` : `cron ${trigger.cron}`;
  }
  if ("everyMinutes" in trigger) return `每 ${trigger.everyMinutes} 分钟`;
  return `一次性 ${formatScheduleTime(trigger.at)}`;
}

/** 列表里的「下次触发 / 状态」。every 的基准点在 sidecar 内存里，前端只显示间隔。 */
export function describeSchedulePlan(schedule: Schedule, now: number = Date.now()): string {
  if (schedule.kind === "cron") {
    if (!schedule.enabled) return "已停用";
    const trigger = schedule.trigger;
    if ("cron" in trigger) {
      const next = nextCronRuns(trigger.cron, 1, now)[0];
      return next !== undefined ? `下次 ${formatScheduleTime(next)}` : "无后续触发";
    }
    if ("everyMinutes" in trigger) return `每 ${trigger.everyMinutes} 分钟一次`;
    return `将于 ${formatScheduleTime(trigger.at)} 触发`;
  }
  if (schedule.kind === "heartbeat") {
    if (!schedule.enabled) return "已停用";
    const progress = schedule.maxRuns !== undefined ? `（${schedule.runs}/${schedule.maxRuns}）` : "";
    return `空闲 ${schedule.idleMinutes} 分钟后发送${progress}`;
  }
  return GOAL_STATE_LABELS[schedule.state] + `（${schedule.iterations}/${schedule.maxIterations}）`;
}

export const GOAL_STATE_LABELS: Record<GoalSchedule["state"], string> = {
  running: "进行中",
  done: "已完成",
  stopped: "已暂停",
  exhausted: "已达最大轮数",
  failed: "已失败",
};

export const RUN_OUTCOME_LABELS: Record<string, string> = {
  sent: "已发送",
  skipped_busy: "忙，已跳过",
  skipped_paused: "全局暂停，已跳过",
  missed: "错过，未补跑",
  failed: "失败",
  done: "目标完成",
};

export function describeTarget(
  target: ScheduleTarget,
  agentTitle: (agentId: string) => string | null,
  providerLabel: (provider: string) => string,
): string {
  if (target.type === "agent") return `会话「${agentTitle(target.agentId) ?? "已删除的会话"}」`;
  return `新建 ${providerLabel(target.provider)} 会话 · ${target.cwd}`;
}

// ── 表单 ──────────────────────────────────────────────────────────────

export type ScheduleFormKind = "cron" | "heartbeat" | "goal";

export interface ScheduleFormState {
  id?: string;
  kind: ScheduleFormKind;
  name: string;
  enabled: boolean;
  // cron
  triggerType: "cron" | "every" | "at";
  cron: string;
  everyMinutes: string;
  at: string;
  targetType: "agent" | "new";
  agentId: string;
  provider: string;
  cwd: string;
  model: string;
  title: string;
  prompt: string;
  onBusy: "skip" | "wait";
  // heartbeat
  idleMinutes: string;
  maxRuns: string;
  // goal
  goal: string;
  doneMarker: string;
  maxIterations: string;
  judgeEnabled: boolean;
  judgeProvider: string;
  judgeModel: string;
  stopOnFailure: boolean;
}

export function emptyScheduleForm(kind: ScheduleFormKind, defaults: Partial<ScheduleFormState> = {}): ScheduleFormState {
  return {
    kind,
    name: "",
    enabled: true,
    triggerType: "cron",
    cron: CRON_PRESETS[2]!.cron,
    everyMinutes: "30",
    at: "",
    targetType: "agent",
    agentId: "",
    provider: "",
    cwd: "",
    model: "",
    title: "",
    prompt: "",
    onBusy: "skip",
    idleMinutes: "30",
    maxRuns: "",
    goal: "",
    doneMarker: DEFAULT_DONE_MARKER,
    maxIterations: "10",
    judgeEnabled: false,
    judgeProvider: "",
    judgeModel: "",
    stopOnFailure: true,
    ...defaults,
  };
}

export function formFromSchedule(schedule: Schedule): ScheduleFormState {
  const base = { id: schedule.id, name: schedule.name, enabled: schedule.enabled };
  if (schedule.kind === "cron") {
    const trigger = schedule.trigger;
    const target = schedule.target;
    return emptyScheduleForm("cron", {
      ...base,
      triggerType: "cron" in trigger ? "cron" : "everyMinutes" in trigger ? "every" : "at",
      ...("cron" in trigger ? { cron: trigger.cron } : {}),
      ...("everyMinutes" in trigger ? { everyMinutes: String(trigger.everyMinutes) } : {}),
      ...("at" in trigger ? { at: toDatetimeLocal(trigger.at) } : {}),
      targetType: target.type,
      ...(target.type === "agent"
        ? { agentId: target.agentId }
        : { provider: target.provider, cwd: target.cwd, model: target.model ?? "", title: target.title ?? "" }),
      prompt: schedule.prompt,
      onBusy: schedule.onBusy,
    });
  }
  if (schedule.kind === "heartbeat") {
    return emptyScheduleForm("heartbeat", {
      ...base,
      agentId: schedule.agentId,
      idleMinutes: String(schedule.idleMinutes),
      maxRuns: schedule.maxRuns !== undefined ? String(schedule.maxRuns) : "",
      prompt: schedule.prompt,
    });
  }
  return emptyScheduleForm("goal", {
    ...base,
    agentId: schedule.agentId,
    goal: schedule.goal,
    doneMarker: schedule.doneMarker,
    maxIterations: String(schedule.maxIterations),
    judgeEnabled: schedule.judge !== undefined,
    judgeProvider: schedule.judge?.provider ?? "",
    judgeModel: schedule.judge?.model ?? "",
    stopOnFailure: schedule.stopOnFailure,
  });
}

export type ScheduleFormErrors = Partial<Record<keyof ScheduleFormState, string>>;

function parsePositiveInt(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

export type BuildDraftResult = { ok: true; draft: ScheduleDraft } | { ok: false; errors: ScheduleFormErrors };

/** 校验表单并构造 schedule.upsert 的草稿；校验规则与 sidecar 的 zod 一致（cron 5 段、间隔 ≥ 1 等）。 */
export function buildScheduleDraft(form: ScheduleFormState, now: number = Date.now()): BuildDraftResult {
  const errors: ScheduleFormErrors = {};
  const name = form.name.trim();
  if (!name) errors.name = "请填写名称";
  else if (name.length > 100) errors.name = "名称最长 100 字";

  const common = { ...(form.id ? { id: form.id } : {}), name, enabled: form.enabled };

  if (form.kind === "cron") {
    let trigger: Extract<ScheduleDraft, { kind: "cron" }>["trigger"] | undefined;
    if (form.triggerType === "cron") {
      if (!isValidCronExpression(form.cron)) errors.cron = "cron 表达式非法，需 5 段：分 时 日 月 周";
      else trigger = { cron: form.cron.trim() };
    } else if (form.triggerType === "every") {
      const minutes = parsePositiveInt(form.everyMinutes);
      if (minutes === null) errors.everyMinutes = "间隔需为不小于 1 的整数（分钟）";
      else trigger = { everyMinutes: minutes };
    } else {
      const at = fromDatetimeLocal(form.at);
      if (at === null) errors.at = "请选择触发时间";
      else if (at <= now && form.enabled) errors.at = "触发时间已过";
      else trigger = { at };
    }

    let target: ScheduleTarget | undefined;
    if (form.targetType === "agent") {
      if (!form.agentId) errors.agentId = "请选择目标会话";
      else target = { type: "agent", agentId: form.agentId };
    } else {
      if (!form.provider) errors.provider = "请选择 Agent";
      if (!form.cwd.trim()) errors.cwd = "请填写工作目录";
      if (form.provider && form.cwd.trim()) {
        target = {
          type: "new",
          provider: form.provider,
          cwd: form.cwd.trim(),
          ...(form.model.trim() ? { model: form.model.trim() } : {}),
          ...(form.title.trim() ? { title: form.title.trim() } : {}),
        };
      }
    }
    if (!form.prompt.trim()) errors.prompt = "请填写要发送的提示";
    if (Object.keys(errors).length > 0 || !trigger || !target) return { ok: false, errors };
    return { ok: true, draft: { ...common, kind: "cron", trigger, target, prompt: form.prompt.trim(), onBusy: form.onBusy } };
  }

  if (!form.agentId) errors.agentId = "请选择会话";

  if (form.kind === "heartbeat") {
    const idle = parsePositiveInt(form.idleMinutes);
    if (idle === null) errors.idleMinutes = "空闲分钟数需为不小于 1 的整数";
    let maxRuns: number | undefined;
    if (form.maxRuns.trim()) {
      const parsed = parsePositiveInt(form.maxRuns);
      if (parsed === null) errors.maxRuns = "最多触发次数需为不小于 1 的整数，留空表示不限";
      else maxRuns = parsed;
    }
    if (!form.prompt.trim()) errors.prompt = "请填写要发送的提示";
    if (Object.keys(errors).length > 0 || idle === null) return { ok: false, errors };
    return {
      ok: true,
      draft: {
        ...common,
        kind: "heartbeat",
        agentId: form.agentId,
        idleMinutes: idle,
        prompt: form.prompt.trim(),
        ...(maxRuns !== undefined ? { maxRuns } : {}),
      },
    };
  }

  if (!form.goal.trim()) errors.goal = "请填写目标";
  const maxIterations = parsePositiveInt(form.maxIterations);
  if (maxIterations === null || maxIterations > 1000) errors.maxIterations = "最大轮数需为 1–1000 的整数";
  if (!form.doneMarker.trim()) errors.doneMarker = "请填写完成标记";
  if (form.judgeEnabled && !form.judgeProvider) errors.judgeProvider = "请选择评判用的 Agent";
  if (Object.keys(errors).length > 0 || maxIterations === null) return { ok: false, errors };
  return {
    ok: true,
    draft: {
      ...common,
      kind: "goal",
      agentId: form.agentId,
      goal: form.goal.trim(),
      doneMarker: form.doneMarker.trim(),
      maxIterations,
      stopOnFailure: form.stopOnFailure,
      ...(form.judgeEnabled
        ? { judge: { provider: form.judgeProvider, ...(form.judgeModel.trim() ? { model: form.judgeModel.trim() } : {}) } }
        : {}),
    },
  };
}

// ── 会话详情：心跳 / 目标循环状态条 ─────────────────────────────────────

export interface AutomationBarItem {
  scheduleId: string;
  kind: "goal" | "heartbeat";
  /** 状态文案，如「目标循环 3/10」 */
  label: string;
  tone: "active" | "paused";
  /** 点击后的动作：停止（暂停 / 停用）或继续（恢复 / 启用） */
  action: { kind: "stop" | "resume"; label: string };
}

/** 该会话上需要在状态条显示的项：进行中 / 已暂停的目标循环，启用 / 停用的心跳（已完成 / 失败的目标不显示）。 */
export function automationBarItems(schedules: Schedule[], agentId: string | null | undefined): AutomationBarItem[] {
  if (!agentId) return [];
  const items: AutomationBarItem[] = [];
  for (const schedule of schedules) {
    if (schedule.kind === "goal" && schedule.agentId === agentId) {
      if (schedule.state === "running") {
        items.push({
          scheduleId: schedule.id,
          kind: "goal",
          label: `目标循环 ${schedule.iterations}/${schedule.maxIterations}`,
          tone: "active",
          action: { kind: "stop", label: "停止" },
        });
      } else if (schedule.state === "stopped") {
        items.push({
          scheduleId: schedule.id,
          kind: "goal",
          label: `目标循环已暂停 ${schedule.iterations}/${schedule.maxIterations}`,
          tone: "paused",
          action: { kind: "resume", label: "继续" },
        });
      }
    } else if (schedule.kind === "heartbeat" && schedule.agentId === agentId) {
      const progress = schedule.maxRuns !== undefined ? ` · ${schedule.runs}/${schedule.maxRuns}` : "";
      items.push(
        schedule.enabled
          ? {
              scheduleId: schedule.id,
              kind: "heartbeat",
              label: `心跳：空闲 ${schedule.idleMinutes} 分钟后发送${progress}`,
              tone: "active",
              action: { kind: "stop", label: "停止" },
            }
          : {
              scheduleId: schedule.id,
              kind: "heartbeat",
              label: `心跳已停用${progress}`,
              tone: "paused",
              action: { kind: "resume", label: "启用" },
            },
      );
    }
  }
  return items;
}

/** 状态条动作对应的 upsert 草稿：停止 = enabled false（目标循环由 sidecar 转为 stopped）；继续 = 启用 / 恢复运行。 */
export function automationActionDraft(schedule: Schedule, action: "stop" | "resume"): ScheduleDraft {
  const enabled = action === "resume";
  if (schedule.kind === "goal") {
    return { ...schedule, enabled, state: enabled ? "running" : "stopped" };
  }
  return { ...schedule, enabled };
}

/** 会话可选作定时任务 / 心跳 / 目标循环目标：不含隐藏的评判会话。 */
export function selectableAgents(agents: AgentSnapshot[]): AgentSnapshot[] {
  return agents.filter((agent) => agent.origin !== "judge");
}
