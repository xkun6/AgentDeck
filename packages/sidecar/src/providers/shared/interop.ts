// 会话互通 MCP 端点注入（design.md 4.26）与 Computer Use 代理端点注入（4.37）：三类 provider 各自的注入形态。
import type { InteropEndpoint } from "../../agent/types.js";

/** 注入到各 CLI 的 MCP 服务器名；工具名由 CLI 加前缀，如 `mcp__agentdeck__delegate` */
export const INTEROP_SERVER_NAME = "agentdeck";

/** Computer Use 代理的 MCP 服务器名（design.md 4.37）：Claude `mcp__agentdeck_cua__<tool>`，Codex `agentdeck_cua.<tool>` */
export const COMPUTER_USE_SERVER_NAME = "agentdeck_cua";

/** Claude 侧 Computer Use 工具名前缀 */
export const CLAUDE_COMPUTER_USE_TOOL_PREFIX = `mcp__${COMPUTER_USE_SERVER_NAME}__`;

/** 审批策略为「拒绝」时回给模型的理由（代理与 Claude CLI 审批共用） */
export const COMPUTER_USE_POLICY_DENIED = "Computer Use 已设为拒绝所有调用（设置 → Computer Use → 工具审批策略）";

/** Claude：`--mcp-config <内联 JSON>`（type http + Authorization 头）；两个端点合在同一份 JSON 里 */
export function claudeInteropArgs(
  endpoint: InteropEndpoint | undefined,
  computerUse?: InteropEndpoint,
): string[] {
  const servers: Record<string, unknown> = {};
  for (const [name, target] of [
    [INTEROP_SERVER_NAME, endpoint],
    [COMPUTER_USE_SERVER_NAME, computerUse],
  ] as const) {
    if (target) {
      servers[name] = {
        type: "http",
        url: target.url,
        headers: { Authorization: `Bearer ${target.token}` },
      };
    }
  }
  return Object.keys(servers).length > 0 ? ["--mcp-config", JSON.stringify({ mcpServers: servers })] : [];
}

/**
 * Codex：thread/start / resume / fork 的 `config.mcp_servers.agentdeck`。
 * - 主机写 `localhost`：Windows 上 codex 的 HTTP 客户端会让 127.0.0.1 字面量走系统代理（实测 502），localhost 则直连；
 * - `tool_timeout_sec` 放宽到与 delegate 的最大等待相当（codex 默认 60 秒，会打断 wait）；
 * - `fullAccess`（approvalPolicy 为 never）时 codex 会直接拒绝需要审批的 MCP 工具调用，
 *   所以仅在该模式下 `default_tools_approval_mode: "approve"`；其它模式沿用 codex 自身的审批流程。
 * Computer Use（`mcp_servers.agentdeck_cua`）在所有模式都 `approve`：审批由 sidecar 代理统一发起（design.md 4.37），
 * 超时同样放宽（等待用户审批也计入工具调用时间）。
 */
export function codexInteropConfig(
  endpoint: InteropEndpoint | undefined,
  options: { fullAccess: boolean; computerUse?: InteropEndpoint },
): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  if (endpoint) {
    servers[INTEROP_SERVER_NAME] = {
      url: endpoint.url.replace("//127.0.0.1:", "//localhost:"),
      http_headers: { Authorization: `Bearer ${endpoint.token}` },
      tool_timeout_sec: 3700,
      ...(options.fullAccess ? { default_tools_approval_mode: "approve" } : {}),
    };
  }
  if (options.computerUse) {
    servers[COMPUTER_USE_SERVER_NAME] = {
      url: options.computerUse.url.replace("//127.0.0.1:", "//localhost:"),
      http_headers: { Authorization: `Bearer ${options.computerUse.token}` },
      tool_timeout_sec: 3700,
      default_tools_approval_mode: "approve",
    };
  }
  return { mcp_servers: servers };
}

/** ACP：agent 在 initialize 应答中声明 `mcpCapabilities.http` 时才注入；否则返回空数组 */
export function acpInteropServers(
  endpoint: InteropEndpoint | undefined,
  capabilities: { mcpCapabilities?: { http?: boolean } | null } | null | undefined,
): Array<{ type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> }> {
  if (!endpoint || capabilities?.mcpCapabilities?.http !== true) {
    return [];
  }
  return [
    {
      type: "http",
      name: INTEROP_SERVER_NAME,
      url: endpoint.url,
      headers: [{ name: "Authorization", value: `Bearer ${endpoint.token}` }],
    },
  ];
}
