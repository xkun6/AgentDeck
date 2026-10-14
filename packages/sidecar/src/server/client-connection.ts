/**
 * RpcServer 眼里的「客户端连接」最小接口（design.md 4.31）：
 * 本机 `/rpc` 的 WebSocket 是 `local`（文本帧），远程网关认证后的连接是 `remote`（加密二进制帧，
 * 由网关负责加解密）。RpcServer 只关心发 JSON 文本、关连接和来源种类。
 */
export interface RpcClientConnection {
  readonly kind: "local" | "remote";
  /** 仅 remote：已配对设备的 deviceId */
  readonly deviceId?: string;
  /** 发送一条 JSON 文本；连接已不可写时静默丢弃 */
  send(payload: string): void;
  close(): void;
}
