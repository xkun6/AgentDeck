import type { AgentRpcBusinessErrorCode } from "@agentdeck/protocol";

/** 业务错误：RPC 层映射为 `-32000`，`data.code` = code */
export class AgentRpcError extends Error {
  readonly code: AgentRpcBusinessErrorCode;
  readonly data?: Record<string, unknown>;

  constructor(code: AgentRpcBusinessErrorCode, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = "AgentRpcError";
    this.code = code;
    this.data = data;
  }
}
