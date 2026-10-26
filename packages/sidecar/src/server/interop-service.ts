import { createHash, randomBytes } from "node:crypto";

import type { ComputerUseApproval, SidecarSettings } from "@agentdeck/protocol";

import type { InteropEndpoint } from "../agent/types.js";
import { INTEROP_TOKEN_PREFIX } from "../utils/redact-interop.js";

/** MCP 端点路径（design.md 4.26） */
export const MCP_PATH = "/mcp";
/** Computer Use 代理端点路径（design.md 4.37） */
export const COMPUTER_USE_MCP_PATH = "/mcp/cua";

function digest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface InteropServiceOptions {
  /** 当前 `settings.interop`；每次调用时取，开关即时生效 */
  settings: () => SidecarSettings["interop"];
  /** 是否注入 Computer Use 代理端点（design.md 4.37）；不传视为 false */
  computerUseEnabled?: () => boolean;
  /** 当前 Computer Use 审批策略（design.md 4.37）；不传视为 ask */
  computerUseApproval?: () => ComputerUseApproval;
}

/**
 * 会话互通的 token 与端点（design.md 4.26）：每个会话一个随机 interopToken，只在内存中，
 * 重启后重新生成；端口在 HTTP 服务监听后由 `setPort` 告知。
 */
export class InteropService {
  private port: number | null = null;
  /** agentId → token */
  private readonly tokens = new Map<string, string>();
  /** sha256(token) → agentId，鉴权时按摘要查找，避免逐字符比较 */
  private readonly byDigest = new Map<string, string>();

  constructor(private readonly options: InteropServiceOptions) {}

  setPort(port: number): void {
    this.port = port;
  }

  get enabled(): boolean {
    return this.options.settings().enabled;
  }

  /** 该会话应注入的 MCP 端点；互通关闭或 sidecar 尚未监听时返回 undefined（不注入） */
  endpointFor(agentId: string): InteropEndpoint | undefined {
    if (!this.enabled || this.port === null) {
      return undefined;
    }
    return { url: `http://127.0.0.1:${this.port}${MCP_PATH}`, token: this.tokenFor(agentId) };
  }

  /** 该会话应注入的 Computer Use 代理端点（token 与互通相同）；未启用或 sidecar 尚未监听时返回 undefined */
  computerUseEndpointFor(agentId: string): InteropEndpoint | undefined {
    if (this.options.computerUseEnabled?.() !== true || this.port === null) {
      return undefined;
    }
    return { url: `http://127.0.0.1:${this.port}${COMPUTER_USE_MCP_PATH}`, token: this.tokenFor(agentId) };
  }

  /** 当前 Computer Use 审批策略：AgentManager 据此代答 Claude CLI 的 Computer Use 工具审批 */
  computerUseApproval(): ComputerUseApproval {
    return this.options.computerUseApproval?.() ?? "ask";
  }

  private tokenFor(agentId: string): string {
    let token = this.tokens.get(agentId);
    if (!token) {
      token = `${INTEROP_TOKEN_PREFIX}${randomBytes(24).toString("hex")}`;
      this.tokens.set(agentId, token);
      this.byDigest.set(digest(token), agentId);
    }
    return token;
  }

  /** 由 token 识别调用方 agentId；未知 token 返回 null */
  agentIdForToken(token: string): string | null {
    return this.byDigest.get(digest(token)) ?? null;
  }

  /** 会话被删除时作废 token */
  forget(agentId: string): void {
    const token = this.tokens.get(agentId);
    if (token) {
      this.byDigest.delete(digest(token));
      this.tokens.delete(agentId);
    }
  }
}
