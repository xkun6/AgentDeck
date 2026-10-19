import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentStreamEnvelope,
  AgentStreamEvent,
} from "@agentdeck/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";

import { AgentManager } from "../src/agent/agent-manager.js";
import { AgentRpcError } from "../src/agent/errors.js";
import type { AgentClient, AgentSession } from "../src/agent/types.js";
import { packTranslationBatches, parseTranslationBatch, wrapTranslationBatch } from "../src/translation/batch.js";
import { createTranslationCacheStore } from "../src/translation/cache-store.js";
import { TranslationService } from "../src/translation/translation-service.js";

const LANGUAGES = { userLanguage: "简体中文", agentLanguage: "English" };
const ENDPOINT = { baseUrl: "https://llm.example/v1/", apiKey: "sk-test", model: "m1" };

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** 假 endpoint：把 <translate-input> 里的原文加上 "EN:" 前缀返回 */
function fakeFetch(
  options: { status?: number; protocol?: "chat" | "responses"; batch?: "malformed" | "http-error" } = {},
) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body });
    if (options.status && options.status !== 200) {
      return new Response("upstream down", { status: options.status });
    }
    const userText =
      options.protocol === "responses"
        ? (body.input as Array<{ content: Array<{ text: string }> }>)[0]!.content[0]!.text
        : (body.messages as Array<{ role: string; content: string }>).find((m) => m.role === "user")!.content;
    const source = /<translate-input>\n([\s\S]*)\n<\/translate-input>/.exec(userText)![1]!;
    const isBatch = source.startsWith("<ti n=");
    if (isBatch && options.batch === "http-error") {
      return new Response("batch not supported", { status: 500 });
    }
    // 批量请求：逐项加前缀并保留标签；malformed 时模型丢了标签
    const translated = !isBatch
      ? `EN:${source}`
      : options.batch === "malformed"
        ? "EN: everything merged"
        : source.replace(/(<ti n="[^"]+" i="\d+">\n)([\s\S]*?)(\n<\/ti n="[^"]+" i="\d+">)/g, "$1EN:$2$3");
    const payload =
      options.protocol === "responses"
        ? { output: [{ type: "message", content: [{ type: "output_text", text: translated }] }] }
        : { choices: [{ message: { content: translated } }] };
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

async function createService(fetchFn: typeof fetch, extra: { dataDir?: string } = {}) {
  const service = new TranslationService({
    languages: () => LANGUAGES,
    fetchFn,
    ...(extra.dataDir ? { dataDir: extra.dataDir } : { cache: createTranslationCacheStore() }),
  });
  await service.load();
  return service;
}

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agentdeck-translation-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("TranslationService（design.md 4.35）", () => {
  test("chat-completions：URL、鉴权头、请求体；结果按 key 缓存，同 key 并发只请求一次", async () => {
    const { fn, calls } = fakeFetch();
    const service = await createService(fn);
    await service.setEndpoint(ENDPOINT);

    const [a, b] = await Promise.all([
      service.translate("user-to-agent", "你好"),
      service.translate("user-to-agent", "你好"),
    ]);
    expect(a).toBe("EN:你好");
    expect(b).toBe("EN:你好");
    expect(await service.translate("user-to-agent", "你好")).toBe("EN:你好");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://llm.example/v1/chat/completions");
    expect(calls[0]!.headers.authorization).toBe("Bearer sk-test");
    expect(calls[0]!.body).toMatchObject({ model: "m1", temperature: 0, stream: false });
    expect(calls[0]!.body).not.toHaveProperty("reasoning_effort");
    const system = (calls[0]!.body.messages as Array<{ role: string; content: string }>)[0]!;
    expect(system.role).toBe("system");
    expect(system.content).toContain("from 简体中文 to English");

    // 方向不同 / 改模型都不命中旧结果
    await service.translate("agent-to-user", "你好");
    await service.setEndpoint({ model: "m2" });
    await service.translate("user-to-agent", "你好");
    expect(calls).toHaveLength(3);
    expect((calls[1]!.body.messages as Array<{ content: string }>)[0]!.content).toContain(
      "from English to 简体中文",
    );
  });

  test("responses 协议：instructions + input_text，带 store:false 与 reasoning.effort", async () => {
    const { fn, calls } = fakeFetch({ protocol: "responses" });
    const service = await createService(fn);
    await service.setEndpoint({ ...ENDPOINT, protocol: "responses", reasoningEffort: "low" });
    expect(await service.translate("agent-to-user", "Hello")).toBe("EN:Hello");
    expect(calls[0]!.url).toBe("https://llm.example/v1/responses");
    expect(calls[0]!.body).toMatchObject({ store: false, reasoning: { effort: "low" } });
    expect(calls[0]!.body.instructions).toContain("translation engine");
    expect(calls[0]!.body).not.toHaveProperty("temperature");
  });

  test("未配置 / HTTP 错误 → TRANSLATION_FAILED；全空白原样返回且不请求", async () => {
    const { fn, calls } = fakeFetch({ status: 502 });
    const service = await createService(fn);
    await expect(service.translate("user-to-agent", "你好")).rejects.toMatchObject({
      code: "TRANSLATION_FAILED",
      message: expect.stringContaining("翻译未配置"),
    });
    await service.setEndpoint(ENDPOINT);
    expect(await service.translate("user-to-agent", "  \n")).toBe("  \n");
    expect(calls).toHaveLength(0);
    const error = await service.translate("user-to-agent", "你好").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentRpcError);
    expect(error).toMatchObject({ code: "TRANSLATION_FAILED", message: expect.stringContaining("HTTP 502") });
  });

  test("translatePrompt：斜杠命令保留命令词、附件 JSON 与图片原样、无参数命令不翻", async () => {
    const { fn, calls } = fakeFetch();
    const service = await createService(fn);
    await service.setEndpoint(ENDPOINT);
    const attachment = JSON.stringify({ mimeType: "text/plain", name: "a.txt", text: "内容" });
    const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
    expect(await service.translatePrompt("/review 看看这个改动")).toBe("/review EN:看看这个改动");
    expect(await service.translatePrompt("/compact")).toBe("/compact");
    expect(
      await service.translatePrompt([{ type: "text", text: "修一下" }, { type: "text", text: attachment }, image]),
    ).toEqual([{ type: "text", text: "EN:修一下" }, { type: "text", text: attachment }, image]);
    expect(calls).toHaveLength(2);
  });

  test("endpoint 配置与翻译缓存落盘：新实例读回配置，命中磁盘缓存不再请求", async () => {
    const dataDir = tempDir();
    const first = fakeFetch();
    const service = await createService(first.fn, { dataDir });
    await service.setEndpoint(ENDPOINT);
    await service.translate("agent-to-user", "Done.");
    expect(JSON.parse(readFileSync(path.join(dataDir, "translation-endpoint.json"), "utf8"))).toMatchObject(
      ENDPOINT,
    );

    const second = fakeFetch();
    const reopened = await createService(second.fn, { dataDir });
    expect(reopened.getEndpoint()).toMatchObject({ ...ENDPOINT, protocol: "chat-completions", timeoutMs: 30_000 });
    expect(await reopened.translate("agent-to-user", "Done.")).toBe("EN:Done.");
    expect(second.calls).toHaveLength(0);
  });
});

describe("批量合并（design.md 4.35）", () => {
  test("窗口内的不同原文打成一次带标签的请求，各自拿到译文并按单条键缓存", async () => {
    const { fn, calls } = fakeFetch();
    const service = await createService(fn);
    await service.setEndpoint(ENDPOINT);
    const results = await Promise.all(
      ["第一段", "第二段\n含换行", "第三段"].map((t) => service.translate("agent-to-user", t)),
    );
    expect(results).toEqual(["EN:第一段", "EN:第二段\n含换行", "EN:第三段"]);
    expect(calls).toHaveLength(1);
    const system = (calls[0]!.body.messages as Array<{ content: string }>)[0]!.content;
    expect(system).toContain("translate each item independently");
    // 之后单条请求命中缓存
    expect(await service.translate("agent-to-user", "第二段\n含换行")).toBe("EN:第二段\n含换行");
    expect(calls).toHaveLength(1);
  });

  test("方向不同不合并", async () => {
    const { fn, calls } = fakeFetch();
    const service = await createService(fn);
    await service.setEndpoint(ENDPOINT);
    await Promise.all([service.translate("agent-to-user", "甲"), service.translate("user-to-agent", "乙")]);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => !JSON.stringify(call.body).includes("<ti n="))).toBe(true);
  });

  test.each(["malformed", "http-error"] as const)("批量结果 %s → 退回逐条请求", async (batch) => {
    const { fn, calls } = fakeFetch({ batch });
    const service = await createService(fn);
    await service.setEndpoint(ENDPOINT);
    const results = await Promise.all(["一", "二", "三"].map((t) => service.translate("agent-to-user", t)));
    expect(results).toEqual(["EN:一", "EN:二", "EN:三"]);
    expect(calls).toHaveLength(4);
  });
});

describe("batch 工具函数", () => {
  test("parseTranslationBatch：容忍标签外文字，缺项 / 空项返回 null", () => {
    const wrapped = wrapTranslationBatch(["a", "b"], "N");
    expect(wrapped).toContain('<ti n="N" i="1">\nb\n</ti n="N" i="1">');
    const ok = 'Sure:\n<ti n="N" i="0">\nA\n</ti n="N" i="0">\n<ti n="N" i="1">\nB\n</ti n="N" i="1">';
    expect(parseTranslationBatch(ok, 2, "N")).toEqual(["A", "B"]);
    expect(parseTranslationBatch('<ti n="N" i="0">\nA\n</ti n="N" i="0">', 2, "N")).toBeNull();
    expect(parseTranslationBatch('<ti n="N" i="0">\n \n</ti n="N" i="0">', 1, "N")).toBeNull();
  });

  test("packTranslationBatches：按条数与字数分包，超长单条自成一包", () => {
    const items = ["aa", "bb", "cc", "x".repeat(10)].map((text) => ({ text }));
    expect(packTranslationBatches(items, { maxItems: 2, maxChars: 100 }).map((p) => p.length)).toEqual([2, 2]);
    expect(packTranslationBatches(items, { maxItems: 10, maxChars: 5 }).map((p) => p.length)).toEqual([2, 1, 1]);
  });
});

// ---------------------------------------------------------------------------
// AgentManager 接入
// ---------------------------------------------------------------------------

class FakeSession implements AgentSession {
  readonly provider = "fake";
  id: string | null = null;
  prompts: AgentPromptInput[] = [];
  steers: AgentPromptInput[] = [];
  responses: Array<{ id: string; response: AgentPermissionResponse }> = [];
  private listeners = new Set<(event: AgentStreamEvent) => void>();
  private counter = 0;

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.prompts.push(prompt);
    this.counter += 1;
    const turnId = `turn-${this.counter}`;
    this.emit({ type: "turn_started", turnId });
    return { turnId };
  }

  async steer(prompt: AgentPromptInput): Promise<void> {
    this.steers.push(prompt);
  }

  subscribe(cb: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emit(event: AgentStreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }
  async respondToPermission(id: string, response: AgentPermissionResponse): Promise<void> {
    this.responses.push({ id, response });
    this.emit({ type: "permission_resolved", requestId: id, response });
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
  describePersistence(): AgentPersistenceHandle | null {
    return null;
  }
}

let manager: AgentManager | null = null;

afterEach(async () => {
  await manager?.shutdown();
  manager = null;
});

function createManager(options: { fail?: boolean; defaultOn?: boolean } = {}) {
  const sessions: FakeSession[] = [];
  const client: AgentClient = {
    provider: "fake",
    kind: "mock",
    label: "Fake",
    isAvailable: async () => ({ available: true }),
    fetchCatalog: async () => ({ models: [], modes: [] }),
    createSession: async () => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
  };
  const translatePrompt = vi.fn(async (prompt: AgentPromptInput) => {
    if (options.fail) throw new AgentRpcError("TRANSLATION_FAILED", "翻译 endpoint 返回 HTTP 500：x");
    return typeof prompt === "string" ? `EN:${prompt}` : prompt;
  });
  const translateToAgent = vi.fn(async (text: string) => {
    if (options.fail) throw new AgentRpcError("TRANSLATION_FAILED", "翻译 endpoint 返回 HTTP 500：x");
    return `EN:${text}`;
  });
  manager = new AgentManager({
    registry: { get: (id) => (id === "fake" ? client : undefined) },
    translatePrompt,
    translateToAgent,
    translationDefault: () => options.defaultOn ?? false,
  });
  const streams: AgentStreamEnvelope[] = [];
  manager.subscribe({ onStream: (envelope) => streams.push(envelope), onState: () => undefined });
  return { manager, sessions, streams, translatePrompt, translateToAgent };
}

const userItems = (streams: AgentStreamEnvelope[]) =>
  streams.flatMap((e) =>
    e.event.type === "timeline" && e.event.item.type === "user_message" ? [e.event.item] : [],
  );

describe("AgentManager 翻译接入（design.md 4.35）", () => {
  test("会话开启翻译：agent.send 发出译文，user_message 保留原文并带 translatedText，preview 用原文", async () => {
    const h = createManager();
    const agent = await h.manager.createAgent({ provider: "fake", cwd: "/work" });
    expect(agent.translation).toBeUndefined();
    expect((await h.manager.updateAgent(agent.id, { translation: true })).translation).toBe(true);

    await h.manager.sendPrompt(agent.id, "修复登录", "cm-1", { translate: true });
    expect(h.sessions[0]!.prompts).toEqual(["EN:修复登录"]);
    expect(userItems(h.streams)).toEqual([
      { type: "user_message", text: "修复登录", translatedText: "EN:修复登录", clientMessageId: "cm-1" },
    ]);
    expect(h.manager.getAgent(agent.id).preview).toBe("修复登录");

    // 插话同样翻译
    await h.manager.steer(agent.id, "顺便加测试", "cm-2", { translate: true });
    expect(h.sessions[0]!.steers).toEqual(["EN:顺便加测试"]);
    expect(userItems(h.streams)[1]).toMatchObject({ text: "顺便加测试", translatedText: "EN:顺便加测试", steer: true });
  });

  test("未开启翻译或内部调用（无 translate）不翻译", async () => {
    const h = createManager();
    const agent = await h.manager.createAgent({ provider: "fake", cwd: "/work" });
    await h.manager.sendPrompt(agent.id, "原样", undefined, { translate: true });
    h.sessions[0]!.emit({ type: "turn_completed", turnId: "turn-1" });
    await h.manager.updateAgent(agent.id, { translation: true });
    await h.manager.sendPrompt(agent.id, "内部消息", undefined, { internal: true });
    expect(h.sessions[0]!.prompts).toEqual(["原样", "内部消息"]);
    expect(h.translatePrompt).not.toHaveBeenCalled();
    expect(userItems(h.streams).every((item) => !("translatedText" in item))).toBe(true);
  });

  test("翻译失败：抛 TRANSLATION_FAILED，不写 user_message、不开回合，之后仍可发送", async () => {
    const h = createManager({ fail: true });
    const agent = await h.manager.createAgent({ provider: "fake", cwd: "/work" });
    await h.manager.updateAgent(agent.id, { translation: true });
    await expect(h.manager.sendPrompt(agent.id, "你好", "cm", { translate: true })).rejects.toMatchObject({
      code: "TRANSLATION_FAILED",
    });
    expect(h.sessions[0]?.prompts ?? []).toEqual([]);
    expect(userItems(h.streams)).toEqual([]);
    expect(h.manager.getAgent(agent.id).status).toBe("idle");
    // sending 已释放：关掉翻译后可正常发送
    await h.manager.updateAgent(agent.id, { translation: false });
    await h.manager.sendPrompt(agent.id, "你好", "cm", { translate: true });
    expect(h.sessions[0]!.prompts).toEqual(["你好"]);
  });

  test("审批回答：拒绝理由、提问「其他」、表单文本字段翻译；选项 label、secret、带 format 的字段原样", async () => {
    const h = createManager();
    const agent = await h.manager.createAgent({ provider: "fake", cwd: "/work" });
    await h.manager.updateAgent(agent.id, { translation: true });
    await h.manager.sendPrompt(agent.id, "开始", undefined, { translate: true });
    const session = h.sessions[0]!;
    const ask = async (request: AgentPermissionRequest) => {
      session.emit({ type: "permission_requested", turnId: "turn-1", request });
      await vi.waitFor(() =>
        expect(h.manager.getAgent(agent.id).pendingPermissions.map((p) => p.id)).toContain(request.id),
      );
    };

    await ask({ id: "p1", provider: "fake", name: "Bash", kind: "tool" });
    await h.manager.respondToPermission(agent.id, "p1", { behavior: "deny", message: "别删文件" });

    await ask({
      id: "p2",
      provider: "fake",
      name: "AskUserQuestion",
      kind: "question",
      input: { questions: [] },
      detail: {
        type: "question",
        questions: [
          { question: "Which DB?", multiSelect: false, options: [{ label: "Postgres" }, { label: "SQLite" }] },
          { question: "Features?", multiSelect: true, options: [{ label: "Auth" }, { label: "Billing" }] },
          { question: "Token?", multiSelect: false, options: [], freeText: true, isSecret: true },
          { question: "Notes?", multiSelect: false, options: [], freeText: true },
        ],
      },
    });
    await h.manager.respondToPermission(agent.id, "p2", {
      behavior: "allow",
      updatedInput: {
        questions: [],
        answers: { "Which DB?": "SQLite", "Features?": "Auth, 还要导出", "Token?": "秘密", "Notes?": "尽快" },
      },
    });

    await ask({
      id: "p3",
      provider: "fake",
      name: "mcp",
      kind: "elicitation",
      detail: {
        type: "elicitation",
        serverName: "s",
        mode: "form",
        message: "fill",
        fields: [
          { key: "title", type: "string", required: true },
          { key: "email", type: "string", format: "email", required: true },
          { key: "pwd", type: "string", secret: true, required: true },
          { key: "env", type: "select", required: true, options: [{ value: "prod", label: "Prod" }] },
        ],
      },
    });
    await h.manager.respondToPermission(agent.id, "p3", {
      behavior: "allow",
      updatedInput: { content: { title: "修复登录", email: "a@b.c", pwd: "密码", env: "prod" } },
    });

    expect(session.responses.map((r) => r.response)).toEqual([
      { behavior: "deny", message: "EN:别删文件" },
      {
        behavior: "allow",
        updatedInput: {
          questions: [],
          answers: { "Which DB?": "SQLite", "Features?": "EN:Auth, 还要导出", "Token?": "秘密", "Notes?": "EN:尽快" },
        },
      },
      {
        behavior: "allow",
        updatedInput: { content: { title: "EN:修复登录", email: "a@b.c", pwd: "密码", env: "prod" } },
      },
    ]);
  });

  test("审批回答翻译失败：抛 TRANSLATION_FAILED，不提交、请求仍待处理；未开启翻译的会话原样提交", async () => {
    const h = createManager({ fail: true });
    const agent = await h.manager.createAgent({ provider: "fake", cwd: "/work" });
    await h.manager.sendPrompt(agent.id, "开始");
    const session = h.sessions[0]!;
    session.emit({
      type: "permission_requested",
      turnId: "turn-1",
      request: { id: "p1", provider: "fake", name: "Bash", kind: "tool" },
    });
    await h.manager.updateAgent(agent.id, { translation: true });
    await expect(
      h.manager.respondToPermission(agent.id, "p1", { behavior: "deny", message: "不行" }),
    ).rejects.toMatchObject({ code: "TRANSLATION_FAILED" });
    expect(session.responses).toEqual([]);
    expect(h.manager.getAgent(agent.id).pendingPermissions.map((p) => p.id)).toEqual(["p1"]);

    await h.manager.updateAgent(agent.id, { translation: false });
    await h.manager.respondToPermission(agent.id, "p1", { behavior: "deny", message: "不行" });
    expect(session.responses).toEqual([{ id: "p1", response: { behavior: "deny", message: "不行" } }]);
    expect(h.translateToAgent).toHaveBeenCalledTimes(1);
  });

  test("enabledByDefault 只作用于用户新建的会话", async () => {
    const h = createManager({ defaultOn: true });
    expect((await h.manager.createAgent({ provider: "fake", cwd: "/work" })).translation).toBe(true);
    expect(
      (await h.manager.createAgent({ provider: "fake", cwd: "/work", origin: "delegate" })).translation,
    ).toBeUndefined();
  });

  test("agent.create 显式 translation 优先于默认设置", async () => {
    const on = createManager({ defaultOn: true });
    expect(
      (await on.manager.createAgent({ provider: "fake", cwd: "/work", translation: false })).translation,
    ).toBeUndefined();
    const off = createManager();
    expect((await off.manager.createAgent({ provider: "fake", cwd: "/work", translation: true })).translation).toBe(
      true,
    );
  });
});
