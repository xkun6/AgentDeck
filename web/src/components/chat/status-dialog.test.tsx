// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentStatusSection } from "@agentdeck/protocol";
import { stubRadixGlobals } from "@/test-utils/radix";

const status = vi.fn<(agentId: string) => Promise<AgentStatusSection[]>>();

vi.mock("@/hooks/use-agent-session", () => {
  const actions = { status: (...args: [string]) => status(...args) };
  return {
    useAgentSession: () => actions,
    humanizeSidecarError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  };
});

const { StatusDialog } = await import("./status-dialog");

stubRadixGlobals();
beforeEach(() => status.mockReset());
afterEach(() => cleanup());

const SECTIONS: AgentStatusSection[] = [
  {
    title: "会话",
    rows: [
      { label: "会话 ID", value: "sess-1" },
      { label: "工作目录", value: "J:\\work\\a-very-long-path" },
    ],
  },
  { title: "MCP", rows: [{ label: "概览", value: "2 个服务器：2 已连接" }] },
];

describe("StatusDialog", () => {
  it("打开即加载，按分组渲染标签与值", async () => {
    status.mockResolvedValue(SECTIONS);
    render(<StatusDialog open agentId="a1" onClose={() => {}} />);
    expect(status).toHaveBeenCalledWith("a1");
    await screen.findByText("sess-1");
    expect(screen.getByRole("heading", { name: "会话" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "MCP" })).toBeTruthy();
    expect(screen.getByText("会话 ID")).toBeTruthy();
    expect(screen.getByText("J:\\work\\a-very-long-path")).toBeTruthy();
    expect(screen.getByText("2 个服务器：2 已连接")).toBeTruthy();
  });

  it("点「刷新」重新拉取并更新内容", async () => {
    status.mockResolvedValueOnce(SECTIONS);
    render(<StatusDialog open agentId="a1" onClose={() => {}} />);
    await screen.findByText("sess-1");
    status.mockResolvedValueOnce([{ title: "会话", rows: [{ label: "会话 ID", value: "sess-2" }] }]);
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByText("sess-2");
    expect(status).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("sess-1")).toBeNull();
  });

  it("加载错误显示在告警里，刷新可重试", async () => {
    status.mockRejectedValueOnce(new Error("该 Agent 不支持查看状态"));
    render(<StatusDialog open agentId="a1" onClose={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toBe("该 Agent 不支持查看状态");
    status.mockResolvedValueOnce(SECTIONS);
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByText("sess-1");
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("未打开时不请求", () => {
    render(<StatusDialog open={false} agentId="a1" onClose={() => {}} />);
    expect(status).not.toHaveBeenCalled();
  });
});
