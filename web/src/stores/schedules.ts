import { atom } from "jotai";
import type { Schedule } from "@agentdeck/protocol";

/** sidecar 调度器状态（来自 schedule.list 与 schedule.changed 通知，design.md 4.25）。 */
export interface SchedulesState {
  schedules: Schedule[];
  /** 全局暂停 */
  paused: boolean;
  /** 是否已拉到过一次完整列表 */
  loaded: boolean;
  /** 每收到一次 schedule.changed 加一，运行记录据此重新拉取 */
  revision: number;
}

export const schedulesStateAtom = atom<SchedulesState>({
  schedules: [],
  paused: false,
  loaded: false,
  revision: 0,
});

export const replaceSchedulesAtom = atom(
  null,
  (_get, set, value: { schedules: Schedule[]; paused: boolean }) => {
    set(schedulesStateAtom, (state) => ({
      schedules: value.schedules,
      paused: value.paused,
      loaded: true,
      revision: state.revision + 1,
    }));
  },
);

/** 新建 / 编辑弹窗的请求：kind 决定初始表单类型，schedule 存在即编辑，agentId 预选会话（右键菜单入口）。 */
export interface ScheduleDialogRequest {
  kind: "cron" | "heartbeat" | "goal";
  schedule?: Schedule;
  agentId?: string;
  /** 锁定类型（从会话入口打开时不允许切换类型） */
  lockKind?: boolean;
}

/** 全局弹窗：自动化页、会话右键菜单共用，由 ScheduleDialogHost 渲染。 */
export const scheduleDialogAtom = atom<ScheduleDialogRequest | null>(null);

/** 会话详情页用：某个会话上的心跳 / 目标循环 */
export function schedulesForAgent(schedules: Schedule[], agentId: string | null | undefined): Schedule[] {
  if (!agentId) return [];
  return schedules.filter(
    (schedule) => (schedule.kind === "heartbeat" || schedule.kind === "goal") && schedule.agentId === agentId,
  );
}
