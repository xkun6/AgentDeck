// 会话互通 MCP 端点注入（design.md 4.26）：三类 provider 各自的注入形态。
import type { InteropEndpoint } from "../../agent/types.js";

/** 注入到各 CLI 的 MCP 服务器名；工具名由 CLI 加前缀，如 `mcp__agentdeck__delegate` */
export const INTEROP_SERVER_NAME = "agentdeck";

/** Claude：`--mcp-config <内联 JSON>`（type http + Authorization 头） */
export function claudeInteropArgs(endpoint: InteropEndpoint): string[] {
  return [
    "--mcp-config",
    JSON.stringify({
      mcpServers: {
        [INTEROP_SERVER_NAME]: {
          type: "http",
          url: endpoint.url,
          headers: { Authorization: `Bearer ${endpoint.token}` },
        },
      },
    }),
  ];
}

/**
 * Codex：thread/start / resume / fork 的 `config.mcp_servers.agentdeck`。
 * - 主机写 `localhost`：Windows 上 codex 的 HTTP 客户端会让 127.0.0.1 字面量走系统代理（实测 502），localhost 则直连；
 * - `tool_timeout_sec` 放宽到与 delegate 的最大等待相当（codex 默认 60 秒，会打断 wait）；
 * - `fullAccess`（approvalPolicy 为 never）时 codex 会直接拒绝需要审批的 MCP 工具调用，
 *   所以仅在该模式下 `default_tools_approval_mode: "approve"`；其它模式沿用 codex 自身的审批流程。
 */
export function codexInteropConfig(
  endpoint: InteropEndpoint,
  options: { fullAccess: boolean },
): Record<string, unknown> {
  return {
    mcp_servers: {
      [INTEROP_SERVER_NAME]: {
        url: endpoint.url.replace("//127.0.0.1:", "//localhost:"),
        http_headers: { Authorization: `Bearer ${endpoint.token}` },
        tool_timeout_sec: 3700,
        ...(options.fullAccess ? { default_tools_approval_mode: "approve" } : {}),
      },
    },
  };
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
