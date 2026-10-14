// Derived from paseo packages/relay/src/encrypted-channel.ts (Apache-2.0); modified for AgentDeck
import { utf8Encode } from "./base64.js";
import { E2eeChannel, FrameError } from "./frame.js";
import { deriveSharedKey, exportKey, generateKeyPair, importPublicKey, type KeyPair } from "./keys.js";
import {
  parseE2eeReady,
  parseServerAuthReply,
  type AuthFailedReason,
  type AuthMessage,
  type E2eeHello,
  type PairMessage,
} from "./messages.js";
import type { RemoteConnectionOffer } from "./offer.js";

export type RemoteClientCredentials =
  /** 首次配对：用二维码里的 offer */
  | { mode: "pair"; offer: RemoteConnectionOffer; deviceName: string }
  /** 已配对设备：用保存的凭据重新认证 */
  | { mode: "auth"; daemonPublicKey: string; deviceId: string; deviceSecret: string };

export interface RemoteClientSessionOptions {
  credentials: RemoteClientCredentials;
  /** 底层 socket 发送：握手前两条是文本，之后全是二进制 */
  send(data: string | Uint8Array): void;
  /** 认证成功后收到的每条 JSON 文本（已解密） */
  onMessage(text: string): void;
  /** 配对成功：调用方必须保存 deviceId / deviceSecret（deviceSecret 只出现这一次） */
  onPaired?(result: { deviceId: string; deviceSecret: string }): void;
  /** 认证成功（已配对设备重连） */
  onAuthed?(info: { name: string }): void;
  /** 服务端拒绝认证；调用方应关闭连接（expired 提示重新扫码，revoked 清除凭据） */
  onAuthFailed?(reason: AuthFailedReason): void;
  /** 协议违规（非法帧、解密失败、计数回退等）；调用方应关闭连接 */
  onProtocolError(error: Error): void;
  /** 测试用：固定本次连接的临时密钥对 */
  keyPair?: KeyPair;
}

export type RemoteClientState = "idle" | "awaiting_ready" | "awaiting_auth" | "ready" | "failed";

export interface RemoteClientSession {
  readonly state: RemoteClientState;
  /** 连接建立后调用一次：发出 e2ee_hello */
  start(): void;
  /** 把底层 socket 收到的帧交进来 */
  handleFrame(data: string | Uint8Array): void;
  /** 认证成功后发送一条 JSON 文本；未就绪时抛错 */
  sendText(text: string): void;
}

/**
 * 客户端握手状态机（design.md 4.31）：hello → ready → 加密的 pair / auth → paired / authed。
 * 与传输无关：不碰 WebSocket，只通过 `send` / `handleFrame` 收发，Node 与 WebView 通用。
 */
export function createRemoteClientSession(options: RemoteClientSessionOptions): RemoteClientSession {
  const keyPair = options.keyPair ?? generateKeyPair();
  const { credentials } = options;
  let state: RemoteClientState = "idle";
  let channel: E2eeChannel | null = null;

  const fail = (error: Error): void => {
    if (state === "failed") {
      return;
    }
    state = "failed";
    options.onProtocolError(error);
  };

  const daemonPublicKey = credentials.mode === "pair" ? credentials.offer.daemonPublicKey : credentials.daemonPublicKey;

  const onReady = (text: string): void => {
    const ready = parseE2eeReady(text);
    if (!ready) {
      fail(new Error("握手失败：e2ee_ready 非法"));
      return;
    }
    try {
      channel = new E2eeChannel(deriveSharedKey(keyPair.secretKey, importPublicKey(daemonPublicKey)), "client");
      const first: PairMessage | AuthMessage =
        credentials.mode === "pair"
          ? {
              type: "pair",
              pairingSecret: credentials.offer.pairingSecret,
              challenge: ready.challenge,
              deviceName: credentials.deviceName,
            }
          : {
              type: "auth",
              deviceId: credentials.deviceId,
              deviceSecret: credentials.deviceSecret,
              challenge: ready.challenge,
            };
      state = "awaiting_auth";
      options.send(channel.seal(JSON.stringify(first)));
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const onEncrypted = (frame: Uint8Array): void => {
    let text: string;
    try {
      text = channel!.openText(frame);
    } catch (error) {
      fail(error instanceof FrameError ? error : new Error(String(error)));
      return;
    }
    if (state === "awaiting_auth") {
      const reply = parseServerAuthReply(text);
      if (!reply) {
        fail(new Error("握手失败：认证回复非法"));
        return;
      }
      if (reply.type === "auth_failed") {
        state = "failed";
        options.onAuthFailed?.(reply.reason);
        return;
      }
      state = "ready";
      if (reply.type === "paired") {
        options.onPaired?.({ deviceId: reply.deviceId, deviceSecret: reply.deviceSecret });
      } else {
        options.onAuthed?.({ name: reply.name });
      }
      return;
    }
    options.onMessage(text);
  };

  return {
    get state() {
      return state;
    },
    start() {
      if (state !== "idle") {
        return;
      }
      state = "awaiting_ready";
      const hello: E2eeHello = { type: "e2ee_hello", v: 1, clientKey: exportKey(keyPair.publicKey) };
      options.send(JSON.stringify(hello));
    },
    handleFrame(data) {
      if (state === "failed" || state === "idle") {
        return;
      }
      if (state === "awaiting_ready") {
        if (typeof data !== "string") {
          fail(new Error("握手失败：应收到文本帧 e2ee_ready"));
          return;
        }
        onReady(data);
        return;
      }
      if (typeof data === "string") {
        fail(new Error("协议违规：握手后只允许二进制帧"));
        return;
      }
      onEncrypted(data);
    },
    sendText(text) {
      if (state !== "ready" || !channel) {
        throw new Error("远程连接尚未认证");
      }
      options.send(channel.seal(utf8Encode(text)));
    },
  };
}
