// Derived from paseo-translate server/translate.ts; modified for AgentDeck
// 翻译服务（design.md 4.35）：endpoint 配置读写、带缓存的单条翻译、prompt 翻译。

import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type {
  AgentPromptInput,
  SidecarSettings,
  TranslationDirection,
  TranslationEndpoint,
} from "@agentdeck/protocol";
import { z } from "zod";

import { writeFileAtomic } from "../agent/agent-store.js";
import { AgentRpcError } from "../agent/errors.js";
import { createSilentLogger, type Logger } from "../logger.js";
import { TRANSLATION_CACHE_FILE, createTranslationCacheStore, type TranslationCacheStore } from "./cache-store.js";
import { completeChat } from "./llm-client.js";
import { promptTranslationParts, translationSystemPrompt, wrapTranslationInput } from "./prompt-text.js";

export const TRANSLATION_ENDPOINT_FILE = "translation-endpoint.json";
export const TRANSLATION_TEXT_LIMIT = 100_000;
/** 同时进行的 endpoint 请求上限，其余排队 */
const MAX_CONCURRENT_REQUESTS = 4;

export const DEFAULT_TRANSLATION_ENDPOINT: TranslationEndpoint = {
  baseUrl: "",
  apiKey: "",
  model: "",
  protocol: "chat-completions",
  reasoningEffort: "default",
  timeoutMs: 30_000,
};

export const translationEndpointPatchSchema = z
  .object({
    baseUrl: z.string().trim(),
    apiKey: z.string().trim(),
    model: z.string().trim(),
    protocol: z.enum(["chat-completions", "responses"]),
    reasoningEffort: z.enum(["default", "none", "minimal", "low", "medium", "high"]),
    timeoutMs: z.number().int().min(1_000).max(600_000),
  })
  .partial()
  .strict();

type Languages = Pick<SidecarSettings["translation"], "userLanguage" | "agentLanguage">;

export interface TranslationServiceOptions {
  dataDir?: string;
  logger?: Logger;
  /** 每次翻译时读取当前语言设置 */
  languages: () => Languages;
  fetchFn?: typeof fetch;
  /** 测试注入；缺省按 dataDir 建持久化缓存 */
  cache?: TranslationCacheStore;
}

export class TranslationService {
  private endpoint: TranslationEndpoint = { ...DEFAULT_TRANSLATION_ENDPOINT };
  private readonly logger: Logger;
  private readonly file: string | undefined;
  private readonly cache: TranslationCacheStore;
  private readonly inflight = new Map<string, Promise<string>>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: TranslationServiceOptions) {
    this.logger = options.logger ?? createSilentLogger();
    this.file = options.dataDir ? path.join(options.dataDir, TRANSLATION_ENDPOINT_FILE) : undefined;
    this.cache =
      options.cache ??
      createTranslationCacheStore({
        logger: this.logger,
        ...(options.dataDir ? { file: path.join(options.dataDir, TRANSLATION_CACHE_FILE) } : {}),
      });
  }

  /** 读取 endpoint 配置；文件不存在用默认值，字段非法的逐项回退默认值 */
  async load(): Promise<void> {
    if (!this.file) {
      return;
    }
    try {
      const raw: unknown = JSON.parse(await readFile(this.file, "utf8"));
      const next = { ...DEFAULT_TRANSLATION_ENDPOINT };
      if (typeof raw === "object" && raw !== null) {
        for (const [field, value] of Object.entries(raw)) {
          const one = translationEndpointPatchSchema.safeParse({ [field]: value });
          if (one.success) {
            Object.assign(next, one.data);
          }
        }
      }
      this.endpoint = next;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn("读取翻译 endpoint 配置失败，使用默认值：%s", String(error));
      }
    }
  }

  getEndpoint(): TranslationEndpoint {
    return { ...this.endpoint };
  }

  /** patch 已通过 translationEndpointPatchSchema 校验；写盘失败时抛出且不改变内存状态 */
  async setEndpoint(patch: Partial<TranslationEndpoint>): Promise<TranslationEndpoint> {
    const next = { ...this.endpoint, ...patch };
    if (this.file) {
      const file = this.file;
      const write = this.writeChain.then(async () => {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
      });
      this.writeChain = write.catch(() => undefined);
      await write;
    }
    this.endpoint = next;
    return this.getEndpoint();
  }

  /** 翻译一段文本；全空白原样返回。未配置 / 超长 / 请求失败抛 TRANSLATION_FAILED */
  async translate(direction: TranslationDirection, text: string): Promise<string> {
    if (text.trim().length === 0) {
      return text;
    }
    if (text.length > TRANSLATION_TEXT_LIMIT) {
      throw new AgentRpcError(
        "TRANSLATION_FAILED",
        `文本过长（${text.length} 字），翻译上限为 ${TRANSLATION_TEXT_LIMIT} 字`,
      );
    }
    const endpoint = this.getEndpoint();
    if (endpoint.baseUrl.length === 0 || endpoint.model.length === 0) {
      throw new AgentRpcError("TRANSLATION_FAILED", "翻译未配置：请在设置「翻译」中填写 endpoint 地址与模型");
    }
    const languages = this.options.languages();
    const [source, target] =
      direction === "user-to-agent"
        ? [languages.userLanguage, languages.agentLanguage]
        : [languages.agentLanguage, languages.userLanguage];
    const systemPrompt = translationSystemPrompt(source, target);
    // 键覆盖所有影响输出的设置：改语言 / endpoint / 模型 / 协议 / 思考强度后不会命中旧结果
    const key = JSON.stringify({
      direction,
      source,
      target,
      baseUrl: digest(endpoint.baseUrl),
      model: digest(endpoint.model),
      protocol: endpoint.protocol,
      effort: endpoint.reasoningEffort,
      prompt: digest(systemPrompt),
      text: digest(text),
    });
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const pending = this.inflight.get(key);
    if (pending) {
      return pending;
    }
    const request = this.withSlot(() =>
      completeChat(
        endpoint,
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: wrapTranslationInput(text) },
        ],
        this.options.fetchFn,
      ),
    )
      .then((translated) => {
        this.cache.set(key, translated);
        return translated;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn("翻译失败：%s", message);
        throw new AgentRpcError("TRANSLATION_FAILED", message);
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, request);
    return request;
  }

  /**
   * 把用户 prompt 的文本块翻成 Agent 语言：斜杠命令保留命令词、序列化附件与图片原样。
   * 任一块失败即抛出（调用方据此不发送）。
   */
  async translatePrompt(prompt: AgentPromptInput): Promise<AgentPromptInput> {
    const translateBlock = async (text: string) => {
      const parts = promptTranslationParts(text);
      return parts === null ? text : parts.prefix + (await this.translate("user-to-agent", parts.body));
    };
    if (typeof prompt === "string") {
      return translateBlock(prompt);
    }
    return Promise.all(
      prompt.map(async (block) =>
        block.type === "text" ? { ...block, text: await translateBlock(block.text) } : block,
      ),
    );
  }

  /** 并发上限：满了就排队，结束时把名额直接交给队首 */
  private async withSlot<T>(run: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENT_REQUESTS) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await run();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        next();
      } else {
        this.active -= 1;
      }
    }
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
