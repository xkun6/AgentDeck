// 真实 ACP CLI 冒烟（opt-in）：AGENTDECK_SMOKE=1 且 AGENTDECK_SMOKE_ACP=<provider id，如 acp:gemini 或 gemini> 时才运行。
// 自定义条目可通过 AGENTDECK_DATA_DIR 指向含 acp-agents.json 的目录。
import type { AgentStreamEvent } from "@agentdeck/protocol";
import { describe, expect, test } from "vitest";

import { createLogger } from "../../../src/logger.js";
import { createAcpClients } from "../../../src/providers/acp/index.js";
import { normalizeAcpId } from "../../../src/providers/acp/catalog.js";
import { assistantText, collect, waitForTerminal } from "./helpers.js";

const target = process.env.AGENTDECK_SMOKE_ACP;
const enabled = process.env.AGENTDECK_SMOKE === "1" && Boolean(target);

describe.skipIf(!enabled)("ACP 真实冒烟", () => {
  test(
    `${target ?? ""}：建会话并完成一轮`,
    async () => {
      const logger = createLogger();
      const clients = await createAcpClients({
        logger,
        dataDir: process.env.AGENTDECK_DATA_DIR,
        env: process.env,
      });
      const client = clients.find((c) => c.provider === normalizeAcpId(target!));
      expect(client, `找不到 provider ${target}`).toBeDefined();
      const availability = await client!.isAvailable();
      expect(availability.available, availability.reason).toBe(true);

      const session = await client!.createSession({ cwd: process.cwd() });
      try {
        const events: AgentStreamEvent[] = collect(session);
        await session.startTurn("只用一句话回复：你好");
        await waitForTerminal(events, 1, 170_000);
        expect(events.find((e) => e.type === "thread_started")).toBeDefined();
        expect(events.at(-1)?.type).toBe("turn_completed");
        expect(assistantText(events).length).toBeGreaterThan(0);
        logger.info("冒烟目录：%s", JSON.stringify(await client!.fetchCatalog()));
      } finally {
        await session.close();
      }
    },
    180_000,
  );
});
