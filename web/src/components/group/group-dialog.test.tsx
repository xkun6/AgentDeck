// @vitest-environment jsdom
// 「并行协作」新建弹窗（design.md 4.27）：成员数限制、worktree 可用性、提交入参。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { GroupCreateParams } from "@agentdeck/protocol";
import { stubRadixGlobals } from "@/test-utils/radix";

stubRadixGlobals();

const createGroup = vi.fn<(params: GroupCreateParams) => Promise<{ id: string }>>();
vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => ({ createGroup }),
  humanizeSidecarError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock("@/hooks/use-agent-catalog", () => ({
  useAgentProviders: () => ({
    data: [{ id: "claude", kind: "claude", label: "Claude Code", available: true }],
  }),
  useAgentCatalog: () => ({ data: { models: [], modes: [] }, isLoading: false }),
}));
vi.mock("@/hooks/use-provider-config", () => ({ useProviderConfig: () => ({ data: undefined }) }));
let isRepo = true;
vi.mock("@/hooks/use-worktrees", () => ({
  useWorktrees: () => ({ isRepo, loading: false }),
}));
vi.mock("@/components/composer/agent-session-picker", () => ({
  AgentSessionPicker: ({ selection }: { selection: { provider: string | null } }) => (
    <span data-testid="picker">{selection.provider ?? "未选"}</span>
  ),
}));
vi.mock("@/components/composer/workspace-picker", () => ({ WorkspacePickerModal: () => null }));
vi.mock("@/lib/workspaces", () => ({
  readWorkspacePath: () => "C:/work/repo",
  writeWorkspacePath: vi.fn(),
  rememberWorkspaceProject: vi.fn(),
}));

import { GroupDialog } from "./group-dialog";

function renderDialog() {
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <GroupDialog open onClose={onClose} />
    </MemoryRouter>,
  );
  return onClose;
}

beforeEach(() => {
  isRepo = true;
  createGroup.mockResolvedValue({ id: "g1" });
});

afterEach(() => {
  cleanup();
  createGroup.mockReset();
});

describe("GroupDialog", () => {
  it("默认 2 个成员且不能再少；最多 6 个，满了后不能再添加", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getAllByTestId("picker").map((node) => node.textContent)).toEqual(["claude", "claude"]));
    expect((screen.getByRole("button", { name: "移除成员 1" }) as HTMLButtonElement).disabled).toBe(true);
    for (let count = 2; count < 6; count += 1) {
      fireEvent.click(screen.getByRole("button", { name: /添加成员/ }));
    }
    expect(screen.getAllByTestId("picker")).toHaveLength(6);
    expect((screen.getByRole("button", { name: /添加成员/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "移除成员 6" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("工作目录不是 git 仓库时禁用独立 worktree 并提示", () => {
    isRepo = false;
    renderDialog();
    const checkbox = screen.getByRole("checkbox", { name: /独立 git worktree/ }) as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    expect(screen.getByText(/不是 git 仓库/)).toBeTruthy();
  });

  it("任务为空时提示且不提交", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "开始并行" }));
    expect(await screen.findByText("请输入要并行执行的任务")).toBeTruthy();
    expect(createGroup).not.toHaveBeenCalled();
  });

  it("按表单提交 group.create 入参（per-member worktree + 评审汇总），成功后关闭", async () => {
    const onClose = renderDialog();
    await waitFor(() => expect(screen.getAllByTestId("picker")).toHaveLength(2));
    fireEvent.change(screen.getByLabelText("任务"), { target: { value: "实现排序" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /独立 git worktree/ }));
    fireEvent.change(screen.getByLabelText("汇总方式"), { target: { value: "review" } });
    fireEvent.click(screen.getByRole("button", { name: "开始并行" }));
    await waitFor(() => expect(createGroup).toHaveBeenCalledTimes(1));
    expect(createGroup).toHaveBeenCalledWith({
      prompt: "实现排序",
      cwd: "C:/work/repo",
      members: [{ provider: "claude" }, { provider: "claude" }],
      worktree: "per-member",
      chair: { provider: "claude", mode: "review" },
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("创建失败时显示错误并保持打开", async () => {
    createGroup.mockRejectedValue(new Error("工作目录不在 git 仓库内"));
    const onClose = renderDialog();
    fireEvent.change(screen.getByLabelText("任务"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "开始并行" }));
    expect((await screen.findByRole("alert")).textContent).toContain("工作目录不在 git 仓库内");
    expect(onClose).not.toHaveBeenCalled();
  });
});
