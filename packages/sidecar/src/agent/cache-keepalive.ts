// 缓存保活（design.md 4.36）：开启了 cacheKeepAlive 的 Claude 会话在等待子代理 / 后台任务 / 委派子会话时
// （置顶会话不要求在等待），距最近一次主线程请求满 50 分钟就在当前会话里发一条内部消息，刷新提示缓存的 TTL。
import type { AgentProviderId, AgentSnapshot, AgentStreamEnvelope } from "@agentdeck/protocol";

import { createSilentLogger, type Logger } from "../logger.js";
import type { AgentManager } from "./agent-manager.js";

/** 距最近一次主线程请求满这么久发保活：订阅套餐内主会话 TTL 为 1 小时，从请求开始计时，留出余量 */
export const KEEPALIVE_INTERVAL_MS = 50 * 60_000;
const SWEEP_MS = 60_000;

export const KEEPALIVE_PROMPT =
  "【AgentDeck 缓存保活】这是自动发送的消息，用于在等待期间保持提示缓存，不是新任务。" +
  "请只回复「ok」，不要调用任何工具，也不要检查或汇报后台任务。";

export interface CacheKeepAliveOptions {
  manager: Pick<AgentManager, "subscribe" | "listAgents" | "sendPrompt">;
  /** provider 是否为 Claude 类（AgentClient.kind === "claude"，含 extends claude 的自定义中转） */
  isClaude: (provider: AgentProviderId) => boolean;
  logger?: Logger;
  now?: () => number;
}

export class CacheKeepAlive {
  private readonly manager: CacheKeepAliveOptions["manager"];
  private readonly isClaude: CacheKeepAliveOptions["isClaude"];
  private readonly logger: Logger;
  private readonly now: () => number;
  /** agentId → 最近一次主线程请求（turn_started / usage_updated）或保活发送的时间，只在内存 */
  private readonly lastRequestAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(options: CacheKeepAliveOptions) {
    this.manager = options.manager;
    this.isClaude = options.isClaude;
    this.logger = options.logger ?? createSilentLogger();
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.unsubscribe = this.manager.subscribe({
      onStream: (envelope) => this.handleStream(envelope),
      onRemoved: (agentId) => {
        this.lastRequestAt.delete(agentId);
      },
    });
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** 扫一轮：返回本轮发出保活的 agentId */
  sweep(): string[] {
    const now = this.now();
    const agents = this.manager.listAgents();
    const sent: string[] = [];
    for (const agent of agents) {
      // 还没见过该会话的请求（sidecar 启动后）不保活：不知道缓存是否还在
      const last = this.lastRequestAt.get(agent.id);
      if (last === undefined || now - last < KEEPALIVE_INTERVAL_MS || !this.eligible(agent, agents)) {
        continue;
      }
      this.send(agent.id, now);
      sent.push(agent.id);
    }
    return sent;
  }

  private handleStream(envelope: AgentStreamEnvelope): void {
    const type = envelope.event.type;
    if (type === "turn_started" || type === "usage_updated") {
      this.lastRequestAt.set(envelope.agentId, this.now());
    }
  }

  private eligible(agent: AgentSnapshot, all: AgentSnapshot[]): boolean {
    if (agent.cacheKeepAlive !== true || !this.isClaude(agent.provider)) {
      return false;
    }
    if (agent.status !== "idle" || agent.activeTurnId || agent.pendingPermissions.length > 0) {
      return false;
    }
    // 置顶会话进程未被回收期间一直保活；其余只在等待子代理 / 后台任务 / 委派子会话时保活
    return agent.pinned === true || isWaiting(agent, all);
  }

  private send(agentId: string, now: number): void {
    // 发送时先记一次：成功后 turn_started 会再刷新；失败则等满一个间隔再试
    this.lastRequestAt.set(agentId, now);
    this.logger.info("缓存保活：向 agent %s 发送保活消息", agentId);
    void this.manager
      .sendPrompt(agentId, KEEPALIVE_PROMPT, undefined, { internal: true, keepAlive: true })
      .catch((error: unknown) => {
        this.logger.warn(
          "缓存保活：向 agent %s 发送失败：%s",
          agentId,
          error instanceof Error ? error.message : String(error),
        );
      });
  }
}

function isBusy(snapshot: AgentSnapshot): boolean {
  return snapshot.status === "running" || snapshot.status === "starting" || Boolean(snapshot.activeTurnId);
}

/** 有运行中的子代理 / 后台任务，或有仍在工作的直接子会话（design.md 4.26 委派） */
function isWaiting(agent: AgentSnapshot, all: AgentSnapshot[]): boolean {
  return (
    agent.backgroundActive === true ||
    all.some((child) => child.parentAgentId === agent.id && (isBusy(child) || child.backgroundActive === true))
  );
}
