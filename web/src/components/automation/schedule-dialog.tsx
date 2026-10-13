// 定时任务 / 心跳 / 目标循环的新建与编辑弹窗（design.md 4.25）。表单校验与草稿构造见 lib/schedule-display.ts。
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAtom, useAtomValue } from "jotai";
import { X } from "lucide-react";
import { Button, Dialog, Field, IconButton, Input, Select, Textarea } from "@agentdeck/shared-ui";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { useAgentProviders } from "@/hooks/use-agent-catalog";
import { agentDisplayTitle, agentProviderLabel } from "@/lib/agent-session-display";
import {
  CRON_PREVIEW_COUNT,
  CRON_PRESETS,
  buildScheduleDraft,
  emptyScheduleForm,
  formFromSchedule,
  formatScheduleTime,
  nextCronRuns,
  selectableAgents,
  type ScheduleFormErrors,
  type ScheduleFormKind,
  type ScheduleFormState,
} from "@/lib/schedule-display";
import { agentListAtom } from "@/stores/agents";
import { scheduleDialogAtom, type ScheduleDialogRequest } from "@/stores/schedules";
import s from "./schedule-dialog.module.css";

const KIND_LABELS: Record<ScheduleFormKind, string> = {
  cron: "定时任务",
  heartbeat: "心跳",
  goal: "目标循环",
};

function initialForm(request: ScheduleDialogRequest): ScheduleFormState {
  if (request.schedule) return formFromSchedule(request.schedule);
  const defaults: Partial<ScheduleFormState> = request.agentId ? { agentId: request.agentId } : {};
  return emptyScheduleForm(request.kind, defaults);
}

interface ScheduleDialogProps {
  request: ScheduleDialogRequest | null;
  onClose: () => void;
}

export function ScheduleDialog({ request, onClose }: ScheduleDialogProps) {
  return (
    <Dialog.Root open={request !== null} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className={s.dialog} aria-describedby={undefined}>
          {request ? <ScheduleForm key={request.schedule?.id ?? `${request.kind}:${request.agentId ?? ""}`} request={request} onClose={onClose} /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ScheduleForm({ request, onClose }: { request: ScheduleDialogRequest; onClose: () => void }) {
  const actions = useAgentSession();
  const agents = useAtomValue(agentListAtom);
  const { data: providers } = useAgentProviders();
  const [form, setForm] = useState<ScheduleFormState>(() => initialForm(request));
  const [errors, setErrors] = useState<ScheduleFormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = Boolean(request.schedule);

  const patch = (value: Partial<ScheduleFormState>) => setForm((current) => ({ ...current, ...value }));
  const candidates = useMemo(() => selectableAgents(agents), [agents]);
  const availableProviders = useMemo(() => (providers ?? []).filter((item) => item.available), [providers]);

  // 新建时给 provider 一个默认值
  useEffect(() => {
    if (form.provider || availableProviders.length === 0) return;
    setForm((current) => (current.provider ? current : { ...current, provider: availableProviders[0]!.id }));
  }, [availableProviders, form.provider]);

  const preview = useMemo(
    () => (form.kind === "cron" && form.triggerType === "cron" ? nextCronRuns(form.cron, CRON_PREVIEW_COUNT) : []),
    [form.kind, form.triggerType, form.cron],
  );

  const submit = async () => {
    const result = buildScheduleDraft(form);
    if (!result.ok) {
      setErrors(result.errors);
      setSubmitError(null);
      return;
    }
    setErrors({});
    setSubmitError(null);
    setSaving(true);
    try {
      await actions.upsertSchedule(result.draft);
      onClose();
    } catch (error) {
      setSubmitError(humanizeSidecarError(error));
      setSaving(false);
    }
  };

  const agentSelect = (
    <Field label="会话" error={errors.agentId} required>
      <Select
        aria-label="会话"
        value={form.agentId}
        invalid={Boolean(errors.agentId)}
        onChange={(event) => patch({ agentId: event.target.value })}
      >
        <option value="">请选择会话</option>
        {candidates.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agentDisplayTitle(agent, undefined, providers)}
          </option>
        ))}
      </Select>
    </Field>
  );

  const providerOptions = (placeholder: string): ReactNode => (
    <>
      <option value="">{placeholder}</option>
      {availableProviders.map((item) => (
        <option key={item.id} value={item.id}>
          {agentProviderLabel(item.id, providers)}
        </option>
      ))}
    </>
  );

  return (
    <>
      <div className={s.head}>
        <Dialog.Title asChild>
          <h2 className={s.title}>{editing ? "编辑" : "新建"}{KIND_LABELS[form.kind]}</h2>
        </Dialog.Title>
        <Dialog.Close asChild>
          <IconButton aria-label="关闭">
            <X size={16} aria-hidden="true" />
          </IconButton>
        </Dialog.Close>
      </div>
      <div className={s.body}>
        <div className={s.kindTabs} role="tablist" aria-label="类型">
          {(Object.keys(KIND_LABELS) as ScheduleFormKind[]).map((kind) => (
            <button
              key={kind}
              type="button"
              role="tab"
              aria-selected={form.kind === kind}
              className={s.kindTab}
              data-active={form.kind === kind ? "true" : undefined}
              disabled={editing || request.lockKind}
              onClick={() => patch({ kind })}
            >
              {KIND_LABELS[kind]}
            </button>
          ))}
        </div>

        <Field label="名称" error={errors.name} required>
          <Input
            aria-label="名称"
            value={form.name}
            invalid={Boolean(errors.name)}
            placeholder={form.kind === "cron" ? "如：每天早上巡检" : form.kind === "heartbeat" ? "如：长任务保活" : "如：修复所有测试"}
            onChange={(event) => patch({ name: event.target.value })}
          />
        </Field>

        {form.kind === "cron" ? (
          <>
            <Field label="触发方式">
              <Select
                aria-label="触发方式"
                value={form.triggerType}
                onChange={(event) => patch({ triggerType: event.target.value as ScheduleFormState["triggerType"] })}
              >
                <option value="cron">cron 表达式</option>
                <option value="every">固定间隔</option>
                <option value="at">一次性</option>
              </Select>
            </Field>
            {form.triggerType === "cron" ? (
              <>
                <Field label="cron 表达式（分 时 日 月 周，本地时区）" error={errors.cron} required>
                  <Input
                    aria-label="cron 表达式"
                    mono
                    value={form.cron}
                    invalid={Boolean(errors.cron)}
                    onChange={(event) => patch({ cron: event.target.value })}
                  />
                </Field>
                <div className={s.presets} role="group" aria-label="常用预设">
                  {CRON_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className={s.preset}
                      data-active={form.cron.trim() === preset.cron ? "true" : undefined}
                      onClick={() => patch({ cron: preset.cron })}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                {preview.length > 0 ? (
                  <ol className={s.preview} aria-label="未来触发时间">
                    <li className={s.previewTitle}>未来 {preview.length} 次触发</li>
                    {preview.map((ms) => (
                      <li key={ms}>{formatScheduleTime(ms)}</li>
                    ))}
                  </ol>
                ) : null}
              </>
            ) : null}
            {form.triggerType === "every" ? (
              <Field label="间隔（分钟）" error={errors.everyMinutes} required>
                <Input
                  aria-label="间隔分钟"
                  inputMode="numeric"
                  value={form.everyMinutes}
                  invalid={Boolean(errors.everyMinutes)}
                  onChange={(event) => patch({ everyMinutes: event.target.value })}
                />
              </Field>
            ) : null}
            {form.triggerType === "at" ? (
              <Field label="触发时间" error={errors.at} hint="触发后任务自动停用" required>
                <Input
                  aria-label="触发时间"
                  type="datetime-local"
                  value={form.at}
                  invalid={Boolean(errors.at)}
                  onChange={(event) => patch({ at: event.target.value })}
                />
              </Field>
            ) : null}

            <Field label="目标">
              <Select
                aria-label="目标类型"
                value={form.targetType}
                onChange={(event) => patch({ targetType: event.target.value as "agent" | "new" })}
              >
                <option value="agent">发送到现有会话</option>
                <option value="new">每次新建会话</option>
              </Select>
            </Field>
            {form.targetType === "agent" ? (
              agentSelect
            ) : (
              <>
                <div className={s.row}>
                  <Field label="Agent" error={errors.provider} required>
                    <Select
                      aria-label="Agent"
                      value={form.provider}
                      invalid={Boolean(errors.provider)}
                      onChange={(event) => patch({ provider: event.target.value })}
                    >
                      {providerOptions("请选择 Agent")}
                    </Select>
                  </Field>
                  <Field label="模型（可选）">
                    <Input
                      aria-label="模型"
                      value={form.model}
                      placeholder="留空 = 默认"
                      onChange={(event) => patch({ model: event.target.value })}
                    />
                  </Field>
                </div>
                <Field label="工作目录" error={errors.cwd} required>
                  <Input
                    aria-label="工作目录"
                    mono
                    value={form.cwd}
                    invalid={Boolean(errors.cwd)}
                    placeholder="如：D:\\work\\repo"
                    onChange={(event) => patch({ cwd: event.target.value })}
                  />
                </Field>
                <Field label="会话标题（可选）" hint="留空则使用任务名称">
                  <Input aria-label="会话标题" value={form.title} onChange={(event) => patch({ title: event.target.value })} />
                </Field>
              </>
            )}
            <Field label="发送的提示" error={errors.prompt} required>
              <Textarea
                aria-label="发送的提示"
                rows={4}
                value={form.prompt}
                invalid={Boolean(errors.prompt)}
                onChange={(event) => patch({ prompt: event.target.value })}
              />
            </Field>
            {form.targetType === "agent" ? (
              <Field label="目标会话正忙时">
                <Select
                  aria-label="忙时处理"
                  value={form.onBusy}
                  onChange={(event) => patch({ onBusy: event.target.value as "skip" | "wait" })}
                >
                  <option value="skip">跳过本次</option>
                  <option value="wait">等待空闲后发送（最多 30 分钟）</option>
                </Select>
              </Field>
            ) : null}
          </>
        ) : null}

        {form.kind === "heartbeat" ? (
          <>
            {agentSelect}
            <div className={s.row}>
              <Field label="空闲多少分钟后发送" error={errors.idleMinutes} required>
                <Input
                  aria-label="空闲分钟"
                  inputMode="numeric"
                  value={form.idleMinutes}
                  invalid={Boolean(errors.idleMinutes)}
                  onChange={(event) => patch({ idleMinutes: event.target.value })}
                />
              </Field>
              <Field label="最多触发次数（可选）" error={errors.maxRuns}>
                <Input
                  aria-label="最多触发次数"
                  inputMode="numeric"
                  value={form.maxRuns}
                  placeholder="留空 = 不限"
                  invalid={Boolean(errors.maxRuns)}
                  onChange={(event) => patch({ maxRuns: event.target.value })}
                />
              </Field>
            </div>
            <Field label="发送的提示" error={errors.prompt} required>
              <Textarea
                aria-label="发送的提示"
                rows={4}
                value={form.prompt}
                invalid={Boolean(errors.prompt)}
                onChange={(event) => patch({ prompt: event.target.value })}
              />
            </Field>
          </>
        ) : null}

        {form.kind === "goal" ? (
          <>
            {agentSelect}
            <Field label="目标" error={errors.goal} required>
              <Textarea
                aria-label="目标"
                rows={4}
                value={form.goal}
                invalid={Boolean(errors.goal)}
                onChange={(event) => patch({ goal: event.target.value })}
              />
            </Field>
            <div className={s.row}>
              <Field label="完成标记（回复末行）" error={errors.doneMarker} required>
                <Input
                  aria-label="完成标记"
                  mono
                  value={form.doneMarker}
                  invalid={Boolean(errors.doneMarker)}
                  onChange={(event) => patch({ doneMarker: event.target.value })}
                />
              </Field>
              <Field label="最大轮数" error={errors.maxIterations} required>
                <Input
                  aria-label="最大轮数"
                  inputMode="numeric"
                  value={form.maxIterations}
                  invalid={Boolean(errors.maxIterations)}
                  onChange={(event) => patch({ maxIterations: event.target.value })}
                />
              </Field>
            </div>
            <label className={s.check}>
              <input
                type="checkbox"
                checked={form.stopOnFailure}
                onChange={(event) => patch({ stopOnFailure: event.target.checked })}
              />
              回合失败时停止循环
            </label>
            <label className={s.check}>
              <input
                type="checkbox"
                checked={form.judgeEnabled}
                onChange={(event) => patch({ judgeEnabled: event.target.checked })}
              />
              用独立评判会话判定是否完成（替代末行标记）
            </label>
            {form.judgeEnabled ? (
              <div className={s.row}>
                <Field label="评判 Agent" error={errors.judgeProvider} required>
                  <Select
                    aria-label="评判 Agent"
                    value={form.judgeProvider}
                    invalid={Boolean(errors.judgeProvider)}
                    onChange={(event) => patch({ judgeProvider: event.target.value })}
                  >
                    {providerOptions("请选择 Agent")}
                  </Select>
                </Field>
                <Field label="评判模型（可选）">
                  <Input
                    aria-label="评判模型"
                    value={form.judgeModel}
                    placeholder="留空 = 默认"
                    onChange={(event) => patch({ judgeModel: event.target.value })}
                  />
                </Field>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      <div className={s.foot}>
        {submitError ? <span className={s.footError} role="alert">{submitError}</span> : null}
        <Button variant="outline" onClick={onClose}>取消</Button>
        <Button variant="solid" tone="accent" loading={saving} onClick={() => void submit()}>
          {editing ? "保存" : form.kind === "goal" ? "创建并开始" : "创建"}
        </Button>
      </div>
    </>
  );
}

/** 挂在应用根部：自动化页与会话右键菜单通过 scheduleDialogAtom 打开同一个弹窗。 */
export function ScheduleDialogHost() {
  const [request, setRequest] = useAtom(scheduleDialogAtom);
  return <ScheduleDialog request={request} onClose={() => setRequest(null)} />;
}
