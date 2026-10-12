// 新建会话时的「Agent（provider）+ 模型 + 模式」选择，记忆在 ui_store。
import type { AgentMode, AgentModelDefinition, ProviderInfo } from "@agentdeck/protocol";
import { readUiValue, writeUiValue } from "./ui-store";

export interface AgentSelection {
  provider: string | null;
  /** null 表示使用 provider 默认模型 */
  model: string | null;
  /** null 表示使用 provider 默认模式 */
  modeId: string | null;
}

export const AGENT_SELECTION_STORAGE_KEY = "agentdeck.composer.agent-selection";

const EMPTY_SELECTION: AgentSelection = { provider: null, model: null, modeId: null };

/**
 * 跳过权限确认的危险模式由 sidecar 用 `AgentMode.dangerous` 标出（design.md 4.5，
 * 如 Claude `bypassPermissions`、Codex `full-access`）。选择器中醒目标注，且绝不默认选中——
 * 因此不写入记忆，记忆里残留的危险模式也不会被恢复。
 */
export function isDangerousMode(mode: Pick<AgentMode, "dangerous"> | null | undefined): boolean {
  return mode?.dangerous === true;
}

export function findMode(
  modeId: string | null | undefined,
  modes: AgentMode[] | null | undefined,
): AgentMode | undefined {
  if (!modeId || !modes) return undefined;
  return modes.find((mode) => mode.id === modeId);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function readAgentSelection(): AgentSelection {
  const raw = readUiValue<unknown>(AGENT_SELECTION_STORAGE_KEY, null);
  if (!raw || typeof raw !== "object") return EMPTY_SELECTION;
  const record = raw as Record<string, unknown>;
  return {
    provider: stringOrNull(record.provider),
    model: stringOrNull(record.model),
    modeId: stringOrNull(record.modeId),
  };
}

/** 写入记忆；`modes` 为当前目录，危险模式不写入。 */
export function writeAgentSelection(selection: AgentSelection, modes?: AgentMode[] | null): void {
  writeUiValue(AGENT_SELECTION_STORAGE_KEY, {
    ...selection,
    modeId: isDangerousMode(findMode(selection.modeId, modes)) ? null : selection.modeId,
  });
}

/**
 * 解析要展示的模式：目录未加载或已不存在 → 默认；危险模式只有本次手动选中的那个（`pickedDangerousModeId`）
 * 才保留，其余（例如来自记忆）一律回落到默认，保证危险模式不会被默认选中。
 */
export function resolveModeChoice(
  value: string | null,
  modes: AgentMode[] | null | undefined,
  pickedDangerousModeId: string | null = null,
): string | null {
  const mode = findMode(value, modes);
  if (!mode) return null;
  return isDangerousMode(mode) && mode.id !== pickedDangerousModeId ? null : mode.id;
}

/** 记住的 provider 可用就用它；否则取第一个可用的真实 Agent，最后才回落到 mock。 */
export function resolveProvider(
  preferred: string | null,
  providers: ProviderInfo[] | null,
): string | null {
  if (!providers) return preferred;
  const available = providers.filter((provider) => provider.available);
  if (preferred && available.some((provider) => provider.id === preferred)) return preferred;
  const real = available.find((provider) => provider.kind !== "mock");
  return real?.id ?? available[0]?.id ?? null;
}

/** 目录加载后丢掉已不存在的模型 / 模式（回落到默认）。 */
export function resolveCatalogChoice(
  value: string | null,
  options: Array<AgentModelDefinition | AgentMode> | undefined,
): string | null {
  if (!value || !options) return value;
  return options.some((option) => option.id === value) ? value : null;
}
