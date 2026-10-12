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
 * 跳过权限确认的危险模式（design.md 5.3）：Claude `bypassPermissions`、Codex `full-access`。
 * 选择器中醒目标注，且绝不默认选中——因此也不写入记忆。
 */
const DANGEROUS_MODE_IDS = new Set(["bypassPermissions", "full-access"]);

export function isDangerousMode(modeId: string | null | undefined): boolean {
  return Boolean(modeId && DANGEROUS_MODE_IDS.has(modeId));
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
    modeId: isDangerousMode(stringOrNull(record.modeId)) ? null : stringOrNull(record.modeId),
  };
}

export function writeAgentSelection(selection: AgentSelection): void {
  writeUiValue(AGENT_SELECTION_STORAGE_KEY, {
    ...selection,
    modeId: isDangerousMode(selection.modeId) ? null : selection.modeId,
  });
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
