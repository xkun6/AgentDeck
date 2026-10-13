// 新建会话时的「Agent（provider）+ 模型 + 模式 + 思考强度」选择，记忆在 ui_store。
import type { AgentMode, AgentModelDefinition, AgentSnapshot, ProviderInfo } from "@agentdeck/protocol";
import { readUiValue, writeUiValue } from "./ui-store";

export interface AgentSelection {
  provider: string | null;
  /** null 表示使用 provider 默认模型 */
  model: string | null;
  /** null 表示使用 provider 默认模式 */
  modeId: string | null;
  /** 思考强度；null / 缺省表示跟随 CLI 设置（design.md 4.10） */
  thinkingOptionId?: string | null;
}

export const AGENT_SELECTION_STORAGE_KEY = "agentdeck.composer.agent-selection";

const EMPTY_SELECTION: AgentSelection = { provider: null, model: null, modeId: null, thinkingOptionId: null };

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
    thinkingOptionId: stringOrNull(record.thinkingOptionId),
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

/** 实际生效的模型：选了就是它，未选（null）时为目录里的 isDefault 模型。 */
export function findEffectiveModel(
  modelId: string | null | undefined,
  models: AgentModelDefinition[] | null | undefined,
): AgentModelDefinition | undefined {
  if (!models) return undefined;
  return modelId ? models.find((model) => model.id === modelId) : models.find((model) => model.isDefault);
}

/** 模型是否提供该思考档位。 */
export function modelHasThinkingOption(
  model: AgentModelDefinition | undefined,
  thinkingOptionId: string | null | undefined,
): boolean {
  return Boolean(thinkingOptionId && model?.thinkingOptions?.some((option) => option.id === thinkingOptionId));
}

/** 目录加载后丢掉当前模型不支持的思考档位（回落到默认 = 跟随 CLI）；目录未加载时原样保留。 */
export function resolveThinkingChoice(
  value: string | null | undefined,
  models: AgentModelDefinition[] | null | undefined,
  modelId: string | null,
): string | null {
  if (!value) return null;
  if (!models) return value;
  return modelHasThinkingOption(findEffectiveModel(modelId, models), value) ? value : null;
}

/** 会话中切换选择用到的动作（hooks/use-agent-session.ts 的子集）。 */
export interface AgentSelectionActions {
  setModel(agentId: string, modelId: string | null): Promise<AgentSnapshot>;
  setMode(agentId: string, modeId: string): Promise<AgentSnapshot>;
  setThinking(agentId: string, thinkingOptionId: string | null): Promise<{ agent: AgentSnapshot; notice?: string }>;
}

/**
 * 已建会话中应用选择变化：依次切模型、模式、思考强度（思考强度运行中也可切换，下一轮生效）。
 * 换模型时 sidecar 已按新模型校正档位，因此与校正后的快照比较，只有用户改了思考强度才调用 setThinking。
 */
export async function applyAgentSelectionChange(
  actions: AgentSelectionActions,
  agentId: string,
  snapshot: Pick<AgentSnapshot, "model" | "modeId" | "thinkingOptionId">,
  next: AgentSelection,
): Promise<{ thinkingChanged: boolean; notice?: string }> {
  let current: Pick<AgentSnapshot, "thinkingOptionId"> = snapshot;
  if (next.model !== (snapshot.model ?? null)) current = await actions.setModel(agentId, next.model);
  if (next.modeId && next.modeId !== (snapshot.modeId ?? null)) current = await actions.setMode(agentId, next.modeId);
  const thinking = next.thinkingOptionId ?? null;
  if (thinking === (current.thinkingOptionId ?? null)) return { thinkingChanged: false };
  const result = await actions.setThinking(agentId, thinking);
  return { thinkingChanged: true, ...(result.notice ? { notice: result.notice } : {}) };
}

/** 目录加载后丢掉已不存在的模型 / 模式（回落到默认）。 */
export function resolveCatalogChoice(
  value: string | null,
  options: Array<AgentModelDefinition | AgentMode> | undefined,
): string | null {
  if (!value || !options) return value;
  return options.some((option) => option.id === value) ? value : null;
}
