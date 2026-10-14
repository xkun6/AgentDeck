import { describe, expect, test } from "vitest";

import { utf8Encode } from "./base64.js";
import {
  buildNonce,
  decryptFrame,
  E2eeChannel,
  encryptFrame,
  FrameError,
  FrameReceiver,
  FrameSender,
  MAX_PLAINTEXT_BYTES,
  parseNonce,
} from "./frame.js";
import { deriveSharedKey, generateKeyPair } from "./keys.js";

function sharedPair() {
  const a = generateKeyPair();
  const b = generateKeyPair();
  return { client: deriveSharedKey(a.secretKey, b.publicKey), server: deriveSharedKey(b.secretKey, a.publicKey) };
}

function expectFrameError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(FrameError);
    expect((error as FrameError).code).toBe(code);
    return;
  }
  throw new Error("预期抛出 FrameError");
}

describe("nonce", () => {
  test("方向字节在第 0 位，大端计数在第 16–23 字节，其余为 0", () => {
    const nonce = buildNonce("client_to_server", 0x0102030405060708n);
    expect(nonce[0]).toBe(0x01);
    expect(Array.from(nonce.subarray(1, 16))).toEqual(new Array(15).fill(0));
    expect(Array.from(nonce.subarray(16))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(buildNonce("server_to_client", 1n)[0]).toBe(0x02);
    expect(parseNonce(nonce)).toEqual({ directionByte: 1, counter: 0x0102030405060708n });
  });

  test("计数必须在 1 到 2^64-1 之间", () => {
    expect(() => buildNonce("client_to_server", 0n)).toThrow(RangeError);
    expect(() => buildNonce("client_to_server", 1n << 64n)).toThrow(RangeError);
  });
});

describe("帧加解密", () => {
  test("往返：文本与二进制明文", () => {
    const { client, server } = sharedPair();
    const sender = new FrameSender(client, "client_to_server");
    const receiver = new FrameReceiver(server, "client_to_server");
    expect(receiver.openText(sender.seal('{"a":"你好"}'))).toBe('{"a":"你好"}');
    expect(Array.from(receiver.open(sender.seal(new Uint8Array([1, 2, 3]))))).toEqual([1, 2, 3]);
  });

  test("双向通道互通，且两个方向各自计数", () => {
    const { client, server } = sharedPair();
    const c = new E2eeChannel(client, "client");
    const s = new E2eeChannel(server, "server");
    expect(s.openText(c.seal("ping"))).toBe("ping");
    expect(c.openText(s.seal("pong"))).toBe("pong");
    expect(s.openText(c.seal("ping2"))).toBe("ping2");
  });

  test("帧格式为 nonce(24) || 密文，nonce 里带方向与递增计数", () => {
    const { client } = sharedPair();
    const sender = new FrameSender(client, "client_to_server");
    const first = sender.seal("a");
    const second = sender.seal("b");
    expect(parseNonce(first.subarray(0, 24))).toEqual({ directionByte: 1, counter: 1n });
    expect(parseNonce(second.subarray(0, 24))).toEqual({ directionByte: 1, counter: 2n });
    expect(first.length).toBe(24 + 16 + 1);
  });

  test("计数回退被拒（重放同一帧）", () => {
    const { client, server } = sharedPair();
    const sender = new FrameSender(client, "client_to_server");
    const receiver = new FrameReceiver(server, "client_to_server");
    const frame = sender.seal("x");
    receiver.open(frame);
    expectFrameError(() => receiver.open(frame), "replay");
  });

  test("先收到较大计数后，较小计数被拒；允许跳号", () => {
    const { client, server } = sharedPair();
    const receiver = new FrameReceiver(server, "client_to_server");
    receiver.open(encryptFrame(client, "client_to_server", 5n, "five"));
    expectFrameError(() => receiver.open(encryptFrame(client, "client_to_server", 3n, "three")), "replay");
    expectFrameError(() => receiver.open(encryptFrame(client, "client_to_server", 5n, "again")), "replay");
    expect(receiver.openText(encryptFrame(client, "client_to_server", 9n, "nine"))).toBe("nine");
  });

  test("篡改密文被拒，且不推进计数", () => {
    const { client, server } = sharedPair();
    const sender = new FrameSender(client, "client_to_server");
    const receiver = new FrameReceiver(server, "client_to_server");
    const frame = sender.seal("secret");
    const tampered = frame.slice();
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    expectFrameError(() => receiver.open(tampered), "decrypt_failed");
    // 篡改帧不能耗掉这个计数：原帧仍可正常接收
    expect(receiver.openText(frame)).toBe("secret");
  });

  test("篡改 nonce 计数被拒", () => {
    const { client, server } = sharedPair();
    const frame = encryptFrame(client, "client_to_server", 1n, "x");
    const tampered = frame.slice();
    tampered[23] = 7;
    expectFrameError(() => decryptFrame(server, "client_to_server", tampered), "decrypt_failed");
  });

  test("方向不符被拒（反射攻击）", () => {
    const { client, server } = sharedPair();
    const frame = encryptFrame(client, "client_to_server", 1n, "x");
    expectFrameError(() => decryptFrame(server, "server_to_client", frame), "bad_direction");
  });

  test("错误的共享密钥无法解密", () => {
    const { client } = sharedPair();
    const other = sharedPair().server;
    const frame = encryptFrame(client, "client_to_server", 1n, "x");
    expectFrameError(() => decryptFrame(other, "client_to_server", frame), "decrypt_failed");
  });

  test("过短的帧被拒", () => {
    const { server } = sharedPair();
    expectFrameError(() => decryptFrame(server, "client_to_server", new Uint8Array(10)), "too_short");
  });

  test("明文超过 16 MiB 被拒（加密端与解密端）", () => {
    const { client, server } = sharedPair();
    expectFrameError(
      () => encryptFrame(client, "client_to_server", 1n, new Uint8Array(MAX_PLAINTEXT_BYTES + 1)),
      "too_large",
    );
    const justFits = encryptFrame(client, "client_to_server", 1n, new Uint8Array(MAX_PLAINTEXT_BYTES));
    expect(decryptFrame(server, "client_to_server", justFits).plaintext.length).toBe(MAX_PLAINTEXT_BYTES);
    expectFrameError(() => decryptFrame(server, "client_to_server", new Uint8Array(24 + 16 + MAX_PLAINTEXT_BYTES + 1)), "too_large");
  });

  test("明文不是合法 UTF-8 时 openText 报 bad_text", () => {
    const { client, server } = sharedPair();
    const receiver = new FrameReceiver(server, "client_to_server");
    expectFrameError(
      () => receiver.openText(encryptFrame(client, "client_to_server", 1n, new Uint8Array([0xff, 0xfe]))),
      "bad_text",
    );
  });

  test("小阶公钥（全零）被拒绝派生共享密钥", () => {
    const { secretKey } = generateKeyPair();
    expect(() => deriveSharedKey(secretKey, new Uint8Array(32))).toThrow();
  });

  test("字符串与字节明文等价", () => {
    const { client, server } = sharedPair();
    const frame = encryptFrame(client, "client_to_server", 1n, utf8Encode("abc"));
    expect(new TextDecoder().decode(decryptFrame(server, "client_to_server", frame).plaintext)).toBe("abc");
  });
});
