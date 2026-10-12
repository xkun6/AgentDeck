import { describe, expect, test } from "vitest";

import type { AgentClient } from "../src/agent/types.js";
import { createSilentLogger } from "../src/logger.js";
import { MockAgentClient } from "../src/providers/mock/index.js";
import { createProviderRegistry, ProviderRegistry } from "../src/providers/registry.js";

const ctx = { logger: createSilentLogger(), env: {} };

describe("ProviderRegistry", () => {
  test("默认工厂只注册 mock（claude/codex/acp 为 P3 占位）", async () => {
    const registry = await createProviderRegistry(ctx);
    expect(registry.list().map((c) => c.provider)).toEqual(["mock"]);
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
        available: false,
        unavailableReason: "探测失败",
      },
      {
        id: "acp:x",
        kind: "acp",
        label: "X",
        available: false,
        unavailableReason: "未安装",
        command: ["x", "acp"],
      },
    ]);
  });
});
