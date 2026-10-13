// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BoardSettings } from "@agentdeck/protocol";

const actions = { updateBoardSettings: vi.fn() };
vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => actions,
  humanizeSidecarError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock("@/hooks/use-agent-catalog", () => ({
  useAgentProviders: () => ({
    data: [{ id: "claude", kind: "claude", label: "Claude Code", available: true }],
  }),
  useAgentCatalog: () => ({ data: { models: [], modes: [] }, isLoading: false }),
}));

import { BoardSettingsDialog } from "./board-settings-dialog";

afterEach(() => {
  cleanup();
  actions.updateBoardSettings.mockReset();
});

const settings: BoardSettings = {
  worktreePerTask: true,
  autoDispatch: false,
  maxConcurrent: 2,
  defaultAssignee: { provider: "claude" },
};

function renderDialog(onClose = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <BoardSettingsDialog projectPath="/work/proj" settings={settings} onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

describe("BoardSettingsDialog", () => {
  it("显示当前设置，修改后保存并关闭", async () => {
    actions.updateBoardSettings.mockResolvedValue({});
    const onClose = renderDialog();
    expect((screen.getByRole("checkbox", { name: /独立 git worktree/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /自动派发/ }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("并发上限") as HTMLInputElement).value).toBe("2");

    fireEvent.click(screen.getByRole("checkbox", { name: /独立 git worktree/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /自动派发/ }));
    fireEvent.change(screen.getByLabelText("并发上限"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(actions.updateBoardSettings).toHaveBeenCalledWith("/work/proj", {
        worktreePerTask: false,
        autoDispatch: true,
        maxConcurrent: 4,
        defaultAssignee: { provider: "claude" },
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("并发上限非法时禁用保存并提示", () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("并发上限"), { target: { value: "0" } });
    expect(screen.getByText(/请输入 1–16 的整数/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("保存失败显示错误且不关闭", async () => {
    actions.updateBoardSettings.mockRejectedValue(new Error("连接已断开"));
    const onClose = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect((await screen.findByRole("alert")).textContent).toContain("连接已断开");
    expect(onClose).not.toHaveBeenCalled();
  });
});
