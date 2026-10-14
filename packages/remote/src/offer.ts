// Derived from paseo packages/protocol/src/connection-offer.ts (Apache-2.0); modified for AgentDeck
import { fromBase64, fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from "./base64.js";

export const OFFER_URL_PREFIX = "agentdeck://pair#";
const PUBLIC_KEY_BYTES = 32;
const MAX_ADDRESSES = 16;
const NAME_MAX_LENGTH = 200;

export interface RemoteOfferAddress {
  host: string;
  port: number;
  kind: "lan" | "tailscale";
}

/** design.md 4.31：二维码里的配对信息 */
export interface RemoteConnectionOffer {
  v: 1;
  name: string;
  daemonPublicKey: string;
  addresses: RemoteOfferAddress[];
  pairingSecret: string;
  expiresAt: number;
}

export class OfferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfferError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 校验未知输入是否为合法 offer；非法抛 OfferError（含具体字段） */
export function validateOffer(value: unknown): RemoteConnectionOffer {
  if (!isRecord(value)) {
    throw new OfferError("配对信息不是对象");
  }
  if (value.v !== 1) {
    throw new OfferError("不支持的配对信息版本");
  }
  const { name, daemonPublicKey, addresses, pairingSecret, expiresAt } = value;
  if (typeof name !== "string" || name.length === 0 || name.length > NAME_MAX_LENGTH) {
    throw new OfferError("name 非法");
  }
  if (typeof daemonPublicKey !== "string") {
    throw new OfferError("daemonPublicKey 非法");
  }
  try {
    if (fromBase64(daemonPublicKey).length !== PUBLIC_KEY_BYTES) {
      throw new Error("长度");
    }
  } catch {
    throw new OfferError("daemonPublicKey 非法");
  }
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > MAX_ADDRESSES) {
    throw new OfferError("addresses 非法");
  }
  const parsedAddresses: RemoteOfferAddress[] = addresses.map((item, index) => {
    if (
      !isRecord(item) ||
      typeof item.host !== "string" ||
      item.host.length === 0 ||
      item.host.length > 255 ||
      /[\s/?#@]/.test(item.host) ||
      typeof item.port !== "number" ||
      !Number.isInteger(item.port) ||
      item.port < 1 ||
      item.port > 65_535 ||
      (item.kind !== "lan" && item.kind !== "tailscale")
    ) {
      throw new OfferError(`addresses[${index}] 非法`);
    }
    return { host: item.host, port: item.port, kind: item.kind };
  });
  if (typeof pairingSecret !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(pairingSecret)) {
    throw new OfferError("pairingSecret 非法");
  }
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    throw new OfferError("expiresAt 非法");
  }
  return { v: 1, name, daemonPublicKey, addresses: parsedAddresses, pairingSecret, expiresAt };
}

export function encodeOfferUrl(offer: RemoteConnectionOffer): string {
  return OFFER_URL_PREFIX + toBase64Url(utf8Encode(JSON.stringify(validateOffer(offer))));
}

/** 解码 `agentdeck://pair#<base64url(JSON)>`；前缀不符、编码损坏或字段非法一律抛 OfferError */
export function decodeOfferUrl(url: string): RemoteConnectionOffer {
  const trimmed = url.trim();
  if (!trimmed.startsWith(OFFER_URL_PREFIX)) {
    throw new OfferError("不是 AgentDeck 配对链接");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(fromBase64Url(trimmed.slice(OFFER_URL_PREFIX.length))));
  } catch {
    throw new OfferError("配对链接已损坏");
  }
  return validateOffer(parsed);
}
