// 新建会话的「Agent（provider）+ 模型 + 模式」选择器（design.md 第 6 节）。
// 纯展示组件：数据与记忆由 hooks/use-agent-catalog.ts 的 useAgentSessionSelection 提供。
import type { ChangeEvent } from "react";
import { Bot, Cpu, SlidersHorizontal } from "lucide-react";
import type { AgentMode, AgentModelDefinition, ProviderInfo } from "@agentdeck/protocol";
import { isDangerousMode, type AgentSelection } from "@/lib/agent-selection";
import s from "./agent-session-picker.module.css";

export interface AgentSessionPickerProps {
  selection: AgentSelection;
  onChange: (next: AgentSelection) => void;
  /** null 表示仍在加载 */
  providers: ProviderInfo[] | null;
  providersError?: string;
  catalog: { models: AgentModelDefinition[]; modes: AgentMode[] } | null;
  catalogLoading?: boolean;
  catalogError?: string;
  disabled?: boolean;
  /** 已建会话：provider 不可再换，只能切模型 / 模式 */
  providerLocked?: boolean;
}

export function providerOptionLabel(provider: ProviderInfo): string {
  if (provider.available) return provider.label;
  return `${provider.label}（不可用${provider.unavailableReason ? `：${provider.unavailableReason}` : ""}）`;
}

export function modeOptionLabel(mode: AgentMode): string {
  return isDangerousMode(mode.id) ? `${mode.label}（危险：跳过权限确认）` : mode.label;
}

export function AgentSessionPicker({
  selection,
  onChange,
  providers,
  providersError,
  catalog,
  catalogLoading,
  catalogError,
  disabled,
  providerLocked,
}: AgentSessionPickerProps) {
  const providerValue = selection.provider ?? "";
  const providerKnown = providers?.some((provider) => provider.id === providerValue) ?? false;
  const catalogDisabled = disabled || !selection.provider || !catalog;
  const error = providersError ?? catalogError;
  const dangerous = isDangerousMode(selection.modeId);

  const onProvider = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value || null;
    onChange({ provider: next, model: null, modeId: null });
  };
  const onModel = (event: ChangeEvent<HTMLSelectElement>) => {
    onChange({ ...selection, model: event.target.value || null });
  };
  const onMode = (event: ChangeEvent<HTMLSelectElement>) => {
    onChange({ ...selection, modeId: event.target.value || null });
  };

  return (
    <div className={s.picker} role="group" aria-label="Agent 设置">
      <label className={s.field} title="选择驱动本会话的 Agent">
        <Bot className={s.icon} aria-hidden="true" />
        <span className={s.label}>Agent</span>
        <select
          className={s.select}
          aria-label="Agent"
          value={providerKnown ? providerValue : ""}
          onChange={onProvider}
          disabled={disabled || providerLocked || !providers || providers.length === 0}
        >
          {!providerKnown ? (
            <option value="" disabled>
              {providers === null ? "加载中…" : providers.length === 0 ? "没有可用的 Agent" : "请选择"}
            </option>
          ) : null}
          {(providers ?? []).map((provider) => (
            <option
              key={provider.id}
              value={provider.id}
              disabled={!provider.available}
              title={provider.unavailableReason}
            >
              {providerOptionLabel(provider)}
            </option>
          ))}
        </select>
      </label>

      <label className={s.field} title="模型（留空使用 Agent 默认）">
        <Cpu className={s.icon} aria-hidden="true" />
        <span className={s.label}>模型</span>
        <select
          className={s.select}
          aria-label="模型"
          value={selection.model ?? ""}
          onChange={onModel}
          disabled={catalogDisabled}
        >
          <option value="">{catalogLoading ? "加载中…" : "默认模型"}</option>
          {(catalog?.models ?? []).map((model) => (
            <option key={model.id} value={model.id} title={model.description}>
              {model.isDefault ? `${model.label}（默认）` : model.label}
            </option>
          ))}
        </select>
      </label>

      <label
        className={`${s.field} ${dangerous ? s.fieldDanger : ""}`}
        title="模式（留空使用 Agent 默认）"
      >
        <SlidersHorizontal className={s.icon} aria-hidden="true" />
        <span className={s.label}>模式</span>
        <select
          className={s.select}
          aria-label="模式"
          value={selection.modeId ?? ""}
          onChange={onMode}
          disabled={catalogDisabled || (catalog?.modes.length ?? 0) === 0}
        >
          <option value="">默认模式</option>
          {(catalog?.modes ?? []).map((mode) => (
            <option key={mode.id} value={mode.id} title={mode.description}>
              {modeOptionLabel(mode)}
            </option>
          ))}
        </select>
      </label>

      {dangerous ? (
        <span className={s.warning} role="alert">
          危险模式：Agent 将不经确认直接执行命令和修改文件
        </span>
      ) : null}

      {error ? (
        <span className={s.error} role="alert" title={error}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
