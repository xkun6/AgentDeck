import { describe, expect, test } from "vitest";

import type { AgentClient } from "../src/agent/types.js";
import { createSilentLogger } from "../src/logger.js";
import { MockAgentClient } from "../src/providers/mock/index.js";
import { createProviderRegistry, ProviderRegistry } from "../src/providers/registry.js";

const ctx = { logger: createSilentLogger(), env: {} };

describe("ProviderRegistry", () => {
  test("默认工厂只注册 Claude、Codex 与内置 ACP agent（acp:dsh），不含 mock", async () => {
    const registry = await createProviderRegistry(ctx);
    expect(registry.list().map((c) => c.provider)).toEqual(["claude", "codex", "acp:dsh"]);
    expect(registry.get("mock")).toBeUndefined();
  });

  test("AGENTDECK_ENABLE_MOCK=1 时额外注册 mock，且 provider id 不重复", async () => {
    const registry = await createProviderRegistry({ ...ctx, env: { AGENTDECK_ENABLE_MOCK: "1" } });
    const ids = registry.list().map((c) => c.provider);
    expect(ids).toEqual(["claude", "codex", "acp:dsh", "mock"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(registry.get("mock")).toBeInstanceOf(MockAgentClient);
  });

  test("单个工厂抛错不影响其它 provider", async () => {
    const registry = await createProviderRegistry(ctx, [
      () => {
        throw new Error("boom");
      },
      () => [new MockAgentClient()],
    ]);
    expect(registry.list().map((c) => c.provider)).toEqual(["mock"]);
  });

  test("provider id 重复时报错", () => {
    expect(() => new ProviderRegistry([new MockAgentClient(), new MockAgentClient()])).toThrow(
      "重复",
    );
  });

  test("listProviderInfo：可用性探测异常记为不可用并带 command", async () => {
    const broken: AgentClient = {
      provider: "broken",
      kind: "acp",
      label: "Broken",
      isAvailable: async () => {
        throw new Error("探测失败");
      },
      fetchCatalog: async () => ({ models: [], modes: [] }),
      createSession: async () => {
        throw new Error("unreachable");
      },
    };
    const withCommand: AgentClient = {
      ...broken,
      provider: "acp:x",
      label: "X",
      isAvailable: async () => ({ available: false, reason: "未安装", command: ["x", "acp"] }),
    };
    const registry = new ProviderRegistry([broken, withCommand]);
    await expect(registry.listProviderInfo()).resolves.toEqual([
      {
        id: "broken",
        kind: "acp",
        label: "Broken",
        capabilities: { fork: "summary" },
        available: false,
        unavailableReason: "探测失败",
      },
      {
        id: "acp:x",
        kind: "acp",
        label: "X",
        capabilities: { fork: "summary" },
        available: false,
        unavailableReason: "未安装",
        command: ["x", "acp"],
      },
    ]);
  });
});
