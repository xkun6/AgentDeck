// Debug 面板的纯函数：sidecar 日志过滤、诊断信息组装、前端事件序列化（design.md 4.18）。
// 诊断信息只含运行状态 / 路径 / Agent 可用性 / 会话数量，绝不含 token、会话内容。
import type { AgentSnapshot, CodingAgentsCheckResult, DebugPaths, ProviderInfo } from "@agentdeck/protocol";
import type { DebugEntry } from "./debug-bus";
import { redact } from "./debug-redact";
import type { SidecarStatusPayload } from "./sidecar-client";

export type LogLevelFilter = "all" | "warn" | "error";

const LOG_LEVEL_RE = /^\S+\s+\[(debug|info|warn|error)\]/;
const LEVEL_RANK: Record<LogLevelFilter, number> = { all: 0, warn: 1, error: 2 };

function lineRank(level: string): number {
  if (level === "error") return 2;
  if (level === "warn") return 1;
  return 0;
}

/**
 * 按级别（全部 / 警告及以上 / 错误）与关键字（不区分大小写）过滤 sidecar 日志。
 * 没有 `[level]` 前缀的续行（多行堆栈等）沿用上一条的级别。
 */
export function filterLogText(text: string, level: LogLevelFilter, keyword: string): string {
  const needle = keyword.trim().toLowerCase();
  if (level === "all" && !needle) return text;
  const minRank = LEVEL_RANK[level];
  let currentRank = 0;
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const match = LOG_LEVEL_RE.exec(line);
    if (match) currentRank = lineRank(match[1]!);
    if (currentRank < minRank) continue;
    if (needle && !line.toLowerCase().includes(needle)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

export function sidecarPort(wsUrl: string | undefined): string | null {
  if (!wsUrl) return null;
  try {
    return new URL(wsUrl).port || null;
  } catch {
    return null;
  }
}

export function countSessionsByStatus(
  snapshots: Record<string, Pick<AgentSnapshot, "status">>,
): { total: number; byStatus: Record<string, number> } {
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const snapshot of Object.values(snapshots)) {
    total += 1;
    byStatus[snapshot.status] = (byStatus[snapshot.status] ?? 0) + 1;
  }
  return { total, byStatus };
}

export interface DiagnosticsInput {
  generatedAt: string;
  app: { version: string; commit: string; buildDate: string };
  sidecar: Pick<SidecarStatusPayload, "status" | "version" | "error" | "wsUrl"> | null;
  connection: string;
  paths: DebugPaths | null;
  providers: readonly ProviderInfo[] | null;
  codingAgents: CodingAgentsCheckResult | null;
  sessions: Record<string, Pick<AgentSnapshot, "status">>;
  platform: string;
  userAgent: string;
}

/** 组装诊断信息；只挑选白名单字段（连 wsUrl 也只取端口），再过一遍 debug-redact。 */
export function buildDiagnostics(input: DiagnosticsInput) {
  return redact({
    generatedAt: input.generatedAt,
    app: input.app,
    sidecar: input.sidecar
      ? {
          status: input.sidecar.status,
          version: input.sidecar.version,
          port: sidecarPort(input.sidecar.wsUrl),
          error: input.sidecar.error,
          connection: input.connection,
        }
      : { connection: input.connection },
    paths: input.paths,
    providers: (input.providers ?? []).map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      label: provider.label,
      available: provider.available,
      unavailableReason: provider.unavailableReason,
    })),
    codingAgents: (input.codingAgents?.agents ?? []).map((agent) => ({
      id: agent.id,
      label: agent.label,
      installed: agent.installed,
      version: agent.version,
      path: agent.path,
      loginState: agent.loginState,
    })),
    sessions: countSessionsByStatus(input.sessions),
    platform: input.platform,
    userAgent: input.userAgent,
  });
}

/** 前端事件序列化为 JSON Lines（debugBus 写入时已脱敏，这里再保险一次）。 */
export function eventsToJsonl(entries: readonly DebugEntry[]): string {
  return entries
    .map((entry) => JSON.stringify(redact({ ...entry, time: new Date(entry.ts).toISOString() })))
    .join("\n");
}
