import type { ProviderFactory } from "../../agent/types.js";
import { ClaudeAgentClient } from "./claude-agent.js";

export {
  CLAUDE_MODELS,
  CLAUDE_MODES,
  CLAUDE_PROVIDER_ID,
  ClaudeAgentClient,
  ClaudeAgentSession,
  type ClaudeLaunchOverride,
} from "./claude-agent.js";
export {
  ClaudeCliSession,
  buildClaudeCliArgs,
  type ClaudeCliFactory,
  type ClaudeCliHandle,
  type ClaudeCliOptions,
} from "./claude-cli-session.js";
export { resolveClaudeExecutable, type ClaudeExecutableResolution } from "./claude-executable.js";

/** Claude Code provider（直连本机 claude CLI 的 stream-json 长会话） */
export const createClaudeClients: ProviderFactory = (ctx) => [
  new ClaudeAgentClient({ logger: ctx.logger, env: ctx.env }),
];
