// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentPermissionRequest } from "@agentdeck/protocol";
import type { PendingApproval } from "@/stores/chat";
import { ApprovalDialog } from "./approval-dialog";

afterEach(() => cleanup());

function approval(permission?: AgentPermissionRequest, command = "echo hi"): PendingApproval {
  return { requestId: permission?.id ?? "p1", sessionId: "agent-1", command, permission };
}

describe("ApprovalDialog", () => {
  it("按 request.actions 渲染按钮并回传 behavior + selectedActionId", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const request: AgentPermissionRequest = {
      id: "p1",
      provider: "acp:dsh",
      name: "execute",
      kind: "tool",
      title: "执行命令",
      description: "Agent 想要运行一条命令",
      detail: { type: "shell", command: "npm test", cwd: "/repo" },
      actions: [
        { id: "allow_once", label: "允许一次", behavior: "allow" },
        { id: "allow_always", label: "总是允许", behavior: "allow" },
        { id: "reject_once", label: "拒绝", behavior: "deny" },
      ],
    };
    render(<ApprovalDialog approval={approval(request)} onRespond={onRespond} />);

    expect(screen.getByText("执行命令")).toBeTruthy();
    expect(screen.getByText("Agent 想要运行一条命令")).toBeTruthy();
    expect(screen.getByText("npm test")).toBeTruthy();
    expect(screen.getByText("工作目录：/repo")).toBeTruthy();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "允许一次",
      "总是允许",
      "拒绝",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "总是允许" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1));
    expect(onRespond.mock.calls[0]![1]).toEqual({ behavior: "allow", selectedActionId: "allow_always" });

    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(2));
    expect(onRespond.mock.calls[1]![1]).toEqual({ behavior: "deny", selectedActionId: "reject_once" });
  });

  it("没有 actions 时显示默认的 允许 / 拒绝", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalDialog approval={approval(undefined, "rm -rf dist")} onRespond={onRespond} />);

    expect(screen.getByText("需要确认执行")).toBeTruthy();
    expect(screen.getByText("rm -rf dist")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "允许" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledWith(expect.anything(), { behavior: "allow" }));
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(onRespond).toHaveBeenLastCalledWith(expect.anything(), { behavior: "deny" }));
  });

  it("编辑请求展示 diff，计划请求展示计划正文", () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const edit: AgentPermissionRequest = {
      id: "p2",
      provider: "claude",
      name: "Edit",
      kind: "tool",
      detail: { type: "edit", filePath: "src/a.ts", unifiedDiff: "--- a\n+++ b\n-old\n+new" },
      actions: [
        { id: "allow", label: "允许一次", behavior: "allow" },
        { id: "deny", label: "拒绝", behavior: "deny" },
      ],
    };
    const { unmount } = render(<ApprovalDialog approval={approval(edit)} onRespond={onRespond} />);
    expect(screen.getByText(/修改文件：src\/a\.ts/)).toBeTruthy();
    expect(screen.getByText(/\+1 −1 行/)).toBeTruthy();
    expect(screen.getByText((_, node) => node?.tagName === "PRE" && node.textContent?.includes("+new") === true)).toBeTruthy();
    unmount();

    const plan: AgentPermissionRequest = {
      id: "p3",
      provider: "claude",
      name: "ExitPlanMode",
      kind: "plan",
      detail: { type: "plan", text: "1. 读代码\n2. 改代码" },
      actions: [
        { id: "approve", label: "批准计划", behavior: "allow" },
        { id: "keep_planning", label: "继续规划", behavior: "deny" },
      ],
    };
    render(<ApprovalDialog approval={approval(plan)} onRespond={onRespond} />);
    expect(screen.getByText("需要批准计划")).toBeTruthy();
    expect(screen.getByText(/1\. 读代码/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "批准计划" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "继续规划" })).toBeTruthy();
  });

  it("发送失败时显示错误并恢复按钮", async () => {
    const onRespond = vi.fn().mockRejectedValue(new Error("该审批请求已失效"));
    render(<ApprovalDialog approval={approval(undefined)} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "允许" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("该审批请求已失效");
    expect((screen.getByRole("button", { name: "允许" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
