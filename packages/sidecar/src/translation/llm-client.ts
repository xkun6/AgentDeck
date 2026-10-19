// Derived from paseo-translate server/llm-client.ts; modified for AgentDeck
// 精简为单次非流式请求（design.md 4.35）：Chat Completions 或 Responses 两种协议，调用方决定失败策略。

import type { TranslationEndpoint } from "@agentdeck/protocol";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/** 单次请求：返回模型输出文本；HTTP 错误、超时、响应结构不对都抛错（message 为中文说明） */
export async function completeChat(
  endpoint: TranslationEndpoint,
  messages: readonly ChatMessage[],
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const path = endpoint.protocol === "responses" ? "/responses" : "/chat/completions";
  const url = `${endpoint.baseUrl.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (endpoint.apiKey.length > 0) {
    headers.authorization = `Bearer ${endpoint.apiKey}`;
  }
  // 超时同时覆盖响应体读取：先回响应头再卡住的 endpoint 不能把调用方挂住
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), endpoint.timeoutMs);
  let status: number;
  let ok: boolean;
  let body: string;
  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(
        endpoint.protocol === "responses"
          ? buildResponsesBody(endpoint, messages)
          : buildChatBody(endpoint, messages),
      ),
      signal: controller.signal,
    });
    status = response.status;
    ok = response.ok;
    body = await response.text();
  } catch (error) {
    throw new Error(
      controller.signal.aborted
        ? `翻译请求超时（${endpoint.timeoutMs}ms，${url}）`
        : `翻译请求失败（${url}）：${describeError(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!ok) {
    throw new Error(`翻译 endpoint 返回 HTTP ${status}：${excerpt(body)}`);
  }
  let content: unknown;
  try {
    content = readResponseText(endpoint.protocol, JSON.parse(body));
  } catch {
    throw new Error(`翻译 endpoint 返回了无法解析的响应：${excerpt(body)}`);
  }
  if (typeof content !== "string" || content.length === 0) {
    throw new Error(`翻译 endpoint 没有返回文本：${excerpt(body)}`);
  }
  return content;
}

function reasoningEffortOf(endpoint: TranslationEndpoint): string | undefined {
  return endpoint.reasoningEffort === "default" ? undefined : endpoint.reasoningEffort;
}

function buildChatBody(
  endpoint: TranslationEndpoint,
  messages: readonly ChatMessage[],
): Record<string, unknown> {
  const effort = reasoningEffortOf(endpoint);
  return {
    model: endpoint.model,
    messages,
    temperature: 0,
    stream: false,
    ...(effort !== undefined ? { reasoning_effort: effort } : {}),
  };
}

/**
 * Responses 协议：system 合并进 instructions。不带 temperature（推理模型在该协议下会拒绝非默认值）；
 * `store: false` 让每次请求自包含，不在服务端留状态。
 */
function buildResponsesBody(
  endpoint: TranslationEndpoint,
  messages: readonly ChatMessage[],
): Record<string, unknown> {
  const effort = reasoningEffortOf(endpoint);
  const instructions = messages.filter((message) => message.role === "system").map((m) => m.content);
  const input = messages
    .filter((message) => message.role === "user")
    .map((message) => ({ role: "user", content: [{ type: "input_text", text: message.content }] }));
  return {
    model: endpoint.model,
    ...(instructions.length > 0 ? { instructions: instructions.join("\n\n") } : {}),
    input,
    stream: false,
    store: false,
    ...(effort !== undefined ? { reasoning: { effort } } : {}),
  };
}

interface ChatCompletionShape {
  choices?: Array<{ message?: { content?: unknown } }>;
}

interface ResponsesOutputShape {
  output?: Array<{ type?: unknown; content?: Array<{ type?: unknown; text?: unknown }> }>;
}

function readResponseText(protocol: TranslationEndpoint["protocol"], parsed: unknown): unknown {
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  if (protocol === "chat-completions") {
    return (parsed as ChatCompletionShape).choices?.[0]?.message?.content;
  }
  const output = (parsed as ResponsesOutputShape).output;
  if (!Array.isArray(output)) {
    return undefined;
  }
  let text = "";
  for (const item of output) {
    if (item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const part of item.content) {
      if (part.type === "output_text" && typeof part.text === "string") {
        text += part.text;
      }
    }
  }
  return text.length > 0 ? text : undefined;
}

function excerpt(body: string): string {
  const flattened = body.replace(/\s+/g, " ").trim();
  return flattened.length > 300 ? `${flattened.slice(0, 300)}…` : flattened;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
