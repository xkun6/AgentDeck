// 配对流程（design.md 4.31）：解析 agentdeck://pair#...（也接受整段粘贴文本）→ 连接电脑发送 pair →
// 拿到 deviceId / deviceSecret → 组装 PairedHost（由调用方存入 HostStore）。
import { decodeOfferUrl, OFFER_URL_PREFIX, OfferError, type AuthFailedReason, type RemoteConnectionOffer } from "@agentdeck/remote";
import { E2EE_AUTH_FAILED_CLOSE_CODE, E2eeSocket, type E2eeSocketOptions } from "./e2ee-socket";
import type { PairedHost } from "./hosts";

/** 带用户可读中文说明的配对错误 */
export class PairingError extends Error {
  constructor(
    message: string,
    readonly kind: "link" | "expired" | "invalid" | "network",
  ) {
    super(message);
    this.name = "PairingError";
  }
}

export const AUTH_FAILED_MESSAGES: Record<AuthFailedReason, string> = {
  expired: "配对二维码已过期，请在电脑上重新生成",
  invalid: "配对码无效或已被使用，请在电脑上重新生成",
  revoked: "此设备已在电脑上被吊销，请重新配对",
};

const LINK_PATTERN = /agentdeck:\/\/pair#[A-Za-z0-9_-]+/;

/** 从用户粘贴 / 扫码得到的文本里取出配对链接并解析；失败抛 PairingError */
export function parsePairingInput(input: string, now: number = Date.now()): RemoteConnectionOffer {
  const link = LINK_PATTERN.exec(input)?.[0];
  if (!link) {
    throw new PairingError(`没有找到配对链接（应以 ${OFFER_URL_PREFIX} 开头）`, "link");
  }
  let offer: RemoteConnectionOffer;
  try {
    offer = decodeOfferUrl(link);
  } catch (error) {
    if (error instanceof OfferError && error.message.includes("版本")) {
      throw new PairingError("配对信息版本不兼容，请升级手机端或电脑端", "link");
    }
    throw new PairingError("配对链接已损坏或不完整，请重新复制", "link");
  }
  if (offer.expiresAt <= now) {
    throw new PairingError(AUTH_FAILED_MESSAGES.expired, "expired");
  }
  return offer;
}

export const NETWORK_ERROR_HINT =
  "无法连接电脑：请确认手机与电脑在同一网络（或已接入 Tailscale）、电脑上已启用「手机连接」并允许了防火墙";

export interface PairOverrides {
  createSocket?: E2eeSocketOptions["createSocket"];
  staggerMs?: number;
  attemptTimeoutMs?: number;
}

/**
 * 并发连接 offer 里的全部地址发送 pair，成功后返回可存储的 PairedHost。
 * 配对连接在拿到凭据后立即关闭，正式连接由 `createHostClient` 用凭据重新认证。
 */
export function pairWithOffer(
  offer: RemoteConnectionOffer,
  deviceName: string,
  overrides: PairOverrides = {},
  now: () => number = Date.now,
): Promise<PairedHost> {
  return new Promise<PairedHost>((resolve, reject) => {
    let paired: { deviceId: string; deviceSecret: string; address: { host: string; port: number } } | null = null;
    const socket = new E2eeSocket({
      addresses: offer.addresses,
      credentials: { mode: "pair", offer, deviceName },
      ...overrides,
      onPaired: (result) => {
        paired = result;
      },
    });
    socket.onopen = () => {
      const result = paired;
      socket.close();
      if (!result) {
        reject(new PairingError("配对失败：未收到设备凭据", "invalid"));
        return;
      }
      resolve({
        id: result.deviceId,
        name: offer.name,
        daemonPublicKey: offer.daemonPublicKey,
        addresses: offer.addresses,
        deviceId: result.deviceId,
        deviceSecret: result.deviceSecret,
        lastAddress: result.address,
        pairedAt: now(),
      });
    };
    socket.onclose = (event) => {
      if (event.code === E2EE_AUTH_FAILED_CLOSE_CODE) {
        const reason = (event.reason in AUTH_FAILED_MESSAGES ? event.reason : "invalid") as AuthFailedReason;
        reject(new PairingError(AUTH_FAILED_MESSAGES[reason], reason === "expired" ? "expired" : "invalid"));
      } else {
        reject(new PairingError(NETWORK_ERROR_HINT, "network"));
      }
    };
  });
}
