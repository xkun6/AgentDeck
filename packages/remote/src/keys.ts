// Derived from paseo packages/relay/src/crypto.ts (Apache-2.0); modified for AgentDeck
import nacl from "tweetnacl";

import { fromBase64, toBase64 } from "./base64.js";

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

let prngReady = false;

/** tweetnacl 在浏览器 / WebView 里依赖 self.crypto；不可用时回退到 globalThis.crypto.getRandomValues */
function ensurePrng(): void {
  if (prngReady) {
    return;
  }
  try {
    nacl.randomBytes(1);
    prngReady = true;
    return;
  } catch {
    // 回退
  }
  const cryptoObj = (globalThis as { crypto?: { getRandomValues?(array: Uint8Array): Uint8Array } }).crypto;
  if (cryptoObj?.getRandomValues) {
    nacl.setPRNG((x, n) => {
      const buf = new Uint8Array(n);
      cryptoObj.getRandomValues!(buf);
      x.set(buf, 0);
    });
    prngReady = true;
    return;
  }
  throw new Error("没有可用的安全随机数源（缺少 crypto.getRandomValues）");
}

export function randomBytes(length: number): Uint8Array {
  ensurePrng();
  return nacl.randomBytes(length);
}

export function generateKeyPair(): KeyPair {
  ensurePrng();
  const { publicKey, secretKey } = nacl.box.keyPair();
  return { publicKey, secretKey };
}

export function importPublicKey(base64: string): Uint8Array {
  const bytes = fromBase64(base64);
  if (bytes.length !== nacl.box.publicKeyLength) {
    throw new Error(`公钥长度非法（应为 ${nacl.box.publicKeyLength} 字节）`);
  }
  return bytes;
}

export function importSecretKey(base64: string): Uint8Array {
  const bytes = fromBase64(base64);
  if (bytes.length !== nacl.box.secretKeyLength) {
    throw new Error(`私钥长度非法（应为 ${nacl.box.secretKeyLength} 字节）`);
  }
  return bytes;
}

export function exportKey(key: Uint8Array): string {
  return toBase64(key);
}

/** 对方公钥为小阶点时 X25519 结果全零，拒绝 */
export function deriveSharedKey(ourSecretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  if (ourSecretKey.length !== nacl.box.secretKeyLength) {
    throw new Error("私钥长度非法");
  }
  if (peerPublicKey.length !== nacl.box.publicKeyLength) {
    throw new Error("对方公钥长度非法");
  }
  const raw = nacl.scalarMult(ourSecretKey, peerPublicKey);
  const isZero = nacl.verify(raw, new Uint8Array(nacl.box.sharedKeyLength));
  raw.fill(0);
  if (isZero) {
    throw new Error("对方公钥非法");
  }
  return nacl.box.before(peerPublicKey, ourSecretKey);
}
