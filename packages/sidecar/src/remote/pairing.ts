import { randomBytes, timingSafeEqual } from "node:crypto";

import { sha256Hex } from "./store.js";

export const PAIRING_TTL_MS = 5 * 60 * 1000;

export type PairingResult = "ok" | "expired" | "invalid";

interface ActivePairing {
  digest: Buffer;
  expiresAt: number;
  consumed: boolean;
}

/**
 * 一次性配对密钥（design.md 4.31）：同一时刻只有一个有效 pairingSecret，新签发即作废旧的；
 * 使用一次或过期即失效。只保存哈希。
 */
export class PairingManager {
  private active: ActivePairing | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = PAIRING_TTL_MS,
  ) {}

  /** 签发新密钥（32 字节随机，base64url），作废之前的 */
  issue(): { pairingSecret: string; expiresAt: number } {
    const pairingSecret = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + this.ttlMs;
    this.active = { digest: Buffer.from(sha256Hex(pairingSecret), "hex"), expiresAt, consumed: false };
    return { pairingSecret, expiresAt };
  }

  /**
   * 校验并消耗：成功后立即失效；已使用、被新签发作废或从未签发的都是 invalid，
   * 只有「当前这把」且超时才是 expired。
   */
  consume(pairingSecret: string): PairingResult {
    const active = this.active;
    if (!active || active.consumed) {
      return "invalid";
    }
    const candidate = Buffer.from(sha256Hex(pairingSecret), "hex");
    if (!timingSafeEqual(candidate, active.digest)) {
      return "invalid";
    }
    if (this.now() > active.expiresAt) {
      this.active = null;
      return "expired";
    }
    active.consumed = true;
    return "ok";
  }

  /** 网关关闭时丢弃未使用的密钥 */
  clear(): void {
    this.active = null;
  }
}
