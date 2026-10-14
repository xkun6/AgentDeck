import { describe, expect, test } from "vitest";

import { createRemoteClientSession, type RemoteClientSessionOptions } from "./client-session.js";
import { E2eeChannel } from "./frame.js";
import { deriveSharedKey, exportKey, generateKeyPair, importPublicKey, randomBytes } from "./keys.js";
import { parseClientAuthMessage, parseE2eeHello } from "./messages.js";
import type { RemoteConnectionOffer } from "./offer.js";
import { toBase64 } from "./base64.js";

/** 内存里的最小「服务端」：只实现握手这一侧，用于驱动客户端状态机 */
function createFakeServer() {
  const daemon = generateKeyPair();
  const challenge = toBase64(randomBytes(32));
  let channel: E2eeChannel | null = null;
  return {
    daemon,
    challenge,
    onHello(text: string): string {
      const hello = parseE2eeHello(text)!;
      channel = new E2eeChannel(deriveSharedKey(daemon.secretKey, importPublicKey(hello.clientKey)), "server");
      return JSON.stringify({ type: "e2ee_ready", v: 1, challenge });
    },
    open(frame: Uint8Array): string {
      return channel!.openText(frame);
    },
    seal(text: string): Uint8Array {
      return channel!.seal(text);
    },
  };
}

function setup(mode: "pair" | "auth") {
  const server = createFakeServer();
  const sent: Array<string | Uint8Array> = [];
  const events: string[] = [];
  const messages: string[] = [];
  const errors: Error[] = [];
  const offer: RemoteConnectionOffer = {
    v: 1,
    name: "pc",
    daemonPublicKey: exportKey(server.daemon.publicKey),
    addresses: [{ host: "192.168.1.2", port: 47631, kind: "lan" }],
    pairingSecret: "S".repeat(43),
    expiresAt: Date.now() + 1000,
  };
  const options: RemoteClientSessionOptions = {
    credentials:
      mode === "pair"
        ? { mode: "pair", offer, deviceName: "我的手机" }
        : { mode: "auth", daemonPublicKey: offer.daemonPublicKey, deviceId: "dev1", deviceSecret: "sec1" },
    send: (data) => sent.push(data),
    onMessage: (text) => messages.push(text),
    onPaired: (r) => events.push(`paired:${r.deviceId}:${r.deviceSecret}`),
    onAuthed: (r) => events.push(`authed:${r.name}`),
    onAuthFailed: (reason) => events.push(`failed:${reason}`),
    onProtocolError: (error) => errors.push(error),
  };
  const session = createRemoteClientSession(options);
  return { server, session, sent, events, messages, errors };
}

/** 跑完 hello → ready，返回客户端发出的第一条加密消息（已解析） */
function handshake(ctx: ReturnType<typeof setup>) {
  ctx.session.start();
  const ready = ctx.server.onHello(ctx.sent[0] as string);
  ctx.session.handleFrame(ready);
  return JSON.parse(ctx.server.open(ctx.sent[1] as Uint8Array)) as Record<string, unknown>;
}

describe("客户端握手状态机", () => {
  test("配对：hello → ready → pair（带 challenge 与 pairingSecret）→ paired → 可收发业务消息", () => {
    const ctx = setup("pair");
    expect(ctx.session.state).toBe("idle");
    const first = handshake(ctx);
    expect(parseE2eeHello(ctx.sent[0] as string)?.v).toBe(1);
    expect(first).toEqual({
      type: "pair",
      pairingSecret: "S".repeat(43),
      challenge: ctx.server.challenge,
      deviceName: "我的手机",
    });
    expect(parseClientAuthMessage(JSON.stringify(first))?.type).toBe("pair");
    expect(ctx.session.state).toBe("awaiting_auth");

    ctx.session.handleFrame(ctx.server.seal(JSON.stringify({ type: "paired", deviceId: "d1", deviceSecret: "s1" })));
    expect(ctx.events).toEqual(["paired:d1:s1"]);
    expect(ctx.session.state).toBe("ready");

    ctx.session.handleFrame(ctx.server.seal('{"jsonrpc":"2.0","method":"agent.state","params":{}}'));
    expect(ctx.messages).toEqual(['{"jsonrpc":"2.0","method":"agent.state","params":{}}']);

    ctx.session.sendText('{"jsonrpc":"2.0","id":1,"method":"agent.list"}');
    expect(ctx.server.open(ctx.sent[2] as Uint8Array)).toBe('{"jsonrpc":"2.0","id":1,"method":"agent.list"}');
  });

  test("认证：发出 auth（deviceId / deviceSecret / challenge），收到 authed 后就绪", () => {
    const ctx = setup("auth");
    const first = handshake(ctx);
    expect(first).toEqual({ type: "auth", deviceId: "dev1", deviceSecret: "sec1", challenge: ctx.server.challenge });
    ctx.session.handleFrame(ctx.server.seal(JSON.stringify({ type: "authed", name: "我的电脑" })));
    expect(ctx.events).toEqual(["authed:我的电脑"]);
    expect(ctx.session.state).toBe("ready");
  });

  test.each(["expired", "invalid", "revoked"] as const)("auth_failed(%s) 通知调用方", (reason) => {
    const ctx = setup("auth");
    handshake(ctx);
    ctx.session.handleFrame(ctx.server.seal(JSON.stringify({ type: "auth_failed", reason })));
    expect(ctx.events).toEqual([`failed:${reason}`]);
    expect(ctx.session.state).toBe("failed");
    expect(ctx.errors).toEqual([]);
  });

  test("就绪前不能发送业务消息", () => {
    const ctx = setup("auth");
    ctx.session.start();
    expect(() => ctx.session.sendText("{}")).toThrow();
  });

  test("ready 不是文本帧 / 内容非法 → 协议错误", () => {
    const a = setup("auth");
    a.session.start();
    a.session.handleFrame(new Uint8Array(5));
    expect(a.errors).toHaveLength(1);

    const b = setup("auth");
    b.session.start();
    b.session.handleFrame('{"type":"e2ee_ready","v":1}');
    expect(b.errors).toHaveLength(1);
  });

  test("服务端公钥与 offer 不符时无法解出认证回复", () => {
    const ctx = setup("auth");
    ctx.session.start();
    // 假冒的服务端使用另一把密钥
    const impostor = createFakeServer();
    ctx.session.handleFrame(impostor.onHello(ctx.sent[0] as string));
    const reply = impostor.seal(JSON.stringify({ type: "authed", name: "evil" }));
    ctx.session.handleFrame(reply);
    expect(ctx.events).toEqual([]);
    expect(ctx.errors).toHaveLength(1);
  });

  test("认证后收到文本帧 / 计数回退的帧 → 协议错误", () => {
    const ctx = setup("auth");
    handshake(ctx);
    const authed = ctx.server.seal(JSON.stringify({ type: "authed", name: "pc" }));
    ctx.session.handleFrame(authed);
    ctx.session.handleFrame(authed); // 重放
    expect(ctx.errors).toHaveLength(1);
    expect(ctx.session.state).toBe("failed");

    const other = setup("auth");
    handshake(other);
    other.session.handleFrame(other.server.seal(JSON.stringify({ type: "authed", name: "pc" })));
    other.session.handleFrame("plain text");
    expect(other.errors).toHaveLength(1);
  });

  test("认证回复格式非法 → 协议错误", () => {
    const ctx = setup("auth");
    handshake(ctx);
    ctx.session.handleFrame(ctx.server.seal('{"type":"weird"}'));
    expect(ctx.errors).toHaveLength(1);
  });

  test("发出的握手首帧不含明文密钥材料", () => {
    const ctx = setup("pair");
    ctx.session.start();
    ctx.session.handleFrame(ctx.server.onHello(ctx.sent[0] as string));
    const frame = ctx.sent[1] as Uint8Array;
    expect(Buffer.from(frame).includes(Buffer.from("S".repeat(43)))).toBe(false);
  });
});
