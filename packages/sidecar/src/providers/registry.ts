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
 * 顺序即 provider.list 的返回顺序。
 */
export const PROVIDER_FACTORIES: readonly ProviderFactory[] = [
  createClaudeClients,
  createCodexClients,
  createAcpClients,
  createMockClients,
];

export class ProviderRegistry {
  private readonly clients = new Map<AgentProviderId, AgentClient>();

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

  /** provider.list：逐个探测可用性（单个超时/异常记为不可用，不影响其它 provider） */
  async listProviderInfo(): Promise<ProviderInfo[]> {
    return Promise.all(
      this.list().map(async (client): Promise<ProviderInfo> => {
        const base = { id: client.provider, kind: client.kind, label: client.label };
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
    await Promise.allSettled(this.list().map((client) => client.shutdown?.()));
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
