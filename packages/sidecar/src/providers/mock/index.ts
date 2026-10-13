import type { ProviderFactory } from "../../agent/types.js";
import { MockAgentClient } from "./mock-agent.js";

export { MockAgentClient, MockAgentSession, MOCK_PROVIDER_ID } from "./mock-agent.js";

/** 环境变量 `AGENTDECK_ENABLE_MOCK=1` 时才注册 mock provider（测试 / 开发用，正式环境不出现） */
export const MOCK_ENABLE_ENV = "AGENTDECK_ENABLE_MOCK";

export const createMockClients: ProviderFactory = (ctx) =>
  ctx.env[MOCK_ENABLE_ENV] === "1" ? [new MockAgentClient()] : [];
