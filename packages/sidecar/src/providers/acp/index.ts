import type { ProviderFactory } from "../../agent/types.js";

/**
 * 通用 ACP agents（P3 实现，含内置命令目录与 AGENTDECK_DATA_DIR/acp-agents.json）。
 * P2 占位：返回空数组。P3 只需在本目录内实现并让该工厂返回 AgentClient 实例，
 * 不需要修改 providers/registry.ts。
 */
export const createAcpClients: ProviderFactory = () => [];
