// Derived from paseo packages/server/src/server/agent/providers/acp-agent.ts (Apache-2.0); modified for AgentDeck
// 改动：直接包装 Node 流（不经 Readable.toWeb），stdout 结束/出错时关闭可读端，写入失败时拒绝而非抛未处理异常。
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";

import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";

import type { Logger } from "../../logger.js";

/**
 * 容错的 NDJSON 流：
 * - 忽略非 JSON 行（部分 CLI 会往 stdout 打印横幅/日志）；
 * - 响应里的字符串数字 id 转成数字（部分 agent 把 id 回成 "1"，SDK 按数字匹配）。
 */
export function createTolerantNdJsonStream(
  input: Readable,
  output: Writable,
  options: { logger: Logger; provider: string },
): Stream {
  const { logger, provider } = options;

  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      const decoder = new StringDecoder("utf8");
      let buffer = "";
      let closed = false;

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }
        let message: AnyMessage;
        try {
          message = JSON.parse(trimmed) as AnyMessage;
        } catch {
          logger.warn("[%s] ACP stdout 输出了非 JSON 行，已忽略：%s", provider, trimmed.slice(0, 200));
          return;
        }
        if (message === null || typeof message !== "object") {
          logger.warn("[%s] ACP stdout 输出了非对象 JSON，已忽略", provider);
          return;
        }
        controller.enqueue(normalizeIncomingMessage(message));
      };

      const finish = () => {
        if (closed) {
          return;
        }
        closed = true;
        buffer += decoder.end();
        if (buffer) {
          handleLine(buffer);
          buffer = "";
        }
        controller.close();
      };

      input.on("data", (chunk: Buffer | string) => {
        if (closed) {
          return;
        }
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          handleLine(line);
        }
      });
      input.once("end", finish);
      input.once("close", finish);
      input.once("error", (error) => {
        logger.warn("[%s] 读取 ACP stdout 出错：%s", provider, String(error));
        finish();
      });
    },
  });

  output.on("error", (error) => {
    logger.warn("[%s] 写入 ACP stdin 出错：%s", provider, String(error));
  });

  const writable = new WritableStream<AnyMessage>({
    write(message) {
      return new Promise<void>((resolve, reject) => {
        if (output.destroyed || output.writableEnded) {
          reject(new Error("ACP agent 的 stdin 已关闭"));
          return;
        }
        output.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  });

  return { readable, writable };
}

function normalizeIncomingMessage(message: AnyMessage): AnyMessage {
  if (
    "id" in message &&
    !("method" in message) &&
    typeof message.id === "string" &&
    /^\d+$/.test(message.id)
  ) {
    const numericId = Number(message.id);
    if (Number.isSafeInteger(numericId)) {
      return { ...message, id: numericId } as AnyMessage;
    }
  }
  return message;
}
