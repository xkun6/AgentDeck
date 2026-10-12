import type { ProviderFactory } from "../../agent/types.js";
import { MockAgentClient } from "./mock-agent.js";

export { MockAgentClient, MockAgentSession, MOCK_PROVIDER_ID } from "./mock-agent.js";

export const createMockClients: ProviderFactory = () => [new MockAgentClient()];
