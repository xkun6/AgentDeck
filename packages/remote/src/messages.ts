// 握手消息（design.md 4.31）。hello / ready 是明文文本帧，其余为加密后的 JSON。

export interface E2eeHello {
  type: "e2ee_hello";
  v: 1;
  /** 客户端本次连接新生成的 nacl.box 公钥（base64） */
  clientKey: string;
}

export interface E2eeReady {
  type: "e2ee_ready";
  v: 1;
  /** 32 字节随机数（base64） */
  challenge: string;
}

export interface PairMessage {
  type: "pair";
  pairingSecret: string;
  challenge: string;
  deviceName: string;
}

export interface PairedMessage {
  type: "paired";
  deviceId: string;
  deviceSecret: string;
}

export interface AuthMessage {
  type: "auth";
  deviceId: string;
  deviceSecret: string;
  challenge: string;
}

export interface AuthedMessage {
  type: "authed";
  name: string;
}

export type AuthFailedReason = "expired" | "invalid" | "revoked";

export interface AuthFailedMessage {
  type: "auth_failed";
  reason: AuthFailedReason;
}

/** 握手阶段客户端发出的第一条加密消息 */
export type ClientAuthMessage = PairMessage | AuthMessage;
/** 服务端对第一条加密消息的回复 */
export type ServerAuthReply = PairedMessage | AuthedMessage | AuthFailedMessage;

export const DEVICE_NAME_MAX_LENGTH = 100;

function parseObject(text: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parseE2eeHello(text: string): E2eeHello | null {
  const obj = parseObject(text);
  if (!obj || obj.type !== "e2ee_hello" || obj.v !== 1 || !isNonEmptyString(obj.clientKey)) {
    return null;
  }
  return { type: "e2ee_hello", v: 1, clientKey: obj.clientKey };
}

export function parseE2eeReady(text: string): E2eeReady | null {
  const obj = parseObject(text);
  if (!obj || obj.type !== "e2ee_ready" || obj.v !== 1 || !isNonEmptyString(obj.challenge)) {
    return null;
  }
  return { type: "e2ee_ready", v: 1, challenge: obj.challenge };
}

/** 服务端用：解析客户端第一条加密消息；格式不符返回 null */
export function parseClientAuthMessage(text: string): ClientAuthMessage | null {
  const obj = parseObject(text);
  if (!obj) {
    return null;
  }
  if (
    obj.type === "pair" &&
    isNonEmptyString(obj.pairingSecret) &&
    isString(obj.challenge) &&
    isNonEmptyString(obj.deviceName)
  ) {
    return {
      type: "pair",
      pairingSecret: obj.pairingSecret,
      challenge: obj.challenge,
      deviceName: obj.deviceName.slice(0, DEVICE_NAME_MAX_LENGTH),
    };
  }
  if (
    obj.type === "auth" &&
    isNonEmptyString(obj.deviceId) &&
    isNonEmptyString(obj.deviceSecret) &&
    isString(obj.challenge)
  ) {
    return {
      type: "auth",
      deviceId: obj.deviceId,
      deviceSecret: obj.deviceSecret,
      challenge: obj.challenge,
    };
  }
  return null;
}

/** 客户端用：解析服务端对认证的回复；格式不符返回 null */
export function parseServerAuthReply(text: string): ServerAuthReply | null {
  const obj = parseObject(text);
  if (!obj) {
    return null;
  }
  if (obj.type === "paired" && isNonEmptyString(obj.deviceId) && isNonEmptyString(obj.deviceSecret)) {
    return { type: "paired", deviceId: obj.deviceId, deviceSecret: obj.deviceSecret };
  }
  if (obj.type === "authed" && isString(obj.name)) {
    return { type: "authed", name: obj.name };
  }
  if (
    obj.type === "auth_failed" &&
    (obj.reason === "expired" || obj.reason === "invalid" || obj.reason === "revoked")
  ) {
    return { type: "auth_failed", reason: obj.reason };
  }
  return null;
}
