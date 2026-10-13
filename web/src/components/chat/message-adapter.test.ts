import { describe, expect, it } from "vitest";
import type { AgentUIMessage } from "@agentdeck/protocol";
import {
  deriveAssistantStats,
  agentUIMessageToChatMessage,
} from "./message-adapter";

function uiMessage(overrides: Partial<AgentUIMessage> = {}): AgentUIMessage {
  return {
    id: "m1",
    sessionId: "s1",
    role: "assistant",
    createdAt: 1_000,
    status: "complete",
    parts: [{ type: "text", text: "hi" }],
    ...overrides,
  };
}

describe("message adapter", () => {
  it("keeps canonical progress as a streaming progress block", () => {
    const message = agentUIMessageToChatMessage(uiMessage({
      id: "live-assistant-1",
      status: "streaming",
      parts: [
        { type: "progress", text: "ಠ_ಠ deliberating..." },
      ],
    }));

    expect(message).toMatchObject({
      text: undefined,
      reasoning: undefined,
      status: "streaming",
    });
    expect(message?.blocks).toEqual([{ type: "progress", text: "ಠ_ಠ deliberating..." }]);
  });

  it("保留文本 part 的 source:command 到 text block", () => {
    const message = agentUIMessageToChatMessage(uiMessage({
      parts: [{ type: "text", text: "a\nb", source: "command" }],
    }));
    expect(message?.blocks).toEqual([{ type: "text", text: "a\nb", source: "command" }]);
  });

  it("preserves structured image parts as renderable chat images", () => {
    const message = agentUIMessageToChatMessage(uiMessage({
      id: "assistant-image",
      parts: [
        { type: "text", text: "这是图片：" },
        { type: "image", url: "https://example.test/result.png", alt: "生成结果" },
      ],
    }));

    expect(message?.text).toBe("这是图片：");
    expect(message?.images).toEqual([
      expect.objectContaining({
        url: "https://example.test/result.png",
        alt: "生成结果",
      }),
    ]);
    expect(message?.blocks?.map((block) => block.type)).toEqual(["text", "image"]);
  });

  it("canonical conversion preserves stats, tool cards, reasoning, and copyable text blocks", () => {
    const chat = agentUIMessageToChatMessage(uiMessage({
      id: "live-assistant-1",
      parts: [
        { type: "reasoning", text: "先分析。" },
        { type: "tool", toolCallId: "read-1", name: "read_file", state: "done", input: { path: "app.tsx" }, output: "ok", startedAt: 100, completedAt: 300 },
        { type: "text", text: "结论。" },
      ],
      metadata: {
        usage: { tokensInput: 10, tokensOutput: 20, tokensTotal: 30 },
        timing: { startedAt: 0, firstTokenAt: 100, completedAt: 1000 },
        model: "gpt-5.4",
        finishReason: "stop",
      },
    }));

    expect(chat).toMatchObject({
      id: "live-assistant-1",
      reasoning: "先分析。",
      text: "结论。",
      stats: {
        ttftMs: 100,
        durationMs: 1000,
        tokensTotal: 30,
        tokensInput: 10,
        tokensOutput: 20,
        model: "gpt-5.4",
        finishReason: "stop",
      },
    });
    expect(chat?.blocks?.map((block) => block.type)).toEqual(["reasoning", "tool", "text"]);
    expect(chat?.tools?.[0]).toMatchObject({
      tool_id: "read-1",
      name: "read_file",
      status: "done",
      context: "app.tsx",
      summary: "ok",
    });
  });

});

describe("assistant stats derivation", () => {
  it("derives full stats when metadata usage and timing are present", () => {
    const stats = deriveAssistantStats(
      uiMessage({
        metadata: {
          timing: {
            startedAt: 1_000,
            firstTokenAt: 1_420,
            completedAt: 5_200,
          },
          usage: {
            tokensInput: 920,
            tokensOutput: 312,
            tokensTotal: 1232,
            cacheRead: 736,
            cacheWrite: 12,
            apiCalls: 3,
          },
          model: "gpt-5.4",
          costUsd: 0.018,
          costStatus: "ok",
          finishReason: "stop",
        },
      }),
    );

    expect(stats).toMatchObject({
      ttftMs: 420,
      durationMs: 4200,
      tokensTotal: 1232,
      tokensInput: 920,
      tokensOutput: 312,
      cacheRead: 736,
      cacheWrite: 12,
      apiCalls: 3,
      model: "gpt-5.4",
      costUsd: 0.018,
      finishReason: "stop",
    });
    expect(stats?.tokPerSec).toBeCloseTo(312 / 4.2, 2);
  });

  it("keeps metadata costUsd for displayable statuses", () => {
    const estimated = deriveAssistantStats(
      uiMessage({
        metadata: {
          usage: { tokensOutput: 50 },
          costUsd: 0.5,
          costStatus: "estimated",
        },
      }),
    );
    const included = deriveAssistantStats(
      uiMessage({
        metadata: {
          usage: { tokensOutput: 50 },
          costUsd: 0.2,
          costStatus: "included",
        },
      }),
    );

    expect(estimated?.costUsd).toBe(0.5);
    expect(included?.costUsd).toBe(0.2);
  });

  it("omits costUsd when costStatus is explicitly stale or unknown", () => {
    const stats = deriveAssistantStats(
      uiMessage({
        metadata: {
          timing: { startedAt: 1_000, firstTokenAt: 1_100, completedAt: 2_000 },
          usage: { tokensOutput: 50 },
          costUsd: 0.5,
          costStatus: "stale_pricing",
        },
      }),
    );
    expect(stats?.costUsd).toBeUndefined();
  });

  it("falls back gracefully when first token never recorded", () => {
    const stats = deriveAssistantStats(
      uiMessage({
        metadata: {
          timing: { startedAt: 1_000, completedAt: 3_500 },
          usage: { tokensInput: 100, tokensOutput: 200 },
        },
      }),
    );
    expect(stats?.ttftMs).toBeUndefined();
    expect(stats?.durationMs).toBe(2_500);
    expect(stats?.tokPerSec).toBeCloseTo(200 / 2.5, 2);
  });

  it("returns undefined for non-assistant roles", () => {
    expect(
      deriveAssistantStats(uiMessage({
        role: "user",
        parts: [{ type: "text", text: "hi" }],
        metadata: { usage: { tokensInput: 10 } },
      })),
    ).toBeUndefined();
  });

  it("returns undefined when neither usage nor timing exists", () => {
    expect(deriveAssistantStats(uiMessage())).toBeUndefined();
  });

  it("attaches stats on canonical assistant messages", () => {
    const chat = agentUIMessageToChatMessage(uiMessage({
      metadata: {
        timing: { startedAt: 0, firstTokenAt: 200, completedAt: 1_000 },
        usage: { tokensInput: 10, tokensOutput: 20, tokensTotal: 30 },
      },
    }));
    expect(chat?.stats).toMatchObject({
      ttftMs: 200,
      durationMs: 1_000,
      tokensTotal: 30,
    });
  });
});
