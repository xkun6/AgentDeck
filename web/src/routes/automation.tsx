// 「自动化」页（design.md 4.25）：定时任务 / 心跳 / 目标循环的列表、启停、立即运行、编辑、删除、运行记录与全局暂停。
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue, useSetAtom } from "jotai";
import { Pencil, Play, Plus, Trash2 } from "lucide-react";
import { Button, IconButton, LoadingState, Select } from "@agentdeck/shared-ui";
import type { Schedule, ScheduleDraft, ScheduleRun } from "@agentdeck/protocol";
import { TopBar } from "@/components/top-bar/top-bar";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { useAgentProviders } from "@/hooks/use-agent-catalog";
import { agentDisplayTitle, agentProviderLabel } from "@/lib/agent-session-display";
import {
  RUN_OUTCOME_LABELS,
  automationActionDraft,
  describeSchedulePlan,
  describeTarget,
  describeTrigger,
  formatScheduleTime,
} from "@/lib/schedule-display";
import { useConfirm } from "@/lib/use-confirm";
import { agentSnapshotsAtom, sidecarConnectionAtom } from "@/stores/agents";
import { scheduleDialogAtom, schedulesStateAtom } from "@/stores/schedules";
import s from "./automation.module.css";

const RUNS_LIMIT = 50;

const GROUPS: Array<{ kind: Schedule["kind"]; title: string; hint: string }> = [
  { kind: "cron", title: "定时任务", hint: "按 cron、固定间隔或一次性时间向会话发送提示" },
  { kind: "heartbeat", title: "心跳", hint: "会话空闲满指定时长后发送一条提示，每个空闲期只触发一次" },
  { kind: "goal", title: "目标循环", hint: "会话每轮结束后检查是否完成，未完成则自动继续推进" },
];

function Switch({ checked, label, disabled, onChange }: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={s.switch}
      data-on={checked ? "true" : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className={s.switchThumb} />
    </button>
  );
}

export function AutomationRoute() {
  const actions = useAgentSession();
  const { confirm } = useConfirm();
  const connected = useAtomValue(sidecarConnectionAtom) === "open";
  const { schedules, paused, loaded, revision } = useAtomValue(schedulesStateAtom);
  const agents = useAtomValue(agentSnapshotsAtom);
  const { data: providers } = useAgentProviders();
  const openDialog = useSetAtom(scheduleDialogAtom);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [runsFilter, setRunsFilter] = useState("");

  useEffect(() => {
    if (connected && !loaded) actions.listSchedules().catch(() => {});
  }, [actions, connected, loaded]);

  const runsQuery = useQuery({
    queryKey: ["agentdeck", "schedule-runs", runsFilter, revision],
    queryFn: () => actions.listScheduleRuns(runsFilter || undefined, RUNS_LIMIT),
    enabled: connected,
    placeholderData: (previous) => previous,
    retry: false,
  });

  const nameById = useMemo(() => new Map(schedules.map((schedule) => [schedule.id, schedule.name])), [schedules]);
  const agentTitle = (agentId: string) => {
    const agent = agents[agentId];
    return agent ? agentDisplayTitle(agent, undefined, providers) : null;
  };
  const providerLabel = (provider: string) => agentProviderLabel(provider, providers);

  const report = (title: string, error: unknown) =>
    confirm({ title, body: humanizeSidecarError(error), confirmLabel: "知道了", cancelLabel: "关闭" });

  const run = async (id: string, task: () => Promise<unknown>, failureTitle: string) => {
    setPendingId(id);
    try {
      await task();
    } catch (error) {
      await report(failureTitle, error);
    } finally {
      setPendingId(null);
    }
  };

  const toggle = (schedule: Schedule, enabled: boolean) => {
    const draft: ScheduleDraft =
      schedule.kind === "goal"
        ? automationActionDraft(schedule, enabled ? "resume" : "stop")
        : { ...schedule, enabled };
    return run(schedule.id, () => actions.upsertSchedule(draft), enabled ? "启用失败" : "停用失败");
  };

  const remove = async (schedule: Schedule) => {
    const confirmed = await confirm({
      title: "删除任务",
      body: `确认删除「${schedule.name}」？运行记录会保留。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (confirmed) await run(schedule.id, () => actions.deleteSchedule(schedule.id), "删除失败");
  };

  const rowMeta = (schedule: Schedule): string => {
    if (schedule.kind === "cron") {
      return `${describeTrigger(schedule)}，${describeTarget(schedule.target, agentTitle, providerLabel)}`;
    }
    const target = `会话「${agentTitle(schedule.agentId) ?? "已删除的会话"}」`;
    return schedule.kind === "goal" ? `${target}，${schedule.goal}` : `${target}，${schedule.prompt}`;
  };

  return (
    <main className={s.page}>
      <TopBar title="自动化" />
      <div className={s.toolbar}>
        <label className={s.pauseLabel}>
          <Switch
            checked={paused}
            label="全部暂停"
            disabled={!connected}
            onChange={(next) => {
              actions.setSchedulesPaused(next).catch((error: unknown) => void report("切换暂停失败", error));
            }}
          />
          全部暂停
        </label>
        {paused ? <p className={s.pausedBanner} role="status">已全局暂停：所有触发都会被跳过</p> : null}
        <span className={s.toolbarSpacer} />
        <Button size="sm" leadingIcon={<Plus size={12} />} onClick={() => openDialog({ kind: "cron" })}>新建定时任务</Button>
        <Button size="sm" leadingIcon={<Plus size={12} />} onClick={() => openDialog({ kind: "heartbeat" })}>新建心跳</Button>
        <Button size="sm" leadingIcon={<Plus size={12} />} onClick={() => openDialog({ kind: "goal" })}>新建目标循环</Button>
      </div>
      <div className={s.scroll}>
        {!connected ? (
          <div className={s.empty}>Agent 服务未连接</div>
        ) : !loaded ? (
          <LoadingState variant="page" label="正在读取…" />
        ) : (
          <div className={s.content}>
            {GROUPS.map((group) => {
              const items = schedules.filter((schedule) => schedule.kind === group.kind);
              return (
                <section key={group.kind} className={s.group} aria-label={group.title}>
                  <h2 className={s.groupTitle}>{group.title}</h2>
                  <p className={s.groupHint}>{group.hint}</p>
                  {items.length === 0 ? (
                    <div className={s.empty}>暂无{group.title}</div>
                  ) : (
                    <ul className={s.list}>
                      {items.map((schedule) => (
                        <li key={schedule.id} className={s.row} data-kind={schedule.kind}>
                          <Switch
                            checked={schedule.enabled}
                            label={`${schedule.enabled ? "停用" : "启用"}：${schedule.name}`}
                            disabled={pendingId === schedule.id}
                            onChange={(next) => void toggle(schedule, next)}
                          />
                          <div className={s.rowMain}>
                            <span className={s.rowName}>{schedule.name}</span>
                            <span className={s.rowMeta} title={rowMeta(schedule)}>{rowMeta(schedule)}</span>
                          </div>
                          <span className={s.rowPlan}>{describeSchedulePlan(schedule)}</span>
                          <div className={s.rowActions}>
                            {schedule.kind === "goal" && schedule.enabled ? null : (
                              <IconButton
                                aria-label={schedule.kind === "goal" ? `继续：${schedule.name}` : `立即运行：${schedule.name}`}
                                title={schedule.kind === "goal" ? "继续循环" : "立即运行"}
                                disabled={pendingId === schedule.id}
                                onClick={() => void run(schedule.id, () => actions.runScheduleNow(schedule.id), "运行失败")}
                              >
                                <Play size={12} aria-hidden="true" />
                              </IconButton>
                            )}
                            <IconButton
                              aria-label={`编辑：${schedule.name}`}
                              title="编辑"
                              onClick={() => openDialog({ kind: schedule.kind, schedule })}
                            >
                              <Pencil size={12} aria-hidden="true" />
                            </IconButton>
                            <IconButton
                              aria-label={`删除：${schedule.name}`}
                              title="删除"
                              onClick={() => void remove(schedule)}
                            >
                              <Trash2 size={12} aria-hidden="true" />
                            </IconButton>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}

            <section className={s.group} aria-label="运行记录">
              <div className={s.runsHead}>
                <h2 className={s.groupTitle}>运行记录</h2>
                <Select
                  aria-label="按任务筛选运行记录"
                  className={s.runsFilter}
                  value={runsFilter}
                  onChange={(event) => setRunsFilter(event.target.value)}
                >
                  <option value="">全部任务</option>
                  {schedules.map((schedule) => (
                    <option key={schedule.id} value={schedule.id}>{schedule.name}</option>
                  ))}
                </Select>
              </div>
              <RunsList runs={runsQuery.data} loading={runsQuery.isLoading} nameById={nameById} />
            </section>
          </div>
        )}
      </div>
    </main>
  );
}

function RunsList({ runs, loading, nameById }: {
  runs: ScheduleRun[] | undefined;
  loading: boolean;
  nameById: Map<string, string>;
}) {
  if (loading) return <LoadingState label="正在读取运行记录…" />;
  if (!runs || runs.length === 0) return <div className={s.empty}>暂无运行记录</div>;
  return (
    <ul className={s.list}>
      {runs.map((run, index) => (
        <li key={`${run.scheduleId}-${run.ts}-${index}`} className={s.run}>
          <span className={s.runTime}>{formatScheduleTime(run.ts)}</span>
          <span className={s.runName}>{nameById.get(run.scheduleId) ?? "已删除的任务"}</span>
          <span className={s.runOutcome} data-outcome={run.outcome}>{RUN_OUTCOME_LABELS[run.outcome] ?? run.outcome}</span>
          {run.message ? <span className={s.runMessage} title={run.message}>{run.message}</span> : null}
        </li>
      ))}
    </ul>
  );
}
