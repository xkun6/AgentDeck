// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Provider as JotaiProvider, createStore } from "jotai";
import type { AgentSnapshot, Schedule, ScheduleDraft, ScheduleRun } from "@agentdeck/protocol";
import { agentSnapshotsAtom, sidecarConnectionAtom } from "@/stores/agents";
import { replaceSchedulesAtom, scheduleDialogAtom } from "@/stores/schedules";
import { ConfirmProvider } from "@/lib/use-confirm";

const actions = {
  listSchedules: vi.fn(),
  upsertSchedule: vi.fn<(draft: ScheduleDraft) => Promise<unknown>>(),
  deleteSchedule: vi.fn<(id: string) => Promise<void>>(),
  runScheduleNow: vi.fn<(id: string) => Promise<void>>(),
  listScheduleRuns: vi.fn<(id?: string, limit?: number) => Promise<ScheduleRun[]>>(),
  setSchedulesPaused: vi.fn<(paused: boolean) => Promise<boolean>>(),
};
vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => actions,
  humanizeSidecarError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock("@/hooks/use-agent-catalog", () => ({
  useAgentProviders: () => ({ data: [{ id: "claude", kind: "claude", label: "Claude Code", available: true }] }),
}));

import { AutomationRoute } from "./automation";

afterEach(() => {
  cleanup();
  for (const fn of Object.values(actions)) fn.mockReset();
});

const agent: AgentSnapshot = {
  id: "a1", provider: "claude", cwd: "/work", title: "我的会话", status: "idle", pendingPermissions: [],
  lastSeq: 0, resumable: true, createdAt: 1, updatedAt: 1,
};

const schedules: Schedule[] = [
  {
    id: "c1", name: "每日巡检", enabled: true, createdAt: 1, updatedAt: 1, kind: "cron",
    trigger: { cron: "0 9 * * *" }, target: { type: "agent", agentId: "a1" }, prompt: "巡检", onBusy: "skip",
  },
  {
    id: "h1", name: "保活心跳", enabled: false, createdAt: 1, updatedAt: 1, kind: "heartbeat",
    agentId: "a1", idleMinutes: 30, prompt: "在吗", runs: 0,
  },
  {
    id: "g1", name: "修测试", enabled: true, createdAt: 1, updatedAt: 1, kind: "goal", agentId: "a1",
    goal: "让测试通过", doneMarker: "GOAL_DONE", maxIterations: 10, iterations: 3, stopOnFailure: true, state: "running",
  },
];

function renderPage(options: { paused?: boolean } = {}) {
  actions.listScheduleRuns.mockResolvedValue([
    { scheduleId: "c1", ts: new Date(2026, 0, 5, 9, 0).getTime(), outcome: "sent" },
    { scheduleId: "c1", ts: new Date(2026, 0, 4, 9, 0).getTime(), outcome: "failed", message: "目标会话已删除" },
  ]);
  const store = createStore();
  store.set(sidecarConnectionAtom, "open");
  store.set(agentSnapshotsAtom, { a1: agent });
  store.set(replaceSchedulesAtom, { schedules, paused: options.paused ?? false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <JotaiProvider store={store}>
        <ConfirmProvider>
          <MemoryRouter>
            <AutomationRoute />
          </MemoryRouter>
        </ConfirmProvider>
      </JotaiProvider>
    </QueryClientProvider>,
  );
  return store;
}

describe("AutomationRoute", () => {
  it("按类型分组渲染任务：名称、目标与计划 / 状态", async () => {
    renderPage();
    const cronGroup = screen.getByRole("region", { name: "定时任务" });
    expect(within(cronGroup).getByText("每日巡检")).toBeTruthy();
    expect(within(cronGroup).getByText(/会话「我的会话」/)).toBeTruthy();
    expect(within(cronGroup).getByText(/^下次 /)).toBeTruthy();
    const heartbeatGroup = screen.getByRole("region", { name: "心跳" });
    expect(within(heartbeatGroup).getByText("保活心跳")).toBeTruthy();
    expect(within(heartbeatGroup).getByText("已停用")).toBeTruthy();
    const goalGroup = screen.getByRole("region", { name: "目标循环" });
    expect(within(goalGroup).getByText("进行中（3/10）")).toBeTruthy();
    // 运行记录
    expect(await screen.findByText("已发送")).toBeTruthy();
    expect(screen.getByText("目标会话已删除")).toBeTruthy();
  });

  it("启用开关：停用 cron 与继续 / 停止目标循环都走 upsert", async () => {
    actions.upsertSchedule.mockResolvedValue({});
    renderPage();
    fireEvent.click(screen.getByRole("switch", { name: "停用：每日巡检" }));
    await waitFor(() => expect(actions.upsertSchedule).toHaveBeenCalledTimes(1));
    expect(actions.upsertSchedule.mock.calls[0]![0]).toMatchObject({ id: "c1", enabled: false });

    fireEvent.click(screen.getByRole("switch", { name: "停用：修测试" }));
    await waitFor(() => expect(actions.upsertSchedule).toHaveBeenCalledTimes(2));
    expect(actions.upsertSchedule.mock.calls[1]![0]).toMatchObject({ id: "g1", enabled: false, state: "stopped" });

    fireEvent.click(screen.getByRole("switch", { name: "启用：保活心跳" }));
    await waitFor(() => expect(actions.upsertSchedule).toHaveBeenCalledTimes(3));
    expect(actions.upsertSchedule.mock.calls[2]![0]).toMatchObject({ id: "h1", enabled: true });
  });

  it("立即运行；运行中的目标循环不显示「继续」按钮", async () => {
    actions.runScheduleNow.mockResolvedValue();
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "立即运行：每日巡检" }));
    await waitFor(() => expect(actions.runScheduleNow).toHaveBeenCalledWith("c1"));
    expect(screen.queryByRole("button", { name: /继续：修测试/ })).toBeNull();
  });

  it("删除需要确认", async () => {
    actions.deleteSchedule.mockResolvedValue();
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "删除：每日巡检" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    await waitFor(() => expect(actions.deleteSchedule).toHaveBeenCalledWith("c1"));
  });

  it("编辑 / 新建通过全局弹窗 atom 打开", () => {
    const store = renderPage();
    fireEvent.click(screen.getByRole("button", { name: "编辑：保活心跳" }));
    expect(store.get(scheduleDialogAtom)).toMatchObject({ kind: "heartbeat", schedule: { id: "h1" } });
    fireEvent.click(screen.getByRole("button", { name: "新建目标循环" }));
    expect(store.get(scheduleDialogAtom)).toEqual({ kind: "goal" });
  });

  it("全部暂停开关调用 schedule.setPaused；暂停时显示提示", async () => {
    actions.setSchedulesPaused.mockResolvedValue(true);
    renderPage();
    fireEvent.click(screen.getByRole("switch", { name: "全部暂停" }));
    await waitFor(() => expect(actions.setSchedulesPaused).toHaveBeenCalledWith(true));
    cleanup();
    renderPage({ paused: true });
    expect(screen.getByText(/已全局暂停/)).toBeTruthy();
    expect(screen.getByRole("switch", { name: "全部暂停" }).getAttribute("aria-checked")).toBe("true");
  });
});
