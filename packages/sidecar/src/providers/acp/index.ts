import type { ProviderFactory } from "../../agent/types.js";
import { AcpAgentClient } from "./acp-client.js";
import { resolveAcpAgentEntries } from "./catalog.js";

export { AcpAgentClient } from "./acp-client.js";
export { AcpAgentSession } from "./acp-session.js";
export {
  BUILTIN_ACP_AGENTS,
  CUSTOM_ACP_AGENTS_FILE,
  loadCustomAcpAgents,
  mergeAcpAgents,
  parseCustomAcpAgents,
  resolveAcpAgentEntries,
  type AcpAgentEntry,
} from "./catalog.js";

/**
 * 通用 ACP agents：内置命令目录（DeepSeek Harness `acp:dsh`）+ `<dataDir>/acp-agents.json` 自定义条目，
 * 每个条目一个 AcpAgentClient（kind `acp`）。
 */
export const createAcpClients: ProviderFactory = async (ctx) => {
  const entries = await resolveAcpAgentEntries(ctx.dataDir, ctx.logger);
  return entries.map((entry) => new AcpAgentClient(entry, { logger: ctx.logger, env: ctx.env }));
};
