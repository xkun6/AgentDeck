// Derived from paseo packages/relay/src/{crypto,encrypted-channel}.ts (Apache-2.0); modified for AgentDeck
import nacl from "tweetnacl";

import { utf8Decode, utf8Encode } from "./base64.js";

/** design.md 4.31：单帧明文上限 16 MiB */
export const MAX_PLAINTEXT_BYTES = 16 * 1024 * 1024;
export const NONCE_LENGTH = nacl.box.nonceLength;
const DIRECTION_OFFSET = 0;
const COUNTER_OFFSET = 16;
const COUNTER_MAX = (1n << 64n) - 1n;

/** 帧方向：nonce 第 0 字节 */
export type FrameDirection = "client_to_server" | "server_to_client";
export const DIRECTION_BYTE: Record<FrameDirection, number> = {
  client_to_server: 0x01,
  server_to_client: 0x02,
};

export type FrameErrorCode = "too_short" | "too_large" | "bad_direction" | "replay" | "decrypt_failed" | "bad_text";

export class FrameError extends Error {
  constructor(
    readonly code: FrameErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FrameError";
  }
}

/** nonce = 方向字节 || 15 个 0 || 大端 64 位计数（第 16–23 字节） */
export function buildNonce(direction: FrameDirection, counter: bigint): Uint8Array {
  if (counter < 1n || counter > COUNTER_MAX) {
    throw new RangeError("帧计数超出范围");
  }
  const nonce = new Uint8Array(NONCE_LENGTH);
  nonce[DIRECTION_OFFSET] = DIRECTION_BYTE[direction];
  new DataView(nonce.buffer).setBigUint64(COUNTER_OFFSET, counter, false);
  return nonce;
}

export function parseNonce(nonce: Uint8Array): { directionByte: number; counter: bigint } {
  return {
    directionByte: nonce[DIRECTION_OFFSET]!,
    counter: new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength).getBigUint64(COUNTER_OFFSET, false),
  };
}

/** 加密一帧：`nonce(24) || box.after(plaintext)`；调用方负责保证 counter 在该方向上严格递增 */
export function encryptFrame(
  sharedKey: Uint8Array,
  direction: FrameDirection,
  counter: bigint,
  plaintext: Uint8Array | string,
): Uint8Array {
  const bytes = typeof plaintext === "string" ? utf8Encode(plaintext) : plaintext;
  if (bytes.length > MAX_PLAINTEXT_BYTES) {
    throw new FrameError("too_large", "单帧明文超过 16 MiB");
  }
  const nonce = buildNonce(direction, counter);
  const sealed = nacl.box.after(bytes, nonce, sharedKey);
  const frame = new Uint8Array(NONCE_LENGTH + sealed.length);
  frame.set(nonce, 0);
  frame.set(sealed, NONCE_LENGTH);
  return frame;
}

/**
 * 解密一帧并校验方向与计数：计数必须大于 `lastCounter`，否则抛 `replay`。
 * 返回明文与本帧计数；调用方在成功后把 `lastCounter` 更新为该计数（见 `FrameReceiver`）。
 */
export function decryptFrame(
  sharedKey: Uint8Array,
  direction: FrameDirection,
  frame: Uint8Array,
  lastCounter = 0n,
): { plaintext: Uint8Array; counter: bigint } {
  if (frame.length < NONCE_LENGTH + nacl.box.overheadLength) {
    throw new FrameError("too_short", "密文帧过短");
  }
  if (frame.length - NONCE_LENGTH - nacl.box.overheadLength > MAX_PLAINTEXT_BYTES) {
    throw new FrameError("too_large", "单帧明文超过 16 MiB");
  }
  const nonce = frame.subarray(0, NONCE_LENGTH);
  const { directionByte, counter } = parseNonce(nonce);
  if (directionByte !== DIRECTION_BYTE[direction]) {
    throw new FrameError("bad_direction", "帧方向不符");
  }
  if (counter <= lastCounter) {
    throw new FrameError("replay", "帧计数未严格递增");
  }
  // 先认证再返回：伪造帧不会推进计数
  const plaintext = nacl.box.open.after(frame.subarray(NONCE_LENGTH), nonce, sharedKey);
  if (!plaintext) {
    throw new FrameError("decrypt_failed", "解密失败");
  }
  return { plaintext, counter };
}

/** 接收端：持有「上一个已接受的计数」，要求严格递增 */
export class FrameReceiver {
  private last = 0n;

  constructor(
    private readonly sharedKey: Uint8Array,
    private readonly direction: FrameDirection,
  ) {}

  open(frame: Uint8Array): Uint8Array {
    const { plaintext, counter } = decryptFrame(this.sharedKey, this.direction, frame, this.last);
    this.last = counter;
    return plaintext;
  }

  openText(frame: Uint8Array): string {
    const plaintext = this.open(frame);
    try {
      return utf8Decode(plaintext);
    } catch {
      throw new FrameError("bad_text", "明文不是合法的 UTF-8");
    }
  }
}

/** 发送端：计数从 1 开始自增 */
export class FrameSender {
  private counter = 0n;

  constructor(
    private readonly sharedKey: Uint8Array,
    private readonly direction: FrameDirection,
  ) {}

  seal(plaintext: Uint8Array | string): Uint8Array {
    const next = this.counter + 1n;
    const frame = encryptFrame(this.sharedKey, this.direction, next, plaintext);
    this.counter = next;
    return frame;
  }
}

/** 一条连接上一端的收发通道；role 决定发送与接收的方向 */
export class E2eeChannel {
  private readonly sender: FrameSender;
  private readonly receiver: FrameReceiver;

  constructor(sharedKey: Uint8Array, role: "client" | "server") {
    const sendDirection: FrameDirection = role === "client" ? "client_to_server" : "server_to_client";
    const receiveDirection: FrameDirection = role === "client" ? "server_to_client" : "client_to_server";
    this.sender = new FrameSender(sharedKey, sendDirection);
    this.receiver = new FrameReceiver(sharedKey, receiveDirection);
  }

  seal(plaintext: Uint8Array | string): Uint8Array {
    return this.sender.seal(plaintext);
  }

  /** 解密并按 UTF-8 解码（所有应用层消息都是 JSON 文本） */
  openText(frame: Uint8Array): string {
    return this.receiver.openText(frame);
  }
}
