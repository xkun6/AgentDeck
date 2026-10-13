// 自定义 provider 的 registry 重建、AgentManager 联动（运行中会话不受影响 / 恢复用新配置 / 删除后 PROVIDER_NOT_FOUND）、
// 包装 client 的静态模型与脱敏，以及 provider.config.* / provider.test 的 RPC 行为。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentStreamEvent, ProviderProfile } from "@agentdeck/protocol";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AgentManager } from "../../../src/agent/agent-manager.js";
import type { AgentClient, AgentSession } from "../../../src/agent/types.js";
import { createSilentLogger } from "../../../src/logger.js";
import {
  createCustomProviderClient,
  CustomProviderService,
  providersConfigPath,
} from "../../../src/providers/custom/index.js";
import { MockAgentClient } from "../../../src/providers/mock/index.js";
import { ProviderRegistry } from "../../../src/providers/registry.js";
import { RpcServer } from "../../../src/server/rpc-server.js";
import { RpcCallError, TestRpcClient } from "../../rpc-test-client.js";

const profile = (overrides: Partial<ProviderProfile> = {}): ProviderProfile => ({
  id: "relay",
  extends: "claude",
  label: "中转",
  baseUrl: "https://relay.example.com",
  apiKey: "sk-relay-secret",
  ...overrides,
});

/** 内层用 mock 实现，记录由哪个 profile（label）创建、调用了哪些方法 */
function trackingInner() {
  const created: { label: string; client: MockAgentClient; resumes: number; creates: number }[] = [];
  const createInner = (p: ProviderProfile): AgentClient => {
    const client = new MockAgentClient();
    const entry = { label: p.label, client, resumes: 0, creates: 0 };
    created.push(entry);
    const createSession = client.createSession.bind(client);
    const resumeSession = client.resumeSession.bind(client);
    client.createSession = async (cfg) => {
      entry.creates += 1;
      return createSession(cfg);
    };
    client.resumeSession = async (handle, cfg) => {
      entry.resumes += 1;
      return resumeSession(handle, cfg);
    };
    return client;
  };
  return { created, createInner };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "agentdeck-custom-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("ProviderRegistry 自定义项", () => {
  test("替换自定义项：内置项不变且排在前面，自定义项带 custom / extends / description", async () => {
    const registry = new ProviderRegistry([new MockAgentClient()]);
    const { createInner } = trackingInner();
    const a = createCustomProviderClient(profile({ id: "a", description: "说明" }), {
      logger: createSilentLogger(),
      env: {},
      createInner,
    });
    const b = createCustomProviderClient(profile({ id: "b", extends: "codex" }), {
      logger: createSilentLogger(),
      env: {},
      createInner,
    });
    registry.replaceCustomClients([a, b]);
    expect(registry.list().map((c) => c.provider)).toEqual(["mock", "custom:a", "custom:b"]);
    expect(registry.builtinIds()).toEqual(["mock"]);
    await expect(registry.listProviderInfo()).resolves.toEqual([
      { id: "mock", kind: "mock", label: "Mock Agent", available: true },
      { id: "custom:a", kind: "claude", label: "中转", available: true, custom: true, extends: "claude", description: "说明" },
      { id: "custom:b", kind: "codex", label: "中转", available: true, custom: true, extends: "codex" },
    ]);

    registry.replaceCustomClients([b]);
    expect(registry.get("custom:a")).toBeUndefined();
    expect(registry.list().map((c) => c.provider)).toEqual(["mock", "custom:b"]);
  });

  test("与内置 id 冲突或重复时拒绝，且不改动现有项", () => {
    const registry = new ProviderRegistry([new MockAgentClient()]);
    const fake = { provider: "mock" } as AgentClient;
    expect(() => registry.replaceCustomClients([fake])).toThrow("冲突");
    const dup = { provider: "custom:x" } as AgentClient;
    expect(() => registry.replaceCustomClients([dup, dup])).toThrow("重复");
    expect(registry.list().map((c) => c.provider)).toEqual(["mock"]);
  });

  test("被替换的旧 client 不立即 shutdown，registry.shutdown 时统一关闭", async () => {
    const registry = new ProviderRegistry([]);
    const shutdown = vi.fn(async () => undefined);
    const old = { provider: "custom:x", shutdown } as unknown as AgentClient;
    registry.replaceCustomClients([old]);
    registry.replaceCustomClients([]);
    expect(shutdown).not.toHaveBeenCalled();
    await registry.shutdown();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});

describe("CustomProviderClient 包装", () => {
  test("静态模型替代动态发现；未指定模型时用 isDefault 模型；provider id 改写", async () => {
    const inner = new MockAgentClient();
    const fetchSpy = vi.spyOn(inner, "fetchCatalog");
    const createSpy = vi.spyOn(inner, "createSession");
    const client = createCustomProviderClient(
      profile({ models: [{ id: "glm", label: "GLM" }, { id: "kimi", label: "Kimi", isDefault: true }] }),
      { logger: createSilentLogger(), env: {}, createInner: () => inner },
    );
    const catalog = await client.fetchCatalog();
    // 基于 claude 的中转：静态模型补 Claude 标准思考档位
    const claudeStandard = {
      thinkingOptions: [
        { id: "low", label: "低" },
        { id: "medium", label: "中" },
        { id: "high", label: "高" },
        { id: "max", label: "最高" },
      ],
      defaultThinkingOptionId: "high",
    };
    expect(catalog.models).toEqual([
      { provider: "custom:relay", id: "glm", label: "GLM", ...claudeStandard },
      { provider: "custom:relay", id: "kimi", label: "Kimi", isDefault: true, ...claudeStandard },
    ]);
    expect(catalog.modes.map((m) => m.id)).toContain("bypassPermissions");
    expect(fetchSpy).not.toHaveBeenCalled();

    const session = await client.createSession({ cwd: "/w" });
    expect(createSpy).toHaveBeenLastCalledWith({ cwd: "/w", model: "kimi" });
    await session.close();
    const explicit = await client.createSession({ cwd: "/w", model: "glm" });
    expect(createSpy).toHaveBeenLastCalledWith({ cwd: "/w", model: "glm" });
    await explicit.close();
  });

  test("思考强度：codex 中转静态模型补 low/medium/high；acp 中转沿用会话报告的档位；会话透传 setThinking", async () => {
    const codex = createCustomProviderClient(
      profile({ extends: "codex", models: [{ id: "gpt-x", label: "GPT-X" }] }),
      { logger: createSilentLogger(), env: {}, createInner: () => new MockAgentClient() },
    );
    const codexCatalog = await codex.fetchCatalog();
    expect(codexCatalog.models[0]!.thinkingOptions?.map((o) => o.id)).toEqual(["low", "medium", "high"]);
    expect(codexCatalog.models[0]!.defaultThinkingOptionId).toBe("medium");

    // acp：内层（这里用 mock）报告了档位 → 挂到每个静态模型上
    const acp = createCustomProviderClient(
      profile({ extends: "acp", command: ["agent"], models: [{ id: "m1", label: "M1" }] }),
      { logger: createSilentLogger(), env: {}, createInner: () => new MockAgentClient() },
    );
    const acpCatalog = await acp.fetchCatalog();
    expect(acpCatalog.models[0]!.thinkingOptions?.map((o) => o.id)).toEqual(["low", "high"]);
    expect(acpCatalog.models[0]!.defaultThinkingOptionId).toBe("high");

    const session = await codex.createSession({ cwd: "/w", thinkingOptionId: "low" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    expect(session.setThinking).toBeTypeOf("function");
    await session.setThinking!("high");
    expect(events).toContainEqual({ type: "thinking_option_changed", thinkingOptionId: "high" });
    await session.close();
  });

  test("错误与会话事件中的密钥被脱敏", async () => {
    const secret = "sk-relay-secret";
    const listeners = new Set<(e: AgentStreamEvent) => void>();
    const session = {
      provider: "custom:relay",
      id: null,
      startTurn: async () => {
        for (const cb of listeners) cb({ type: "turn_failed", turnId: "t1", error: `401: bad key ${secret}` });
        return { turnId: "t1" };
      },
      subscribe: (cb: (e: AgentStreamEvent) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      getPendingPermissions: () => [],
      respondToPermission: async () => undefined,
      interrupt: async () => {
        throw new Error(`interrupt failed for ${secret}`);
      },
      close: async () => undefined,
      describePersistence: () => null,
    } satisfies AgentSession;
    const inner: AgentClient = {
      provider: "custom:relay",
      kind: "claude",
      label: "x",
      isAvailable: async () => ({ available: false, reason: `token ${secret} 无效` }),
      fetchCatalog: async () => {
        throw new Error(`catalog ${secret}`);
      },
      createSession: async () => session,
    };
    const client = createCustomProviderClient(profile(), {
      logger: createSilentLogger(),
      env: {},
      createInner: () => inner,
    });
    expect((await client.isAvailable()).reason).toBe("token *** 无效");
    await expect(client.fetchCatalog()).rejects.toThrow("catalog ***");
    const wrapped = await client.createSession({ cwd: "/w" });
    const events: AgentStreamEvent[] = [];
    wrapped.subscribe((e) => events.push(e));
    await wrapped.startTurn("hi");
    expect(events).toEqual([{ type: "turn_failed", turnId: "t1", error: "401: bad key ***" }]);
    await expect(wrapped.interrupt()).rejects.toThrow("interrupt failed for ***");
    expect(wrapped.setModel).toBeUndefined();
  });
});

describe("CustomProviderService + AgentManager", () => {
  function setup() {
    const registry = new ProviderRegistry([new MockAgentClient()]);
    const tracking = trackingInner();
    const service = new CustomProviderService({
      registry,
      logger: createSilentLogger(),
      env: {},
      dataDir,
      clientDeps: { createInner: tracking.createInner },
    });
    const manager = new AgentManager({ registry, coalesceWindowMs: 0 });
    const events: AgentStreamEvent[] = [];
    manager.subscribe({ onStream: (envelope) => events.push(envelope.event) });
    const turnEnds = () => events.filter((e) => e.type === "turn_completed").length;
    return { registry, tracking, service, manager, turnEnds };
  }

  test("registry 重建不影响运行中会话；关闭后恢复走新配置；删除后恢复返回 PROVIDER_NOT_FOUND", async () => {
    const { registry, tracking, service, manager, turnEnds } = setup();
    await service.setConfig([profile()]);
    const agent = await manager.createAgent({ provider: "custom:relay", cwd: "/w" });
    await manager.sendPrompt(agent.id, "第一轮");
    await waitFor(() => turnEnds() === 1);

    // 删除 profile：registry 中不再有该 provider，但运行中的会话继续可用
    await service.setConfig([]);
    expect(registry.get("custom:relay")).toBeUndefined();
    await manager.sendPrompt(agent.id, "第二轮");
    await waitFor(() => turnEnds() === 2);

    // 关闭后再发：provider 已删除 → PROVIDER_NOT_FOUND
    await manager.close(agent.id);
    await expect(manager.sendPrompt(agent.id, "第三轮")).rejects.toMatchObject({
      code: "PROVIDER_NOT_FOUND",
    });

    // 重新加上（新配置）：恢复用新 client
    await service.setConfig([profile({ label: "新配置" })]);
    await manager.sendPrompt(agent.id, "第四轮");
    await waitFor(() => turnEnds() === 3);
    expect(tracking.created.map((c) => c.label)).toEqual(["中转", "新配置"]);
    expect(tracking.created[0]!.resumes).toBe(0);
    expect(tracking.created[1]!.resumes).toBe(1);

    // 替换 profile 时运行中的会话仍用旧 client；新建会话用新 client
    await service.setConfig([profile({ label: "第三版" })]);
    await manager.sendPrompt(agent.id, "第五轮");
    await waitFor(() => turnEnds() === 4);
    expect(tracking.created[2]!.resumes + tracking.created[2]!.creates).toBe(0);
    await manager.createAgent({ provider: "custom:relay", cwd: "/w" });
    expect(tracking.created[2]!.creates).toBe(1);
    await manager.shutdown();
  });

  test("enabled:false 不注册；load 读回文件；未设数据目录时 get 为空、set 返回 NOT_SUPPORTED", async () => {
    const { registry, service } = setup();
    await service.setConfig([profile(), profile({ id: "off", enabled: false })]);
    expect(registry.list().map((c) => c.provider)).toEqual(["mock", "custom:relay"]);
    expect(service.getConfig()).toEqual({
      providers: [profile(), profile({ id: "off", enabled: false })],
      path: providersConfigPath(dataDir),
    });

    const fresh = new ProviderRegistry([new MockAgentClient()]);
    const reloaded = new CustomProviderService({
      registry: fresh,
      logger: createSilentLogger(),
      env: {},
      dataDir,
      clientDeps: { createInner: () => new MockAgentClient() },
    });
    await reloaded.load();
    expect(fresh.list().map((c) => c.provider)).toEqual(["mock", "custom:relay"]);

    const noData = new CustomProviderService({
      registry: new ProviderRegistry([]),
      logger: createSilentLogger(),
      env: {},
    });
    await noData.load();
    expect(noData.getConfig()).toEqual({ providers: [], path: null });
    await expect(noData.setConfig([profile()])).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });

  test("文件损坏时 load 不抛错，注册空表", async () => {
    writeFileSync(providersConfigPath(dataDir), "{ broken");
    const { registry, service } = setup();
    await expect(service.load()).resolves.toBeUndefined();
    expect(registry.list().map((c) => c.provider)).toEqual(["mock"]);
  });
});

describe("RPC：provider.config.get / set、provider.test、provider.changed", () => {
  const TOKEN = "custom-test-token";
  let server: RpcServer;
  let manager: AgentManager;
  let client: TestRpcClient;

  async function start(withService: boolean) {
    const registry = new ProviderRegistry([new MockAgentClient()]);
    manager = new AgentManager({ registry });
    const service = withService
      ? new CustomProviderService({
          registry,
          logger: createSilentLogger(),
          env: {},
          dataDir,
          clientDeps: {
            createInner: () => new MockAgentClient(),
            findExecutable: async (name) => (name === "kimi" ? "C:\\bin\\kimi.exe" : null),
          },
        })
      : undefined;
    server = new RpcServer({
      token: TOKEN,
      version: "test",
      manager,
      registry,
      ...(service ? { providerConfig: service } : {}),
    });
    const port = await server.listen(0);
    client = await TestRpcClient.connect(`ws://127.0.0.1:${port}/rpc?token=${TOKEN}`);
  }

  afterEach(async () => {
    await client.close();
    await manager.shutdown();
    await server.close();
  });

  test("set 成功：写盘、返回含自定义项的 provider 列表并广播 provider.changed；get 含明文 apiKey", async () => {
    await start(true);
    const result = await client.call("provider.config.set", {
      providers: [profile({ baseUrl: "https://relay.example.com/" })],
    });
    expect(result.providers.map((p) => p.id)).toEqual(["mock", "custom:relay"]);
    expect(result.providers[1]).toMatchObject({ custom: true, extends: "claude", kind: "claude" });
    await client.waitFor(() => client.notifications.some((n) => n.method === "provider.changed"));
    expect(client.notifications).toEqual([{ method: "provider.changed", params: {} }]);

    const config = await client.call("provider.config.get");
    expect(config.providers).toEqual([profile()]); // baseUrl 末尾 / 已去掉
    expect(config.path).toBe(providersConfigPath(dataDir));
    expect(JSON.parse(readFileSync(providersConfigPath(dataDir), "utf8")).providers).toEqual([profile()]);
    expect((await client.call("provider.list")).map((p) => p.id)).toContain("custom:relay");
  });

  test("set 校验失败：-32602 + data.issues，不写盘、不广播", async () => {
    await start(true);
    const response = await client.request("provider.config.set", {
      providers: [
        profile({ id: "dup" }),
        profile({ id: "dup" }),
        profile({ id: "mock" }),
        { id: "a", extends: "acp", label: "x" },
        profile({ id: "u", baseUrl: "javascript:alert(1)" }),
      ],
    });
    expect(response.error?.code).toBe(-32602);
    const issues = (response.error?.data as { issues: { path: string; message: string }[] }).issues;
    expect(issues.map((i) => i.path).sort()).toEqual(
      ["providers.1.id", "providers.2.id", "providers.3.command", "providers.4.baseUrl"].sort(),
    );
    expect(JSON.stringify(response.error)).not.toContain("sk-relay-secret");
    expect(client.notifications).toEqual([]);
    expect((await client.call("provider.config.get")).providers).toEqual([]);
  });

  test("provider.test：参数校验 + acp 命令解析", async () => {
    await start(true);
    await expect(
      client.call("provider.test", { profile: { id: "k", extends: "acp", label: "k", command: ["kimi"] } }),
    ).resolves.toMatchObject({ ok: true });
    const bad = await client.request("provider.test", { profile: { id: "K", extends: "claude", label: "" } });
    expect(bad.error?.code).toBe(-32602);
  });

  test("未接入配置服务：get 返回空表，set 返回 NOT_SUPPORTED", async () => {
    await start(false);
    await expect(client.call("provider.config.get")).resolves.toEqual({ providers: [], path: null });
    const error = await client.call("provider.config.set", { providers: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcCallError);
    expect((error as RpcCallError).error.data?.code).toBe("NOT_SUPPORTED");
  });
});
