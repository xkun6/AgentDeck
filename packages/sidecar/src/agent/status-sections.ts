// AgentDeck 本地 /status 的共享拼装工具（design.md 4.14）：各 provider 的 getStatus 复用。
import type { AgentMcpServerStatus, AgentMcpStatusResult, AgentStatusSection } from "@agentdeck/protocol";

export type StatusRow = AgentStatusSection["rows"][number];

const MCP_STATUS_LABEL: Record<AgentMcpServerStatus, string> = {
  connected: "已连接",
  failed: "失败",
  "needs-auth": "需要认证",
  pending: "连接中",
  disabled: "已禁用",
};
const MCP_STATUS_ORDER: AgentMcpServerStatus[] = ["connected", "failed", "needs-auth", "pending", "disabled"];

/** 非空字符串才算有值；其余（含纯空白）视为缺失，对应行跳过 */
export function presentText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 按顺序拼行，value 缺失的行跳过 */
export function buildRows(entries: Array<[label: string, value: string | null | undefined]>): StatusRow[] {
  return entries.flatMap(([label, value]) => (value ? [{ label, value }] : []));
}

/**
 * 「MCP」分组：概览「N 个服务器：x 已连接，y 失败…」，未连接的服务器逐个列出（带错误）。
 * 查询失败只在本分组显示错误，不让整个 /status 失败。
 */
export async function buildMcpSection(load: () => Promise<AgentMcpStatusResult>): Promise<AgentStatusSection> {
  try {
    const { servers } = await load();
    if (servers.length === 0) {
      return { title: "MCP", rows: [{ label: "概览", value: "未配置 MCP 服务器" }] };
    }
    const counts = MCP_STATUS_ORDER.flatMap((status) => {
      const count = servers.filter((server) => server.status === status).length;
      return count > 0 ? [`${count} ${MCP_STATUS_LABEL[status]}`] : [];
    });
    const rows: StatusRow[] = [{ label: "概览", value: `${servers.length} 个服务器：${counts.join("，")}` }];
    for (const server of servers) {
      if (server.status !== "connected") {
        const detail = server.error ? `：${server.error}` : "";
        rows.push({ label: server.name, value: `${MCP_STATUS_LABEL[server.status]}${detail}` });
      }
    }
    return { title: "MCP", rows };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { title: "MCP", rows: [{ label: "状态", value: `读取失败：${message}` }] };
  }
}

/** 限流窗口时长（分钟）→ 「5 小时」「每周」等 */
export function formatWindowLabel(minutes: number | null | undefined): string {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return "用量";
  if (minutes === 10080) return "每周";
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

/** 重置时间（epoch 秒；兼容毫秒）→ 「约 2 小时 15 分钟后重置」 */
export function formatResetsIn(resetsAt: number | null | undefined, now = Date.now()): string | undefined {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) return undefined;
  const resetMs = resetsAt > 1e12 ? resetsAt : resetsAt * 1000;
  const minutes = Math.max(0, Math.round((resetMs - now) / 60_000));
  if (minutes < 1) return "即将重置";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const parts = [days ? `${days} 天` : "", hours ? `${hours} 小时` : "", days === 0 && mins ? `${mins} 分钟` : ""];
  return `约 ${parts.filter(Boolean).join(" ")}后重置`;
}
