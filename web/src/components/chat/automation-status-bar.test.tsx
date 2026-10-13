// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider as JotaiProvider, createStore } from "jotai";
import type { GoalSchedule, HeartbeatSchedule, ScheduleDraft } from "@agentdeck/protocol";
import { replaceSchedulesAtom } from "@/stores/schedules";

const upsertSchedule = vi.fn<(draft: ScheduleDraft) => Promise<unknown>>();
vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => ({ upsertSchedule }),
  humanizeSidecarError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { AutomationStatusBar } from "./automation-status-bar";

afterEach(() => {
  cleanup();
  upsertSchedule.mockReset();
});

const goal: GoalSchedule = {
  id: "g1", name: "目标", enabled: true, createdAt: 1, updatedAt: 1, kind: "goal", agentId: "a1",
  goal: "修测试", doneMarker: "GOAL_DONE", maxIterations: 10, iterations: 3, stopOnFailure: true, state: "running",
};
const heartbeat: HeartbeatSchedule = {
  id: "h1", name: "心跳", enabled: true, createdAt: 1, updatedAt: 1, kind: "heartbeat", agentId: "a1",
  idleMinutes: 30, prompt: "在吗", runs: 0,
};

function renderBar(schedules: Array<GoalSchedule | HeartbeatSchedule>, agentId = "a1") {
  const store = createStore();
  store.set(replaceSchedulesAtom, { schedules, paused: false });
  return render(
    <JotaiProvider store={store}>
      <AutomationStatusBar agentId={agentId} />
    </JotaiProvider>,
  );
}

describe("AutomationStatusBar", () => {
  it("没有心跳 / 目标循环时不渲染", () => {
    const { container } = renderBar([goal], "other");
    expect(container.firstChild).toBeNull();
  });

  it("显示目标循环进度与心跳状态", () => {
    renderBar([goal, heartbeat]);
    expect(screen.getByText("目标循环 3/10")).toBeTruthy();
    expect(screen.getByText("心跳：空闲 30 分钟后发送")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "停止" })).toHaveLength(2);
  });

  it("点击「停止」把目标循环置为 stopped", async () => {
    upsertSchedule.mockResolvedValue({});
    renderBar([goal]);
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(upsertSchedule).toHaveBeenCalledTimes(1));
    expect(upsertSchedule.mock.calls[0]![0]).toMatchObject({ id: "g1", enabled: false, state: "stopped" });
  });

  it("已暂停的目标显示「继续」，点击后恢复运行；失败时显示错误", async () => {
    upsertSchedule.mockRejectedValue(new Error("会话正在运行"));
    renderBar([{ ...goal, state: "stopped", enabled: false }]);
    expect(screen.getByText("目标循环已暂停 3/10")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => expect(upsertSchedule).toHaveBeenCalled());
    expect(upsertSchedule.mock.calls[0]![0]).toMatchObject({ enabled: true, state: "running" });
    expect(await screen.findByText("会话正在运行")).toBeTruthy();
  });
});
