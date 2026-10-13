// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Provider as JotaiProvider, createStore } from "jotai";
import type { AgentSnapshot, ScheduleDraft } from "@agentdeck/protocol";
import { agentSnapshotsAtom } from "@/stores/agents";

const upsertSchedule = vi.fn<(draft: ScheduleDraft) => Promise<unknown>>();
vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => ({ upsertSchedule }),
  humanizeSidecarError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock("@/hooks/use-agent-catalog", () => ({
  useAgentProviders: () => ({
    data: [{ id: "claude", kind: "claude", label: "Claude Code", available: true }],
  }),
}));

import { ScheduleDialog } from "./schedule-dialog";

afterEach(() => {
  cleanup();
  upsertSchedule.mockReset();
});

const agent: AgentSnapshot = {
  id: "a1", provider: "claude", cwd: "/work", title: "我的会话", status: "idle", pendingPermissions: [],
  lastSeq: 0, resumable: true, createdAt: 1, updatedAt: 1,
};

function renderDialog(request: Parameters<typeof ScheduleDialog>[0]["request"], onClose = vi.fn()) {
  const store = createStore();
  store.set(agentSnapshotsAtom, { a1: agent, j1: { ...agent, id: "j1", title: "评判会话", origin: "judge" } });
  render(
    <JotaiProvider store={store}>
      <ScheduleDialog request={request} onClose={onClose} />
    </JotaiProvider>,
  );
  return { onClose };
}

describe("ScheduleDialog", () => {
  it("定时任务：非法 cron 与空字段给出校验错误，不提交", async () => {
    renderDialog({ kind: "cron" });
    fireEvent.change(screen.getByLabelText("cron 表达式"), { target: { value: "not-a-cron" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(await screen.findByText(/cron 表达式非法/)).toBeTruthy();
    expect(screen.getByText("请填写名称")).toBeTruthy();
    expect(screen.getByText("请选择目标会话")).toBeTruthy();
    expect(screen.getByText("请填写要发送的提示")).toBeTruthy();
    expect(upsertSchedule).not.toHaveBeenCalled();
  });

  it("点击预设填入 cron，并显示未来 5 次触发预览", () => {
    renderDialog({ kind: "cron" });
    fireEvent.click(screen.getByRole("button", { name: "每 5 分钟" }));
    expect((screen.getByLabelText("cron 表达式") as HTMLInputElement).value).toBe("*/5 * * * *");
    const preview = screen.getByLabelText("未来触发时间");
    expect(within(preview).getAllByRole("listitem")).toHaveLength(6); // 标题 + 5 次
    // 评判会话不出现在会话选项里
    const select = screen.getByLabelText("会话") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.text)).toEqual(["请选择会话", "我的会话"]);
  });

  it("填写完整后提交：构造 cron + 现有会话草稿并关闭", async () => {
    upsertSchedule.mockResolvedValue({});
    const { onClose } = renderDialog({ kind: "cron" });
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "每日巡检" } });
    fireEvent.change(screen.getByLabelText("会话"), { target: { value: "a1" } });
    fireEvent.change(screen.getByLabelText("发送的提示"), { target: { value: "巡检一下" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(upsertSchedule).toHaveBeenCalledTimes(1));
    expect(upsertSchedule.mock.calls[0]![0]).toEqual({
      name: "每日巡检", enabled: true, kind: "cron", trigger: { cron: "0 9 * * *" },
      target: { type: "agent", agentId: "a1" }, prompt: "巡检一下", onBusy: "skip",
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("切换为「每次新建会话」后出现新建配置字段", () => {
    renderDialog({ kind: "cron" });
    fireEvent.change(screen.getByLabelText("目标类型"), { target: { value: "new" } });
    expect(screen.getByLabelText("工作目录")).toBeTruthy();
    expect(screen.getByLabelText("Agent")).toBeTruthy();
    expect(screen.queryByLabelText("忙时处理")).toBeNull();
  });

  it("目标循环（从会话入口，预选会话并锁定类型）：提交带默认完成标记", async () => {
    upsertSchedule.mockResolvedValue({});
    renderDialog({ kind: "goal", agentId: "a1", lockKind: true });
    expect((screen.getByLabelText("会话") as HTMLSelectElement).value).toBe("a1");
    expect((screen.getByRole("tab", { name: "定时任务" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "修测试" } });
    fireEvent.change(screen.getByLabelText("目标"), { target: { value: "让所有测试通过" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并开始" }));
    await waitFor(() => expect(upsertSchedule).toHaveBeenCalled());
    expect(upsertSchedule.mock.calls[0]![0]).toMatchObject({
      kind: "goal", agentId: "a1", goal: "让所有测试通过", doneMarker: "GOAL_DONE", maxIterations: 10, stopOnFailure: true,
    });
  });

  it("sidecar 报错时在弹窗底部显示，不关闭", async () => {
    upsertSchedule.mockRejectedValue(new Error("会话不存在"));
    const { onClose } = renderDialog({ kind: "heartbeat", agentId: "a1" });
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "hb" } });
    fireEvent.change(screen.getByLabelText("发送的提示"), { target: { value: "在吗" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("会话不存在")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
