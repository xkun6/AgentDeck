import os from "node:os";

import type { RemoteAddress } from "@agentdeck/protocol";

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const nums = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (nums.some((n) => !Number.isInteger(n) || n > 255)) {
    return null;
  }
  return nums as [number, number, number, number];
}

/** design.md 4.31：100.64.0.0/10 = tailscale；10/8、172.16/12、192.168/16 = lan；其它不列出 */
export function classifyIpv4(host: string): RemoteAddress["kind"] | null {
  const ip = parseIpv4(host);
  if (!ip) {
    return null;
  }
  const [a, b] = ip;
  if (a === 100 && b >= 64 && b <= 127) {
    return "tailscale";
  }
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return "lan";
  }
  return null;
}

/** 从 `os.networkInterfaces()` 的结果取非内部 IPv4 地址；lan 在前、tailscale 在后，同类按网卡顺序 */
export function collectAddresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
  port: number,
): RemoteAddress[] {
  const lan: RemoteAddress[] = [];
  const tailscale: RemoteAddress[] = [];
  const seen = new Set<string>();
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      // 老版本 Node 的 family 是数字 4
      const isV4 = info.family === "IPv4" || (info.family as unknown) === 4;
      if (!isV4 || info.internal || seen.has(info.address)) {
        continue;
      }
      const kind = classifyIpv4(info.address);
      if (!kind) {
        continue;
      }
      seen.add(info.address);
      (kind === "lan" ? lan : tailscale).push({ host: info.address, port, kind });
    }
  }
  return [...lan, ...tailscale];
}

export function listAddresses(port: number): RemoteAddress[] {
  return collectAddresses(os.networkInterfaces(), port);
}
