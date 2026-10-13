import type { AgentProviderId, ProviderInfo } from "@agentdeck/protocol";

import type { AgentClient, ProviderFactory, ProviderFactoryContext } from "../agent/types.js";
import { withTimeout } from "../utils/promise-timeout.js";
import { createAcpClients } from "./acp/index.js";
import { createClaudeClients } from "./claude/index.js";
import { createCodexClients } from "./codex/index.js";
import { createMockClients } from "./mock/index.js";

const AVAILABILITY_TIMEOUT_MS = 10_000;

/**
 * 各 provider 目录导出的工厂。registry 只负责汇总，P3 的 claude / codex / acp 各自只改自己的目录。
 * 顺序即 provider.list 的返回顺序。mock 只在 `AGENTDECK_ENABLE_MOCK=1` 时注册（见 mock/index.ts）。
 */
export const PROVIDER_FACTORIES: readonly ProviderFactory[] = [
  createClaudeClients,
  createCodexClients,
  createAcpClients,
  createMockClients,
];

export class ProviderRegistry {
  private readonly clients = new Map<AgentProviderId, AgentClient>();
  /** 自定义 provider（providers.json），始终排在内置项之后 */
  private readonly customIds = new Set<AgentProviderId>();
  /** 被替换 / 删除的自定义 client：运行中的会话可能仍在用，退出时再统一 shutdown */
  private readonly retired = new Set<AgentClient>();

  constructor(clients: Iterable<AgentClient>) {
    for (const client of clients) {
      if (this.clients.has(client.provider)) {
        throw new Error(`provider id 重复：${client.provider}`);
      }
      this.clients.set(client.provider, client);
    }
  }

  get(provider: AgentProviderId): AgentClient | undefined {
    return this.clients.get(provider);
  }

  list(): AgentClient[] {
    return Array.from(this.clients.values());
  }

  /** 内置 provider 的 id（不含自定义项） */
  builtinIds(): AgentProviderId[] {
    return this.list()
      .map((client) => client.provider)
      .filter((id) => !this.customIds.has(id));
  }

  /**
   * 整体替换自定义 provider（design.md 4.7），内置项不变。旧 client 不 shutdown：AgentManager 里运行中的会话
   * 持有旧 client 创建的会话对象，继续运行直到关闭；新建 / 恢复会话通过 get() 拿到新 client。
   */
  replaceCustomClients(clients: Iterable<AgentClient>): void {
    const next = Array.from(clients);
    const seen = new Set<AgentProviderId>();
    for (const client of next) {
      if (seen.has(client.provider)) {
        throw new Error(`provider id 重复：${client.provider}`);
      }
      if (this.clients.has(client.provider) && !this.customIds.has(client.provider)) {
        throw new Error(`自定义 provider 与内置 provider 冲突：${client.provider}`);
      }
      seen.add(client.provider);
    }
    for (const id of this.customIds) {
      const old = this.clients.get(id);
      if (old) {
        this.retired.add(old);
      }
      this.clients.delete(id);
    }
    this.customIds.clear();
    for (const client of next) {
      this.clients.set(client.provider, client);
      this.customIds.add(client.provider);
    }
  }

  /** provider.list：逐个探测可用性（单个超时/异常记为不可用，不影响其它 provider） */
  async listProviderInfo(): Promise<ProviderInfo[]> {
    return Promise.all(
      this.list().map(async (client): Promise<ProviderInfo> => {
        const base: Pick<
          ProviderInfo,
          "id" | "kind" | "label" | "custom" | "extends" | "description" | "capabilities"
        > = {
          id: client.provider,
          kind: client.kind,
          label: client.label,
          // 能力（design.md 4.22 / 4.23）：steer 取自 client，fork 由是否实现 forkSession 决定（原生 / 带摘要新开）
          capabilities: {
            ...client.capabilities,
            fork: client.forkSession ? "native" : "summary",
          },
          ...(client.custom
            ? {
                custom: true,
                extends: client.custom.extends,
                ...(client.custom.description !== undefined
                  ? { description: client.custom.description }
                  : {}),
              }
            : {}),
        };
        try {
          const availability = await withTimeout(
            client.isAvailable(),
            AVAILABILITY_TIMEOUT_MS,
            `探测 ${client.provider} 可用性超时`,
          );
          return {
            ...base,
            available: availability.available,
            ...(availability.reason !== undefined
              ? { unavailableReason: availability.reason }
              : {}),
            ...(availability.command !== undefined ? { command: availability.command } : {}),
          };
        } catch (error) {
          return { ...base, available: false, unavailableReason: errorMessage(error) };
        }
      }),
    );
  }

  async shutdown(): Promise<void> {
    const all = [...this.list(), ...this.retired];
    this.retired.clear();
    await Promise.allSettled(all.map((client) => client.shutdown?.()));
  }
}

export async function createProviderRegistry(
  ctx: ProviderFactoryContext,
  factories: readonly ProviderFactory[] = PROVIDER_FACTORIES,
): Promise<ProviderRegistry> {
  const clients: AgentClient[] = [];
  for (const factory of factories) {
    try {
      clients.push(...(await factory(ctx)));
    } catch (error) {
      ctx.logger.error("初始化 provider 工厂失败：%s", errorMessage(error));
    }
  }
  return new ProviderRegistry(clients);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
