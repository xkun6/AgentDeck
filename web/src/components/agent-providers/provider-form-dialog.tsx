// 「添加 / 编辑中转」弹窗（design.md 4.7）：基于 Claude Code / Codex / ACP 的自定义 provider 表单，
// 支持测试连接（provider.test，只请求 /v1/models）、从接口拉取模型、整表保存（provider.config.set）。
// 密钥只在受控输入框里遮挡显示，不打日志。
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Braces, ChevronRight, DownloadCloud, Eye, EyeOff, FolderOpen, Plus, Star, Trash2, Zap } from "lucide-react";
import type { ProviderInfo, ProviderProfile, ProviderProfileExtends, ProviderTestResult } from "@agentdeck/protocol";
import { Alert, Button, Dialog, Field, IconButton, Input, Textarea } from "@agentdeck/shared-ui";
import { SidecarRpcError } from "@/lib/sidecar-client";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { useSaveProviderConfig } from "@/hooks/use-provider-config";
import {
  DEFAULT_RELAY_DISALLOWED_TOOLS,
  emptyProviderForm,
  formatSettingsText,
  formToProfile,
  mapIssuesToForm,
  mergeFetchedModels,
  newRowKey,
  parseSettingsText,
  PROFILE_EXTENDS_LABELS,
  profileToForm,
  readRpcIssues,
  reservedProfileIds,
  setDefaultModel,
  slugifyProfileId,
  validateProfileId,
  validateProviderForm,
  type ProviderFormErrors,
  type ProviderFormState,
} from "@/lib/provider-profiles";
import s from "./provider-form-dialog.module.css";

export type ProviderFormTarget = { kind: "create" } | { kind: "edit"; index: number };

export interface ProviderFormDialogProps {
  /** null = 关闭 */
  target: ProviderFormTarget | null;
  profiles: ProviderProfile[];
  providers: ProviderInfo[] | null;
  /** providers.json 路径；null 表示未设数据目录，无法保存 */
  configPath: string | null;
  onClose: () => void;
}

const EXTENDS_OPTIONS: { value: ProviderProfileExtends; label: string; hint: string }[] = [
  { value: "claude", label: "Claude Code", hint: "Anthropic 兼容接口" },
  { value: "codex", label: "Codex", hint: "OpenAI Responses 接口" },
  { value: "acp", label: "ACP 自定义命令", hint: "任意 ACP Agent" },
];

const AUTH_MODE_OPTIONS = [
  { value: "auth_token" as const, label: "Auth Token", hint: "Bearer，多数中转用这个" },
  { value: "api_key" as const, label: "API Key", hint: "x-api-key 头" },
];

/** 去掉空模型行 / 空环境变量行，保证提交后 issues 的下标与表单行一致。 */
function compactForm(form: ProviderFormState): ProviderFormState {
  return {
    ...form,
    models: form.models.filter((model) => model.id.trim() || model.label.trim() || model.description.trim()),
    env: form.env.filter((row) => row.name.trim() || row.value),
  };
}

/** provider.test 的 profile：名称 / id 尚未填写时用占位值，便于先测后起名。 */
function testProfileOf(form: ProviderFormState): ProviderProfile {
  const profile = formToProfile(form);
  return {
    ...profile,
    id: validateProfileId(profile.id) ? "relay-test" : profile.id,
    label: profile.label || "测试",
  };
}

function describeTestResult(result: ProviderTestResult, extendsValue: ProviderProfileExtends): string {
  const parts: string[] = [];
  if (result.status !== undefined) parts.push(`HTTP ${result.status}`);
  if (result.latencyMs !== undefined) parts.push(`${result.latencyMs} ms`);
  if (result.ok) {
    if (extendsValue !== "acp") {
      parts.push(result.models?.length ? `拉取到 ${result.models.length} 个模型` : "未解析到模型列表");
    }
    return [extendsValue === "acp" ? "启动命令可用" : "连接成功", ...parts].join(" · ");
  }
  return [`连接失败：${result.error || "未知错误"}`, ...parts].join(" · ");
}

function SecretInput({
  id,
  value,
  onChange,
  placeholder,
  invalid,
  label,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  invalid?: boolean;
  label: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className={s.secret}>
      <Input
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        placeholder={placeholder}
        invalid={invalid}
        mono
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      />
      <IconButton
        aria-label={visible ? `隐藏${label}` : `显示${label}`}
        title={visible ? "隐藏" : "显示"}
        variant="outline"
        size="md"
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? <EyeOff size={12} /> : <Eye size={12} />}
      </IconButton>
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className={s.segmented} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={s.segment}
          data-active={option.value === value ? "true" : undefined}
          onClick={() => onChange(option.value)}
        >
          <span className={s.segmentLabel}>{option.label}</span>
          {option.hint ? <span className={s.segmentHint}>{option.hint}</span> : null}
        </button>
      ))}
    </div>
  );
}

function FormSection({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className={s.section}>
      <header className={s.sectionHead}>
        <h3 className={s.sectionTitle}>{title}</h3>
        {aside ? <div className={s.sectionAside}>{aside}</div> : null}
      </header>
      <div className={s.sectionBody}>{children}</div>
    </section>
  );
}

export function ProviderFormDialog({ target, profiles, providers, configPath, onClose }: ProviderFormDialogProps) {
  const open = target !== null;
  const editIndex = target?.kind === "edit" ? target.index : null;
  const original = editIndex !== null ? profiles[editIndex] : undefined;
  const actions = useAgentSession();
  const saveConfig = useSaveProviderConfig();
  const baseId = useId();
  const fieldId = (name: string) => `${baseId}-${name}`;

  const [form, setForm] = useState<ProviderFormState>(() => emptyProviderForm());
  const [errors, setErrors] = useState<ProviderFormErrors>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<"test" | "fetch" | null>(null);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);
  const [fetched, setFetched] = useState<{ id: string; label: string; checked: boolean }[] | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // 打开时初始化（编辑：载入原配置；新建：空表单）
  useEffect(() => {
    if (!target) return;
    const next = original ? profileToForm(original) : emptyProviderForm();
    setForm(next);
    setErrors({});
    setGeneralError(null);
    setTestResult(null);
    setFetched(null);
    setSaving(false);
    setTesting(null);
    setAdvancedOpen(Boolean(original && (original.env && Object.keys(original.env).length > 0 || (original.extends !== "acp" && original.command?.length))));
    // 只在打开 / 切换目标时初始化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const takenIds = useMemo(() => {
    const taken = reservedProfileIds(providers);
    profiles.forEach((profile, index) => {
      if (index !== editIndex) taken.add(profile.id);
    });
    return taken;
  }, [editIndex, profiles, providers]);

  const clearError = (...keys: string[]) => {
    setErrors((current) => {
      if (!keys.some((key) => key in current)) return current;
      const next = { ...current };
      for (const key of keys) delete next[key];
      return next;
    });
  };

  const update = (patch: Partial<ProviderFormState>, ...errorKeys: string[]) => {
    setForm((current) => ({ ...current, ...patch }));
    if (errorKeys.length) clearError(...errorKeys);
    setTestResult(null);
  };

  const onLabelChange = (label: string) => {
    setForm((current) => ({
      ...current,
      label,
      id: current.idTouched ? current.id : slugifyProfileId(label, takenIds),
    }));
    clearError("label", "id");
  };

  const isRemote = form.extends !== "acp";
  const isClaude = form.extends === "claude";
  const hasBaseUrl = form.baseUrl.trim().length > 0;
  // 内联设置实时校验：非法时就地报错并禁止保存
  const settingsParse = parseSettingsText(form.settingsText);
  const settingsInvalid = isClaude && settingsParse.kind === "error";
  const hasClaudeSettings = isClaude && (form.settingsFile.trim().length > 0 || settingsParse.kind === "ok");
  const canBrowseSettings = typeof window !== "undefined" && Boolean(window.hermesDesktop?.pickJsonFile);

  const browseSettingsFile = async () => {
    const pick = window.hermesDesktop?.pickJsonFile;
    if (!pick) return;
    try {
      const result = await pick({ title: "选择 Claude 设置文件" });
      const selected = result.paths[0];
      if (!result.canceled && selected) update({ settingsFile: selected }, "settingsFile");
    } catch (error) {
      setGeneralError(`打开文件对话框失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const filledModels = form.models.filter((model) => model.id.trim() || model.label.trim());
  const idChanged = Boolean(original && original.id !== form.id.trim());

  const applyRpcError = (error: unknown, index: number | null) => {
    if (error instanceof SidecarRpcError && error.code === -32602) {
      const mapped = mapIssuesToForm(readRpcIssues(error.data), index);
      setErrors(mapped.fields);
      const general = mapped.general.length ? mapped.general.join("；") : null;
      setGeneralError(
        general ?? (Object.keys(mapped.fields).length ? null : humanizeSidecarError(error)),
      );
      if (Object.keys(mapped.fields).some((key) => key === "env" || (key === "command" && form.extends !== "acp"))) {
        setAdvancedOpen(true);
      }
      return;
    }
    if (error instanceof SidecarRpcError && error.businessCode === "NOT_SUPPORTED") {
      setGeneralError("未设置数据目录（AGENTDECK_DATA_DIR），无法保存中转配置。请使用桌面端启动 AgentDeck。");
      return;
    }
    setGeneralError(humanizeSidecarError(error));
  };

  const runTest = async (mode: "test" | "fetch") => {
    if (settingsInvalid) {
      setGeneralError("内联设置不是合法的 JSON 对象，请先修正。");
      return;
    }
    const compacted = compactForm(form);
    setForm((current) => compactForm(current));
    setGeneralError(null);
    setTesting(mode);
    setTestResult(null);
    if (mode === "fetch") setFetched(null);
    try {
      const result = await actions.testProvider(testProfileOf(compacted));
      setTestResult(result);
      if (mode === "fetch" && result.ok) {
        const existing = new Set(compacted.models.map((model) => model.id.trim()));
        setFetched(
          (result.models ?? []).map((model) => ({ ...model, checked: !existing.has(model.id) })),
        );
      }
    } catch (error) {
      applyRpcError(error, null);
    } finally {
      setTesting(null);
    }
  };

  const onSave = async () => {
    const compacted = compactForm(form);
    setForm((current) => compactForm(current));
    setGeneralError(null);
    const localErrors = validateProviderForm(compacted);
    if (Object.keys(localErrors).length > 0) {
      setErrors(localErrors);
      if (localErrors.env || (localErrors.command && compacted.extends !== "acp")) setAdvancedOpen(true);
      return;
    }
    const profile = formToProfile(compacted);
    const index = editIndex ?? profiles.length;
    const next = editIndex !== null
      ? profiles.map((item, itemIndex) => (itemIndex === editIndex ? profile : item))
      : [...profiles, profile];
    setSaving(true);
    try {
      await saveConfig(next);
      onClose();
    } catch (error) {
      applyRpcError(error, index);
    } finally {
      setSaving(false);
    }
  };

  const fetchedChecked = fetched?.filter((model) => model.checked) ?? [];

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !saving) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content
          className={s.dialog}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            // 打开时聚焦「名称」，而不是第一个分段按钮
            const labelInput = document.getElementById(fieldId("label"));
            if (labelInput) {
              event.preventDefault();
              labelInput.focus();
            }
          }}
        >
          <header className={s.head}>
            <Dialog.Title asChild>
              <h2 className={s.title}>{original ? `编辑中转「${original.label}」` : "添加中转"}</h2>
            </Dialog.Title>
          </header>

          <div className={s.body}>
            <FormSection title="基于">
              <Segmented
                label="基于"
                value={form.extends}
                options={EXTENDS_OPTIONS}
                onChange={(value) => update({ extends: value }, "command", "baseUrl", "apiKey", "models")}
              />
            </FormSection>

            <FormSection title="基本信息">
              <div className={s.grid2}>
                <Field label="名称" required htmlFor={fieldId("label")} error={errors.label}>
                  <Input
                    id={fieldId("label")}
                    value={form.label}
                    placeholder="例如 我的中转"
                    maxLength={40}
                    invalid={Boolean(errors.label)}
                    onChange={(event) => onLabelChange(event.target.value)}
                  />
                </Field>
                <Field
                  label="id"
                  required
                  htmlFor={fieldId("id")}
                  error={errors.id}
                  hint={idChanged ? "修改 id 后，使用旧 id 的历史会话将无法恢复" : undefined}
                >
                  <Input
                    id={fieldId("id")}
                    value={form.id}
                    mono
                    placeholder="my-relay"
                    maxLength={32}
                    invalid={Boolean(errors.id)}
                    spellCheck={false}
                    onChange={(event) => update({ id: event.target.value, idTouched: true }, "id")}
                  />
                </Field>
              </div>
              <Field label="描述" htmlFor={fieldId("description")} error={errors.description}>
                <Input
                  id={fieldId("description")}
                  value={form.description}
                  placeholder="可选"
                  onChange={(event) => update({ description: event.target.value }, "description")}
                />
              </Field>
            </FormSection>

            {isRemote ? (
              <FormSection title="接口">
                <Field
                  label="Base URL"
                  htmlFor={fieldId("baseUrl")}
                  error={errors.baseUrl}
                  hint={form.extends === "codex"
                    ? "不以 /v1 结尾会自动补上；端点须支持 OpenAI Responses API。留空使用官方接口"
                    : "例如 https://relay.example.com（不含 /v1）。留空时沿用 Claude 设置中的 ANTHROPIC_BASE_URL，都没有则用官方接口"}
                >
                  <Input
                    id={fieldId("baseUrl")}
                    value={form.baseUrl}
                    mono
                    placeholder="https://"
                    invalid={Boolean(errors.baseUrl)}
                    spellCheck={false}
                    onChange={(event) => update({ baseUrl: event.target.value }, "baseUrl", "models")}
                  />
                </Field>
                <Field
                  label="API Key"
                  htmlFor={fieldId("apiKey")}
                  error={errors.apiKey}
                  hint={isClaude ? "中转只会发送这里配置的密钥，你本机 Claude 的登录凭据不会发给三方。" : undefined}
                >
                  <SecretInput
                    id={fieldId("apiKey")}
                    label="API Key"
                    value={form.apiKey}
                    placeholder="sk-…"
                    invalid={Boolean(errors.apiKey)}
                    onChange={(value) => update({ apiKey: value }, "apiKey")}
                  />
                </Field>
                {isClaude ? (
                  <Field label="认证方式" error={errors.authMode}>
                    <Segmented
                      label="认证方式"
                      value={form.authMode}
                      options={AUTH_MODE_OPTIONS}
                      onChange={(value) => update({ authMode: value }, "authMode")}
                    />
                  </Field>
                ) : null}
              </FormSection>
            ) : (
              <FormSection title="启动命令">
                <Field
                  label="命令"
                  required
                  htmlFor={fieldId("command")}
                  error={errors.command}
                  hint="一行，按空格分隔参数；含空格的参数用引号包裹，例如 npx -y @scope/agent --acp"
                >
                  <Input
                    id={fieldId("command")}
                    value={form.commandText}
                    mono
                    placeholder="my-agent --acp"
                    invalid={Boolean(errors.command)}
                    spellCheck={false}
                    onChange={(event) => update({ commandText: event.target.value }, "command")}
                  />
                </Field>
              </FormSection>
            )}

            <FormSection
              title="模型"
              aside={
                <>
                  {isRemote ? (
                    <Button
                      size="sm"
                      variant="outline"
                      leadingIcon={<DownloadCloud size={12} />}
                      loading={testing === "fetch"}
                      disabled={testing !== null}
                      onClick={() => void runTest("fetch")}
                    >
                      从接口拉取
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    leadingIcon={<Plus size={12} />}
                    onClick={() =>
                      update({
                        models: [
                          ...form.models,
                          { key: newRowKey("model"), id: "", label: "", description: "", isDefault: false },
                        ],
                      }, "models")}
                  >
                    添加模型
                  </Button>
                </>
              }
            >
              {fetched ? (
                <div className={s.fetched} role="group" aria-label="接口返回的模型">
                  {fetched.length === 0 ? (
                    <p className={s.muted}>接口没有返回模型列表，请手动填写。</p>
                  ) : (
                    <ul className={s.fetchedList}>
                      {fetched.map((model, index) => (
                        <li key={model.id}>
                          <label className={s.check}>
                            <input
                              type="checkbox"
                              checked={model.checked}
                              onChange={(event) =>
                                setFetched((current) =>
                                  current?.map((item, itemIndex) =>
                                    itemIndex === index ? { ...item, checked: event.target.checked } : item) ?? null)}
                            />
                            <span className={s.mono}>{model.id}</span>
                            {model.label && model.label !== model.id ? (
                              <span className={s.muted}>{model.label}</span>
                            ) : null}
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className={s.fetchedActions}>
                    <Button size="sm" variant="ghost" onClick={() => setFetched(null)}>
                      取消
                    </Button>
                    {fetched.length > 0 ? (
                      <Button
                        size="sm"
                        variant="solid"
                        tone="accent"
                        disabled={fetchedChecked.length === 0}
                        onClick={() => {
                          update({ models: mergeFetchedModels(form.models, fetchedChecked) }, "models");
                          setFetched(null);
                        }}
                      >
                        填入所选（{fetchedChecked.length}）
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {form.models.length > 0 ? (
                <div className={s.table} role="table" aria-label="模型列表">
                  <div className={s.tableHead} role="row">
                    <span role="columnheader">模型 id</span>
                    <span role="columnheader">显示名</span>
                    <span role="columnheader" className={s.center}>默认</span>
                    <span role="columnheader" aria-label="操作" />
                  </div>
                  {form.models.map((model, index) => (
                    <div key={model.key} className={s.tableRow} role="row">
                      <div className={s.cell} role="cell">
                        <Input
                          controlSize="sm"
                          mono
                          value={model.id}
                          placeholder="claude-sonnet-4-5"
                          aria-label={`第 ${index + 1} 个模型 id`}
                          invalid={Boolean(errors[`models.${index}.id`])}
                          spellCheck={false}
                          onChange={(event) =>
                            update({
                              models: form.models.map((item) =>
                                item.key === model.key ? { ...item, id: event.target.value } : item),
                            }, `models.${index}.id`, "models")}
                        />
                        {errors[`models.${index}.id`] ? (
                          <span className={s.cellError}>{errors[`models.${index}.id`]}</span>
                        ) : null}
                      </div>
                      <div className={s.cell} role="cell">
                        <Input
                          controlSize="sm"
                          value={model.label}
                          placeholder="留空同 id"
                          aria-label={`第 ${index + 1} 个模型显示名`}
                          invalid={Boolean(errors[`models.${index}.label`])}
                          onChange={(event) =>
                            update({
                              models: form.models.map((item) =>
                                item.key === model.key ? { ...item, label: event.target.value } : item),
                            }, `models.${index}.label`)}
                        />
                        {errors[`models.${index}.label`] ? (
                          <span className={s.cellError}>{errors[`models.${index}.label`]}</span>
                        ) : null}
                      </div>
                      <div className={`${s.cell} ${s.center}`} role="cell">
                        <IconButton
                          aria-label={model.isDefault ? "取消默认模型" : "设为默认模型"}
                          aria-pressed={model.isDefault}
                          title={model.isDefault ? "默认模型（再次点击取消）" : "设为默认"}
                          className={s.defaultToggle}
                          data-active={model.isDefault ? "true" : undefined}
                          onClick={() => update({ models: setDefaultModel(form.models, model.key) })}
                        >
                          <Star size={12} />
                        </IconButton>
                      </div>
                      <div className={`${s.cell} ${s.center}`} role="cell">
                        <IconButton
                          aria-label={`删除第 ${index + 1} 个模型`}
                          title="删除"
                          onClick={() =>
                            update({ models: form.models.filter((item) => item.key !== model.key) }, "models")}
                        >
                          <Trash2 size={12} />
                        </IconButton>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              {errors.models ? (
                <Alert tone="danger" size="sm">{errors.models}</Alert>
              ) : form.extends === "codex" && filledModels.length === 0 ? (
                <Alert tone="warning" size="sm">
                  Codex 不会从中转发现模型，必须填写模型列表（可用「从接口拉取」）。
                </Alert>
              ) : filledModels.length === 0 ? (
                <p className={s.muted}>
                  {form.extends === "acp"
                    ? "未填写时使用 Agent 自身提供的模型（首次建会话后可见）。"
                    : "未填写时沿用 CLI 的模型发现；中转通常需要填写它支持的模型。"}
                </p>
              ) : null}
            </FormSection>

            {isClaude ? (
              <FormSection title="禁用的工具">
                <label className={s.check}>
                  <input
                    type="checkbox"
                    checked={form.customDisallowedTools}
                    onChange={(event) => update({ customDisallowedTools: event.target.checked }, "disallowedTools")}
                  />
                  <span>自定义禁用列表</span>
                </label>
                {form.customDisallowedTools ? (
                  <Field
                    htmlFor={fieldId("disallowedTools")}
                    error={errors.disallowedTools}
                    hint="逗号分隔，例如 WebSearch, WebFetch；留空表示不禁用任何工具"
                  >
                    <Input
                      id={fieldId("disallowedTools")}
                      value={form.disallowedToolsText}
                      mono
                      aria-label="禁用的工具"
                      placeholder={DEFAULT_RELAY_DISALLOWED_TOOLS.join(", ")}
                      invalid={Boolean(errors.disallowedTools)}
                      spellCheck={false}
                      onChange={(event) => update({ disallowedToolsText: event.target.value }, "disallowedTools")}
                    />
                  </Field>
                ) : (
                  <p className={s.muted}>
                    {hasBaseUrl
                      ? `已设置 Base URL：默认禁用 ${DEFAULT_RELAY_DISALLOWED_TOOLS.join("、")}（三方接口通常不支持服务端搜索）。`
                      : hasClaudeSettings
                        ? `未设置 Base URL：若 Claude 设置的 env 中有 ANTHROPIC_BASE_URL，同样默认禁用 ${DEFAULT_RELAY_DISALLOWED_TOOLS.join("、")}，否则不禁用。`
                        : "未设置 Base URL：不禁用任何工具。"}
                  </p>
                )}
              </FormSection>
            ) : null}

            {isClaude ? (
              <FormSection
                title="Claude 设置（settings.json）"
                aside={
                  <Button
                    size="sm"
                    variant="outline"
                    leadingIcon={<Braces size={12} />}
                    disabled={settingsParse.kind !== "ok"}
                    onClick={() => {
                      const formatted = formatSettingsText(form.settingsText);
                      if (formatted !== null) update({ settingsText: formatted }, "settings");
                    }}
                  >
                    格式化
                  </Button>
                }
              >
                <Field
                  label="设置文件"
                  htmlFor={fieldId("settingsFile")}
                  error={errors.settingsFile}
                  hint="Claude Code settings.json 的绝对路径，每次启动会话时读取；留空表示不使用"
                >
                  <div className={canBrowseSettings ? s.pathRow : undefined}>
                    <Input
                      id={fieldId("settingsFile")}
                      value={form.settingsFile}
                      mono
                      placeholder="例如 C:\Users\me\.claude\relay-settings.json"
                      invalid={Boolean(errors.settingsFile)}
                      spellCheck={false}
                      onChange={(event) => update({ settingsFile: event.target.value }, "settingsFile")}
                    />
                    {canBrowseSettings ? (
                      <Button
                        variant="outline"
                        leadingIcon={<FolderOpen size={12} />}
                        onClick={() => void browseSettingsFile()}
                      >
                        浏览…
                      </Button>
                    ) : null}
                  </div>
                </Field>
                <Field
                  label="内联 JSON"
                  htmlFor={fieldId("settings")}
                  error={errors.settings ?? (settingsParse.kind === "error" ? settingsParse.message : undefined)}
                  hint="一个 JSON 对象，例如 env、permissions、hooks；留空表示不使用"
                >
                  <Textarea
                    id={fieldId("settings")}
                    className={s.settingsText}
                    value={form.settingsText}
                    mono
                    rows={6}
                    placeholder={'{\n  "env": { "API_TIMEOUT_MS": "600000" },\n  "permissions": { "allow": ["Bash(npm test:*)"] }\n}'}
                    invalid={Boolean(errors.settings) || settingsParse.kind === "error"}
                    spellCheck={false}
                    onChange={(event) => update({ settingsText: event.target.value }, "settings")}
                  />
                </Field>
                <ul className={s.noteList}>
                  <li>合并顺序：设置文件 &lt; 内联 JSON &lt; 表单中的地址 / 密钥 / 环境变量。</li>
                  <li>
                    作为 flag 级设置与你的用户 / 项目设置合并：env 等对象按键合并，同名项以这里为准；
                    hooks 与 permissions 规则列表会与之叠加，而不是替换。
                  </li>
                  <li>内联 JSON 明文保存在 providers.json；合并后的设置（含文件内容）通过命令行传给 claude。</li>
                </ul>
              </FormSection>
            ) : null}

            <section className={s.section}>
              <button
                type="button"
                className={s.disclosure}
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen((current) => !current)}
              >
                <ChevronRight size={12} className={s.disclosureIcon} data-open={advancedOpen ? "true" : undefined} />
                <span>高级</span>
                <span className={s.muted}>环境变量{isRemote ? "、可执行文件路径" : ""}</span>
              </button>
              {advancedOpen ? (
                <div className={s.sectionBody}>
                  {isRemote ? (
                    <Field
                      label={`可执行文件路径（覆盖 ${form.extends}）`}
                      htmlFor={fieldId("commandOverride")}
                      error={errors.command}
                      hint="留空使用 PATH 中的 CLI；可附加参数，含空格的路径用引号包裹"
                    >
                      <Input
                        id={fieldId("commandOverride")}
                        value={form.commandText}
                        mono
                        placeholder={form.extends}
                        invalid={Boolean(errors.command)}
                        spellCheck={false}
                        onChange={(event) => update({ commandText: event.target.value }, "command")}
                      />
                    </Field>
                  ) : null}
                  <Field label="额外环境变量" error={errors.env} hint="最后应用，可覆盖由 Base URL / API Key 推导的值">
                    {form.env.length > 0 ? (
                      <div className={s.envList}>
                        {form.env.map((row, index) => (
                          <div key={row.key} className={s.envRow}>
                            <Input
                              mono
                              value={row.name}
                              placeholder="NAME"
                              aria-label={`第 ${index + 1} 个环境变量名`}
                              spellCheck={false}
                              onChange={(event) =>
                                update({
                                  env: form.env.map((item) =>
                                    item.key === row.key ? { ...item, name: event.target.value } : item),
                                }, "env")}
                            />
                            <SecretInput
                              label={`第 ${index + 1} 个环境变量值`}
                              value={row.value}
                              placeholder="值"
                              onChange={(value) =>
                                update({
                                  env: form.env.map((item) => (item.key === row.key ? { ...item, value } : item)),
                                }, "env")}
                            />
                            <IconButton
                              aria-label={`删除第 ${index + 1} 个环境变量`}
                              title="删除"
                              onClick={() => update({ env: form.env.filter((item) => item.key !== row.key) }, "env")}
                            >
                              <Trash2 size={12} />
                            </IconButton>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <div>
                      <Button
                        size="sm"
                        variant="outline"
                        leadingIcon={<Plus size={12} />}
                        onClick={() => update({ env: [...form.env, { key: newRowKey("env"), name: "", value: "" }] })}
                      >
                        添加变量
                      </Button>
                    </div>
                  </Field>
                </div>
              ) : null}
            </section>

            {configPath ? (
              <p className={s.note}>
                {"密钥以明文保存在本机数据目录的 providers.json（"}
                <code className={s.path}>{configPath}</code>
                {"），运行时会通过命令行与环境变量传给本机 CLI。"}
              </p>
            ) : (
              <Alert tone="warning" size="sm">
                未设置数据目录（AGENTDECK_DATA_DIR），无法保存中转配置；仍可测试连接。
              </Alert>
            )}
          </div>

          {testResult || generalError ? (
            <div className={s.status}>
              {testResult ? (
                <Alert tone={testResult.ok ? "success" : "danger"} size="sm" role="status" data-testid="provider-test-result">
                  {describeTestResult(testResult, form.extends)}
                </Alert>
              ) : null}
              {generalError ? (
                <Alert tone="danger" size="sm">{generalError}</Alert>
              ) : null}
            </div>
          ) : null}

          <footer className={s.foot}>
            <div className={s.footTest}>
              <Button
                variant="outline"
                leadingIcon={<Zap size={12} />}
                loading={testing === "test"}
                disabled={testing !== null || saving}
                onClick={() => void runTest("test")}
              >
                测试连接
              </Button>
              <span className={s.footHint}>
                {isRemote ? "只请求 /v1/models，不会产生对话费用" : "只检查启动命令能否解析"}
              </span>
            </div>
            <div className={s.footActions}>
              <Button variant="outline" disabled={saving} onClick={onClose}>
                取消
              </Button>
              <Button
                variant="solid"
                tone="accent"
                loading={saving}
                disabled={!configPath || settingsInvalid}
                title={settingsInvalid ? "内联 JSON 有误，修正后才能保存" : undefined}
                onClick={() => void onSave()}
              >
                保存
              </Button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
