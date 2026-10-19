// Derived from paseo-translate server/translate-batch.ts 与 shared/translate.ts; modified for AgentDeck
// 批量翻译（design.md 4.35）：多条原文用带 nonce 与序号的 <ti> 标签打包成一次请求，再按序号解析回来。

import { randomUUID } from "node:crypto";

import { wrapTranslationInput } from "./prompt-text.js";

/** 合并窗口：窗口内到达的同组请求共用一次 endpoint 调用 */
export const BATCH_COALESCE_MS = 80;
export const BATCH_MAX_ITEMS = 40;
export const BATCH_MAX_CHARS = 80_000;

/** 追加在单条系统提示词之后，说明多条打包的输入输出格式 */
export const BATCH_SYSTEM_ADDENDUM =
  'When the input contains one or more <ti n="..." i="..."> items, translate each item independently. Output ONLY those items, using the exact same n and i attribute values in the same order. Do not merge, omit, or add items. Everything between a matching pair of tags is the translation of that item; keep the tags themselves unchanged.';

function itemOpen(nonce: string, index: number): string {
  return `<ti n="${nonce}" i="${index}">`;
}

/** 闭合标签带同样的属性，原文里碰巧出现的 </ti> 不会提前结束一项 */
function itemClose(nonce: string, index: number): string {
  return `</ti n="${nonce}" i="${index}">`;
}

/** 选一个不出现在任何原文里的 nonce */
export function pickBatchNonce(texts: readonly string[]): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const nonce = randomUUID().replace(/-/g, "");
    if (texts.every((text) => !text.includes(nonce))) {
      return nonce;
    }
  }
  throw new Error("无法生成批量翻译 nonce");
}

export function wrapTranslationBatch(texts: readonly string[], nonce: string): string {
  return wrapTranslationInput(
    texts.map((text, index) => `${itemOpen(nonce, index)}\n${text}\n${itemClose(nonce, index)}`).join("\n"),
  );
}

/** 从模型输出里按序号取回 count 条译文；标签外的多余文字忽略；缺项 / 空项返回 null（调用方退回逐条） */
export function parseTranslationBatch(output: string, count: number, nonce: string): string[] | null {
  const results: string[] = [];
  let searchFrom = 0;
  for (let index = 0; index < count; index += 1) {
    const open = itemOpen(nonce, index);
    const close = itemClose(nonce, index);
    const start = output.indexOf(open, searchFrom);
    if (start < 0) {
      return null;
    }
    const contentStart = start + open.length;
    const end = output.indexOf(close, contentStart);
    if (end < 0) {
      return null;
    }
    let item = output.slice(contentStart, end);
    if (item.startsWith("\n")) item = item.slice(1);
    if (item.endsWith("\n")) item = item.slice(0, -1);
    if (item.trim().length === 0) {
      return null;
    }
    results.push(item);
    searchFrom = end + close.length;
  }
  return results;
}

/** 按输入顺序贪心分包；单条超过 maxChars 的自成一包 */
export function packTranslationBatches<T extends { text: string }>(
  items: readonly T[],
  options: { maxItems?: number; maxChars?: number } = {},
): T[][] {
  const maxItems = options.maxItems ?? BATCH_MAX_ITEMS;
  const maxChars = options.maxChars ?? BATCH_MAX_CHARS;
  const packs: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const item of items) {
    if (current.length > 0 && (current.length >= maxItems || chars + item.text.length > maxChars)) {
      packs.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += item.text.length;
  }
  if (current.length > 0) {
    packs.push(current);
  }
  return packs;
}
