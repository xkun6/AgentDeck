// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentMcpStatusResult } from "@agentdeck/protocol";
import { stubRadixGlobals } from "@/test-utils/radix";

const mcpStatus = vi.fn<(agentId: string) => Promise<AgentMcpStatusResult>>();
const mcpReconnect = vi.fn<(agentId: string, serverName?: string) => Promise<AgentMcpStatusResult>>();

vi.mock("@/hooks/use-agent-session", () => {
  const actions = { mcpStatus: (...args: [string]) => mcpStatus(...args), mcpReconnect: (...args: [string, string?]) => mcpReconnect(...args) };
  return {
    useAgentSession: () => actions,
    humanizeSidecarError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  };
});

const { McpServersDialog, sortMcpServers } = await import("./mcp-servers-dialog");

stubRadixGlobals();
beforeEach(() => {
  mcpStatus.mockReset();
  mcpReconnect.mockReset();
});
afterEach(() => cleanup());

const SERVER_RESULT: AgentMcpStatusResult = {
  reconnect: "server",
  servers: [
    { name: "zeta", status: "connected", toolCount: 3, scope: "user" },
    { name: "alpha", status: "connected", toolCount: 1 },
    { name: "off", status: "disabled" },
    { name: "broken", status: "failed", error: "spawn ENOENT" },
    { name: "oauth", status: "needs-auth" },
    { name: "boot", status: "pending" },
  ],
};

function rowNames(): string[] {
  return Array.from(document.querySelectorAll("li")).map((row) => row.querySelector("span")?.textContent ?? "");
}

describe("sortMcpServers", () => {
  it("按 failed → needs-auth → pending → connected → disabled，再按名称排序", () => {
    expect(sortMcpServers(SERVER_RESULT.servers).map((server) => server.name)).toEqual([
      "broken",
      "oauth",
      "boot",
      "alpha",
      "zeta",
      "off",
    ]);
  });
});

describe("McpServersDialog", () => {
  it("打开即加载并渲染状态、工具数、scope 与错误", async () => {
    mcpStatus.mockResolvedValue(SERVER_RESULT);
    render(<McpServersDialog open agentId="a1" onClose={() => {}} />);
    expect(mcpStatus).toHaveBeenCalledWith("a1");
    await screen.findByText("broken");
    expect(rowNames()).toEqual(["broken", "oauth", "boot", "alpha", "zeta", "off"]);
    expect(screen.getByText("连接失败")).toBeTruthy();
    expect(screen.getByText("需要认证")).toBeTruthy();
    expect(screen.getByText("连接中")).toBeTruthy();
    expect(screen.getAllByText("已连接")).toHaveLength(2);
    expect(screen.getByText("已禁用")).toBeTruthy();
    expect(screen.getByText("3 个工具")).toBeTruthy();
    expect(screen.getByText("user")).toBeTruthy();
    expect(screen.getByText("spawn ENOENT")).toBeTruthy();
    // disabled 之外每行都有「重连」
    expect(screen.getAllByRole("button", { name: /^重连 / })).toHaveLength(5);
    expect(screen.queryByRole("button", { name: "重连 off" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重新加载 MCP" })).toBeNull();
  });

  it("server 模式：点「重连」带 serverName 调用，并用返回结果刷新列表", async () => {
    mcpStatus.mockResolvedValue(SERVER_RESULT);
    let resolveReconnect: (value: AgentMcpStatusResult) => void = () => {};
    mcpReconnect.mockReturnValue(new Promise((resolve) => { resolveReconnect = resolve; }));
    render(<McpServersDialog open agentId="a1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "重连 broken" }));
    expect(mcpReconnect).toHaveBeenCalledWith("a1", "broken");
    const pending = screen.getByRole("button", { name: "正在重连 broken" }) as HTMLButtonElement;
    expect(pending.textContent).toBe("重连中…");
    expect(pending.disabled).toBe(true);

    resolveReconnect({ reconnect: "server", servers: [{ name: "broken", status: "connected", toolCount: 7 }] });
    await screen.findByText("7 个工具");
    expect(rowNames()).toEqual(["broken"]);
    expect(screen.getByText("已连接")).toBeTruthy();
  });

  it("server 模式：重连失败时在该行显示错误", async () => {
    mcpStatus.mockResolvedValue(SERVER_RESULT);
    mcpReconnect.mockRejectedValue(new Error("重连超时"));
    render(<McpServersDialog open agentId="a1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "重连 oauth" }));
    expect((await screen.findByRole("alert")).textContent).toBe("重连超时");
    expect(screen.getByRole("button", { name: "重连 oauth" })).toBeTruthy();
  });

  it("all 模式：显示「重新加载 MCP」与说明，点击不带 serverName", async () => {
    mcpStatus.mockResolvedValue({ reconnect: "all", servers: [{ name: "docs", status: "failed" }] });
    mcpReconnect.mockResolvedValue({ reconnect: "all", servers: [{ name: "docs", status: "connected" }] });
    render(<McpServersDialog open agentId="a1" onClose={() => {}} />);
    const reload = await screen.findByRole("button", { name: "重新加载 MCP" });
    expect(screen.getByText("Codex 会重新读取 MCP 配置，并在下一轮对话时重新连接")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^重连 / })).toBeNull();
    fireEvent.click(reload);
    expect(mcpReconnect).toHaveBeenCalledWith("a1");
    await screen.findByText("已连接");
  });

  it("空列表与加载错误", async () => {
    mcpStatus.mockResolvedValueOnce({ reconnect: "server", servers: [] });
    render(<McpServersDialog open agentId="a1" onClose={() => {}} />);
    await screen.findByText("未配置 MCP 服务器");

    mcpStatus.mockRejectedValueOnce(new Error("该 Agent 不支持此操作"));
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect((await screen.findByRole("alert")).textContent).toBe("该 Agent 不支持此操作");
    await waitFor(() => expect(mcpStatus).toHaveBeenCalledTimes(2));
  });
});
