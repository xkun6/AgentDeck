import type { ProviderFactory } from "../../agent/types.js";
import { CodexAgentClient } from "./codex-agent.js";

export {
  CODEX_MODES,
  CODEX_PROVIDER_ID,
  CodexAgentClient,
  CodexAgentSession,
  DEFAULT_CODEX_MODE_ID,
  type CodexLaunchOverride,
} from "./codex-agent.js";
export { resolveCodexLaunch, type CodexLaunch } from "./launch.js";

/** Codex app-server provider（design.md 5.1） */
export const createCodexClients: ProviderFactory = (ctx) => [
  new CodexAgentClient({ logger: ctx.logger, env: ctx.env }),
];
