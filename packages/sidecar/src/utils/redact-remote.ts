// 远程网关凭据（design.md 4.31）脱敏：日志里不得出现 deviceSecret / pairingSecret 与配对链接。
// 密钥本身是随机串、没有固定前缀，所以按「字段名 + 值」和「配对链接」两类形态替换。
const SECRET_FIELD_PATTERN = /(["']?(?:deviceSecret|pairingSecret)["']?\s*[:=]\s*["']?)[A-Za-z0-9+/_=-]{8,}/g;
const OFFER_URL_PATTERN = /agentdeck:\/\/pair#[A-Za-z0-9_-]+/g;

/** 把文本中的 deviceSecret / pairingSecret 值与 `agentdeck://pair#…` 配对链接替换为 `***` */
export function redactRemoteSecrets(text: string): string {
  return text.replace(SECRET_FIELD_PATTERN, "$1***").replace(OFFER_URL_PATTERN, "agentdeck://pair#***");
}
