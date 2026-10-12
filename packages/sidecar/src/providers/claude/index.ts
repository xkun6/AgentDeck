import type { ProviderFactory } from "../../agent/types.js";
import { ClaudeAgentClient } from "./claude-agent.js";

export {
  CLAUDE_MODELS,
  CLAUDE_MODES,
  CLAUDE_PROVIDER_ID,
  ClaudeAgentClient,
  ClaudeAgentSession,
  type ClaudeQueryFn,
  type ClaudeQueryHandle,
} from "./claude-agent.js";
export { resolveClaudeExecutable, type ClaudeExecutableResolution } from "./claude-executable.js";

/** Claude Code provider（claude-agent-sdk 长会话） */
export const createClaudeClients: ProviderFactory = (ctx) => [
  new ClaudeAgentClient({ logger: ctx.logger, env: ctx.env }),
];
