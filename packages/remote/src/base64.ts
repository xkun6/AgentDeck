// 纯 TS 的 base64 / base64url 编解码：不依赖 Buffer、atob 或 node: 模块，Node 与 WebView 通用。

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) {
    table[ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += `${ALPHABET[(n >> 18) & 63]!}${ALPHABET[(n >> 12) & 63]!}==`;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += `${ALPHABET[(n >> 18) & 63]!}${ALPHABET[(n >> 12) & 63]!}${ALPHABET[(n >> 6) & 63]!}=`;
  }
  return out;
}

/** 严格解码标准 base64（带 = 填充）；非法字符、长度或非规范填充位一律抛错 */
export function fromBase64(text: string): Uint8Array {
  if (typeof text !== "string" || text.length % 4 !== 0) {
    throw new Error("非法的 base64");
  }
  let pad = 0;
  if (text.endsWith("==")) {
    pad = 2;
  } else if (text.endsWith("=")) {
    pad = 1;
  }
  const dataLength = text.length - pad;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    let n = 0;
    for (let j = 0; j < 4; j++) {
      const index = i + j;
      let value = 0;
      if (index < dataLength) {
        const code = text.charCodeAt(index);
        value = code < 128 ? LOOKUP[code]! : -1;
        if (value < 0) {
          throw new Error("非法的 base64");
        }
      }
      n = (n << 6) | value;
    }
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  // 拒绝非规范编码（末尾多余的填充位不为 0）
  if (toBase64(out) !== text) {
    throw new Error("非法的 base64");
  }
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
    throw new Error("非法的 base64url");
  }
  const standard = text.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(standard + "=".repeat((4 - (standard.length % 4)) % 4));
}

export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
