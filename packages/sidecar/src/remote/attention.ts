// 判定思路参照 paseo packages/server/src/server/agent-attention-policy.ts（Apache-2.0）；是否提醒由手机端设置决定
import { randomUUID } from "node:crypto";

import type {
  AgentPermissionRequest,
  AgentSnapshot,
  AgentStreamEnvelope,
  AttentionNotice,
  ScheduleNotice,
} from "@agentdeck/protocol";

import type { AgentManager } from "../agent/agent-manager.js";
import type { Scheduler } from "../scheduler/scheduler.js";

export const ATTENTION_BODY_MAX_CHARS = 120;
const TITLE_MAX_CHARS = 60;
const FALLBACK_TITLE = "未命名会话";

/** 压成单行并截断到 max 个字符（按码点，不拆代理对） */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
}

function agentTitle(snapshot: AgentSnapshot | undefined): string {
  return clip(snapshot?.title?.trim() || snapshot?.preview?.trim() || FALLBACK_TITLE, TITLE_MAX_CHARS);
}

function permissionBody(request: AgentPermissionRequest): string {
  switch (request.kind) {
    case "question":
      return "Agent 提出了问题，等待你的回答";
    case "plan":
      return "Agent 提交了计划，等待你确认";
    case "mode":
      return "Agent 请求切换模式，等待你确认";
    default:
      // 只引用请求标题 / 工具名，不带输入与命令原文
      return `Agent 请求审批：${request.title?.trim() || request.name}`;
  }
}

export interface AttentionServiceOptions {
  manager: Pick<AgentManager, "subscribe" | "getAgent">;
  scheduler?: Pick<Scheduler, "subscribe">;
  /** 向全部已认证的远程客户端发送，返回送达数 */
  sendToRemote: (notice: AttentionNotice) => number;
  now?: () => number;
}

/**
 * client.attention 判定（design.md 4.31）：主时间线 `turn_completed` / `turn_failed`
 * （CLI 自发轮次与 judge 会话除外）、`permission_requested`、`schedule.notice`；
 * 另在 `permission_resolved` 时发撤回信号（kind "resolved"）。
 * 一律发给所有已认证的远程连接，不判断用户是否在电脑前；是否提醒由手机端设置决定。
 */
export class AttentionService {
  private readonly now: () => number;
  /** 每个会话里的 CLI 自发轮次 id（turn_started.origin 为 background），回合结束时清理 */
  private readonly backgroundTurns = new Map<string, Set<string>>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(private readonly options: AttentionServiceOptions) {
    this.now = options.now ?? Date.now;
    this.unsubscribers.push(
      options.manager.subscribe({
        onStream: (envelope) => this.handleStream(envelope),
        onRemoved: (agentId) => {
          this.backgroundTurns.delete(agentId);
        },
      }),
    );
    const unsubscribeScheduler = options.scheduler?.subscribe({
      onNotice: (notice) => this.handleScheduleNotice(notice),
    });
    if (unsubscribeScheduler) {
      this.unsubscribers.push(unsubscribeScheduler);
    }
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }
  }

  private handleStream(envelope: AgentStreamEnvelope): void {
    const event = envelope.event;
    switch (event.type) {
      case "turn_started":
        if (event.origin === "background") {
          let turns = this.backgroundTurns.get(envelope.agentId);
          if (!turns) {
            turns = new Set();
            this.backgroundTurns.set(envelope.agentId, turns);
          }
          turns.add(event.turnId);
        }
        return;
      case "turn_completed":
      case "turn_failed": {
        const turns = this.backgroundTurns.get(envelope.agentId);
        const isBackground = turns?.delete(event.turnId) ?? false;
        if (isBackground) {
          return;
        }
        const snapshot = this.snapshotOf(envelope.agentId);
        if (!snapshot || snapshot.origin === "judge") {
          return;
        }
        if (event.type === "turn_completed") {
          this.notify({
            kind: "finished",
            agentId: envelope.agentId,
            title: agentTitle(snapshot),
            body: "本轮已完成",
          });
        } else {
          this.notify({
            kind: "failed",
            agentId: envelope.agentId,
            title: agentTitle(snapshot),
            body: clip(`本轮失败：${event.error}`, ATTENTION_BODY_MAX_CHARS),
          });
        }
        return;
      }
      case "turn_canceled":
        this.backgroundTurns.get(envelope.agentId)?.delete(event.turnId);
        return;
      case "permission_requested": {
        const snapshot = this.snapshotOf(envelope.agentId);
        if (!snapshot || snapshot.origin === "judge") {
          return;
        }
        this.notify({
          kind: "permission",
          agentId: envelope.agentId,
          requestId: event.request.id,
          permissionKind: event.request.kind,
          title: agentTitle(snapshot),
          body: clip(permissionBody(event.request), ATTENTION_BODY_MAX_CHARS),
        });
        return;
      }
      case "permission_resolved": {
        // 审批在别处（桌面 / 另一台手机 / 超时取消）处理后撤回手机上已发的通知；judge 会话当初没发过，这里同样不发
        const snapshot = this.snapshotOf(envelope.agentId);
        if (!snapshot || snapshot.origin === "judge") {
          return;
        }
        this.notify({
          kind: "resolved",
          agentId: envelope.agentId,
          requestId: event.requestId,
          title: agentTitle(snapshot),
          body: "审批已处理",
        });
        return;
      }
      default:
        return;
    }
  }

  private handleScheduleNotice(notice: ScheduleNotice): void {
    this.notify({
      kind: "schedule",
      ...(notice.agentId !== undefined ? { agentId: notice.agentId } : {}),
      title: clip(notice.name || "定时任务", TITLE_MAX_CHARS),
      body: clip(notice.message, ATTENTION_BODY_MAX_CHARS),
    });
  }

  private snapshotOf(agentId: string): AgentSnapshot | undefined {
    try {
      return this.options.manager.getAgent(agentId);
    } catch {
      return undefined;
    }
  }

  private notify(partial: Omit<AttentionNotice, "id" | "timestamp">): void {
    this.options.sendToRemote({ id: randomUUID(), timestamp: this.now(), ...partial });
  }
}
