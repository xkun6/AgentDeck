// Derived from paseo packages/server/src/server/agent/providers/claude/model-manifest.ts and models.ts (Apache-2.0); modified for AgentDeck
// Claude 思考强度档位（design.md 4.10）：
// - 优先用 claude initialize 应答里每个模型的 supportsEffort / supportedEffortLevels（Claude Code 2.1.296 起提供）；
// - 否则按 paseo 的模型清单（只保留 effortLevels / supportsThinkingDisabled 两项能力）按 id 归一化查找；
// - 都判断不了的模型给标准组 low / medium / high / max。
// AgentDeck 改动：不移植 paseo 的 ultracode 档位、快速模式、上下文窗口与版本门槛；标签改为中文。
import type { AgentModelDefinition, AgentThinkingOption } from "@agentdeck/protocol";

import { thinkingOptionsFromIds } from "../shared/thinking-options.js";

export type ClaudeEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export const CLAUDE_DISABLED_THINKING_OPTION_ID = "off";
export const CLAUDE_DEFAULT_THINKING_OPTION_ID = "high";

const EFFORT_ORDER: readonly ClaudeEffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
export const CLAUDE_STANDARD_EFFORT_LEVELS: readonly ClaudeEffortLevel[] = [
  "low",
  "medium",
  "high",
  "max",
];
const XHIGH_EFFORT_LEVELS: readonly ClaudeEffortLevel[] = EFFORT_ORDER;

interface ManifestEntry {
  id: string;
  effortLevels?: readonly ClaudeEffortLevel[];
  supportsThinkingDisabled?: boolean;
}

/** paseo 清单的能力子集（哪些模型有 xhigh、哪些可关闭思考） */
const CLAUDE_MODEL_MANIFEST: readonly ManifestEntry[] = [
  { id: "claude-opus-5", effortLevels: XHIGH_EFFORT_LEVELS, supportsThinkingDisabled: true },
  { id: "claude-fable-5-1", effortLevels: XHIGH_EFFORT_LEVELS },
  { id: "claude-fable-5", effortLevels: XHIGH_EFFORT_LEVELS },
  { id: "claude-opus-4-8[1m]", effortLevels: XHIGH_EFFORT_LEVELS, supportsThinkingDisabled: true },
  { id: "claude-opus-4-8", effortLevels: XHIGH_EFFORT_LEVELS, supportsThinkingDisabled: true },
  { id: "claude-sonnet-5", effortLevels: XHIGH_EFFORT_LEVELS, supportsThinkingDisabled: true },
  { id: "claude-sonnet-5[1m]", effortLevels: XHIGH_EFFORT_LEVELS, supportsThinkingDisabled: true },
  { id: "claude-opus-4-7[1m]", effortLevels: XHIGH_EFFORT_LEVELS, supportsThinkingDisabled: true },
  { id: "claude-opus-4-7", effortLevels: XHIGH_EFFORT_LEVELS, supportsThinkingDisabled: true },
  {
    id: "claude-opus-4-6[1m]",
    effortLevels: CLAUDE_STANDARD_EFFORT_LEVELS,
    supportsThinkingDisabled: true,
  },
  { id: "claude-opus-4-6", effortLevels: CLAUDE_STANDARD_EFFORT_LEVELS, supportsThinkingDisabled: true },
  {
    id: "claude-sonnet-4-6[1m]",
    effortLevels: CLAUDE_STANDARD_EFFORT_LEVELS,
    supportsThinkingDisabled: true,
  },
  {
    id: "claude-sonnet-4-6",
    effortLevels: CLAUDE_STANDARD_EFFORT_LEVELS,
    supportsThinkingDisabled: true,
  },
  { id: "claude-haiku-4-5" },
];

/** initialize 应答 models[] 里与思考强度相关的字段 */
export interface ClaudeModelEffortInfo {
  supportsEffort?: unknown;
  supportedEffortLevels?: unknown;
  resolvedModel?: unknown;
}

export function isClaudeEffortLevel(value: string): value is ClaudeEffortLevel {
  return (EFFORT_ORDER as readonly string[]).includes(value);
}

/** Claude 认识的档位：off 与五个 effort */
export function isClaudeThinkingOption(value: string): boolean {
  return value === CLAUDE_DISABLED_THINKING_OPTION_ID || isClaudeEffortLevel(value);
}

function findManifestEntry(modelId: string | null | undefined): ManifestEntry | undefined {
  const id = normalizeClaudeManifestModelId(modelId);
  return id ? CLAUDE_MODEL_MANIFEST.find((entry) => entry.id === id) : undefined;
}

/**
 * 把 Claude 模型 id 归一化成清单 id（如 `claude-opus-4-6-20260101` → `claude-opus-4-6`）；
 * 别名（opus / sonnet …）与未知 id 返回 null。
 */
export function normalizeClaudeManifestModelId(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return null;
  }
  if (CLAUDE_MODEL_MANIFEST.some((entry) => entry.id === trimmed)) {
    return trimmed;
  }
  const oneM = trimmed.toLowerCase().includes("[1m]");
  const single = trimmed.match(
    /^(?:claude[-_ ])?(fable|opus|sonnet|haiku)[-_ ]+(\d+)(?:\[1m\])?(?:[-_ ]+\d{8})?(?:\[1m\])?$/i,
  );
  if (single) {
    return pickManifestId(`claude-${single[1]!.toLowerCase()}-${single[2]}`, oneM);
  }
  const majorMinor = trimmed.match(
    /^(?:claude[-_ ])?(fable|opus|sonnet|haiku)[-_ ]+(\d+)[-.](\d+)(?:\[1m\])?(?:[-_ ]+\d{8})?(?:\[1m\])?$/i,
  );
  if (majorMinor) {
    return pickManifestId(
      `claude-${majorMinor[1]!.toLowerCase()}-${majorMinor[2]}-${majorMinor[3]}`,
      oneM,
    );
  }
  return null;
}

function pickManifestId(base: string, oneM: boolean): string | null {
  const candidates = oneM ? [`${base}[1m]`, base] : [base];
  return candidates.find((id) => CLAUDE_MODEL_MANIFEST.some((entry) => entry.id === id)) ?? null;
}

/**
 * 某个 Claude 模型的思考档位；返回 undefined 表示不支持选择。
 * `info` 为 initialize 应答里该模型的条目（没有时只按 id 判断）。
 */
export function claudeThinkingOptionsFor(
  modelId: string,
  info?: ClaudeModelEffortInfo,
): AgentThinkingOption[] | undefined {
  const resolved = typeof info?.resolvedModel === "string" ? info.resolvedModel : undefined;
  const manifest = findManifestEntry(resolved) ?? findManifestEntry(modelId);

  let levels: readonly ClaudeEffortLevel[] | undefined;
  if (info?.supportsEffort === false) {
    levels = undefined;
  } else if (Array.isArray(info?.supportedEffortLevels)) {
    const reported = new Set(
      info.supportedEffortLevels.filter(
        (level): level is ClaudeEffortLevel => typeof level === "string" && isClaudeEffortLevel(level),
      ),
    );
    levels = reported.size > 0 ? EFFORT_ORDER.filter((level) => reported.has(level)) : undefined;
  } else if (manifest) {
    levels = manifest.effortLevels;
  } else {
    levels = CLAUDE_STANDARD_EFFORT_LEVELS;
  }
  if (!levels || levels.length === 0) {
    return undefined;
  }
  const ids: string[] = [
    ...(manifest?.supportsThinkingDisabled ? [CLAUDE_DISABLED_THINKING_OPTION_ID] : []),
    ...levels,
  ];
  return thinkingOptionsFromIds(ids);
}

/** 给模型挂上思考档位（已有 thinkingOptions 的保持不变） */
export function withClaudeThinkingOptions(
  model: AgentModelDefinition,
  info?: ClaudeModelEffortInfo,
): AgentModelDefinition {
  if (model.thinkingOptions !== undefined) {
    return model;
  }
  return withThinkingOptions(model, claudeThinkingOptionsFor(model.id, info));
}

/** 中转静态模型：一律给标准组 low / medium / high / max */
export function claudeStandardThinkingOptions(): AgentThinkingOption[] {
  return thinkingOptionsFromIds(CLAUDE_STANDARD_EFFORT_LEVELS);
}

export function withThinkingOptions(
  model: AgentModelDefinition,
  options: AgentThinkingOption[] | undefined,
  defaultId: string = CLAUDE_DEFAULT_THINKING_OPTION_ID,
): AgentModelDefinition {
  if (!options || options.length === 0) {
    return model;
  }
  return {
    ...model,
    thinkingOptions: options,
    ...(options.some((option) => option.id === defaultId) ? { defaultThinkingOptionId: defaultId } : {}),
  };
}

/** 档位 → claude 启动参数：off 为 `--thinking disabled`，其它为 `--effort <level>`，null 不传 */
export function claudeThinkingArgs(thinkingOptionId: string | null): string[] {
  if (!thinkingOptionId) {
    return [];
  }
  if (thinkingOptionId === CLAUDE_DISABLED_THINKING_OPTION_ID) {
    return ["--thinking", "disabled"];
  }
  return ["--effort", thinkingOptionId];
}
