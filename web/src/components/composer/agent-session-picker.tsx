// 新建会话的「Agent（provider）+ 模型 + 模式」选择器（design.md 第 6 节）。
// 纯展示组件：数据与记忆由 hooks/use-agent-catalog.ts 的 useAgentSessionSelection 提供。
// 三个选择器都是 chip 式下拉（ChipSelect），由输入框工具栏排成一组。
import { Bot, Cpu, ShieldAlert, SlidersHorizontal } from "lucide-react";
import type { AgentMode, AgentModelDefinition, ProviderInfo, ProviderProfile } from "@agentdeck/protocol";
import { findMode, isDangerousMode, type AgentSelection } from "@/lib/agent-selection";
import { buildProviderMenuEntries, PROVIDER_GROUP_RELAY } from "@/lib/provider-profiles";
import { ChipSelect, type ChipSelectOption } from "./chip-select";
import s from "./agent-session-picker.module.css";

export interface AgentSessionPickerProps {
  selection: AgentSelection;
  onChange: (next: AgentSelection) => void;
  /** null 表示仍在加载 */
  providers: ProviderInfo[] | null;
  /** providers.json 中的中转配置：用于列出已停用的中转（置灰）与「基于 … · host」副文字 */
  providerProfiles?: ProviderProfile[] | null;
  providersError?: string;
  catalog: { models: AgentModelDefinition[]; modes: AgentMode[] } | null;
  catalogLoading?: boolean;
  catalogError?: string;
  disabled?: boolean;
  /** 已建会话：provider 不可再换，只能切模型 / 模式 */
  providerLocked?: boolean;
}

const DANGEROUS_MODE_WARNING = "危险模式：Agent 将不经确认直接执行命令和修改文件";

/** 「内置」/「中转」分组；没有中转时不显示分组标题。 */
function providerOptions(
  providers: ProviderInfo[] | null,
  profiles: ProviderProfile[] | null | undefined,
): ChipSelectOption[] {
  const entries = buildProviderMenuEntries(providers, profiles);
  const grouped = entries.some((entry) => entry.group === PROVIDER_GROUP_RELAY);
  return entries.map((entry) => ({
    value: entry.value,
    label: entry.label,
    disabled: entry.disabled,
    description: entry.description,
    ...(grouped ? { group: entry.group } : {}),
  }));
}

function modelOptions(models: AgentModelDefinition[], loading: boolean | undefined): ChipSelectOption[] {
  return [
    { value: "", label: loading ? "加载中…" : "默认模型", description: "使用 Agent 的默认模型" },
    ...models.map((model) => ({
      value: model.id,
      label: model.label,
      badge: model.isDefault ? "默认" : undefined,
      description: model.description,
    })),
  ];
}

/** Claude（含基于 Claude 的中转）不选模式时不传 --permission-mode，跟随用户的 Claude Code 设置 */
function defaultModeDescription(provider: ProviderInfo | undefined): string {
  return provider?.kind === "claude" ? "跟随 Claude Code 设置" : "使用 Agent 的默认模式";
}

function modeOptions(modes: AgentMode[], defaultDescription: string): ChipSelectOption[] {
  return [
    { value: "", label: "默认模式", description: defaultDescription },
    ...modes.map((mode) => {
      const dangerous = isDangerousMode(mode);
      return {
        value: mode.id,
        label: mode.label,
        badge: dangerous ? "危险" : undefined,
        danger: dangerous,
        description: dangerous
          ? ["跳过权限确认", mode.description].filter(Boolean).join("；")
          : mode.description,
      };
    }),
  ];
}

export function AgentSessionPicker({
  selection,
  onChange,
  providers,
  providerProfiles,
  providersError,
  catalog,
  catalogLoading,
  catalogError,
  disabled,
  providerLocked,
}: AgentSessionPickerProps) {
  const providerValue = selection.provider ?? "";
  const provider = providers?.find((item) => item.id === providerValue);
  const catalogDisabled = disabled || !selection.provider || !catalog;
  const error = providersError ?? catalogError;
  const selectedMode = findMode(selection.modeId, catalog?.modes);
  const dangerous = isDangerousMode(selectedMode);
  const models = catalog?.models ?? [];
  const modes = catalog?.modes ?? [];
  const selectedModel = models.find((model) => model.id === selection.model);

  const providerDisplay = provider
    ? provider.label
    : providers === null
      ? "加载中…"
      : providers.length === 0
        ? "没有可用的 Agent"
        : "请选择";
  const modelDisplay = selectedModel?.label ?? selection.model ?? (catalogLoading ? "加载中…" : "默认模型");
  const modeDisplay = selectedMode?.label ?? "默认模式";

  return (
    <div className={s.picker} role="group" aria-label="Agent 设置">
      <div className={s.chips}>
        <ChipSelect
          label="Agent"
          hint={providerLocked ? "已建会话不能更换 Agent" : "选择驱动本会话的 Agent"}
          icon={<Bot />}
          value={provider ? providerValue : ""}
          displayValue={providerDisplay}
          options={providerOptions(providers, providerProfiles)}
          onChange={(next) => onChange({ provider: next || null, model: null, modeId: null })}
          disabled={disabled || providerLocked || !providers || providers.length === 0}
        />
        <ChipSelect
          label="模型"
          hint="留空使用 Agent 默认模型"
          icon={<Cpu />}
          value={selection.model ?? ""}
          displayValue={modelDisplay}
          options={modelOptions(models, catalogLoading)}
          onChange={(next) => onChange({ ...selection, model: next || null })}
          disabled={catalogDisabled}
        />
        <ChipSelect
          label="模式"
          hint={dangerous ? DANGEROUS_MODE_WARNING : "留空使用 Agent 默认模式"}
          icon={dangerous ? <ShieldAlert /> : <SlidersHorizontal />}
          value={selection.modeId ?? ""}
          displayValue={modeDisplay}
          options={modeOptions(modes, defaultModeDescription(provider))}
          onChange={(next) => onChange({ ...selection, modeId: next || null })}
          disabled={catalogDisabled || modes.length === 0}
          danger={dangerous}
        />
      </div>

      {dangerous ? (
        <span className={s.notice} data-tone="danger" role="alert">
          <ShieldAlert className={s.noticeIcon} aria-hidden="true" />
          <span>{DANGEROUS_MODE_WARNING}</span>
        </span>
      ) : null}

      {error ? (
        <span className={s.notice} data-tone="error" role="alert" title={error}>
          <span className={s.noticeText}>{error}</span>
        </span>
      ) : null}
    </div>
  );
}
