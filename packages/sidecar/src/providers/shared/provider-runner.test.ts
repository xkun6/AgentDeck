// Derived from paseo packages/server/src/server/agent/providers/provider-runner.test.ts (Apache-2.0); modified for AgentDeck
import { describe, expect, test } from "vitest";
import type { AgentPromptInput, AgentStreamEvent } from "@agentdeck/protocol";
import {
  appendOrReplaceGrowingAssistantMessage,
  replaceFinalTextWithAssistantMessage,
  runProviderTurn,
  type ProviderTurnOptions,
} from "./provider-runner.js";

class FakeTurnRunner {
  readonly events: AgentStreamEvent[] = [];
  private subscriber: ((event: AgentStreamEvent) => void) | null = null;

  constructor(
    private readonly turnId: string,
    private readonly sessionId: string,
    private readonly onStart?: () => void,
  ) {}

  async startTurn(
    _prompt: AgentPromptInput,
    _options?: ProviderTurnOptions,
  ): Promise<{ turnId: string }> {
    this.onStart?.();
    return { turnId: this.turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscriber = callback;
    return () => {
      this.subscriber = null;
    };
  }

  getSessionId(): string {
    return this.sessionId;
  }

  emit(event: AgentStreamEvent): void {
    this.events.push(event);
    this.subscriber?.(event);
  }
}

describe("runProviderTurn", () => {
  test("buffers events emitted before startTurn returns", async () => {
    const runner = new FakeTurnRunner("turn-1", "session-1", () => {
      runner.emit({
        type: "timeline",
        turnId: "turn-1",
        item: { type: "assistant_message", text: "hello" },
      });
      runner.emit({
        type: "turn_completed",
        turnId: "turn-1",
        usage: { inputTokens: 1 },
      });
    });

    const result = await runProviderTurn({
      prompt: "hi",
      startTurn: (prompt, options) => runner.startTurn(prompt, options),
      subscribe: (callback) => runner.subscribe(callback),
      getSessionId: () => runner.getSessionId(),
    });

    expect(result).toEqual({
      sessionId: "session-1",
      finalText: "hello",
      usage: { inputTokens: 1 },
      timeline: [{ type: "assistant_message", text: "hello" }],
    });
  });

  test("ignores events from other turns after the turn id is known", async () => {
    const runner = new FakeTurnRunner("turn-1", "session-1");
    const resultPromise = runProviderTurn({
      prompt: "hi",
      startTurn: (prompt, options) => runner.startTurn(prompt, options),
      subscribe: (callback) => runner.subscribe(callback),
      getSessionId: () => runner.getSessionId(),
    });

    runner.emit({
      type: "timeline",
      turnId: "other-turn",
      item: { type: "assistant_message", text: "wrong" },
    });
    runner.emit({
      type: "timeline",
      turnId: "turn-1",
      item: { type: "assistant_message", text: "right" },
    });
    runner.emit({ type: "turn_completed", turnId: "turn-1" });

    await expect(resultPromise).resolves.toMatchObject({
      finalText: "right",
      timeline: [{ type: "assistant_message", text: "right" }],
    });
  });

  test("rejects when the turn fails", async () => {
    const runner = new FakeTurnRunner("turn-1", "session-1");
    const resultPromise = runProviderTurn({
      prompt: "hi",
      startTurn: (prompt, options) => runner.startTurn(prompt, options),
      subscribe: (callback) => runner.subscribe(callback),
      getSessionId: () => runner.getSessionId(),
    });

    runner.emit({
      type: "turn_failed",
      turnId: "turn-1",
      error: "provider failed",
    });

    await expect(resultPromise).rejects.toThrow("provider failed");
  });

  test("supports growing assistant message reducers", async () => {
    const runner = new FakeTurnRunner("turn-1", "session-1");
    const resultPromise = runProviderTurn({
      prompt: "hi",
      startTurn: (prompt, options) => runner.startTurn(prompt, options),
      subscribe: (callback) => runner.subscribe(callback),
      getSessionId: () => runner.getSessionId(),
      reduceFinalText: appendOrReplaceGrowingAssistantMessage,
    });

    runner.emit({
      type: "timeline",
      turnId: "turn-1",
      item: { type: "assistant_message", text: "hello" },
    });
    runner.emit({
      type: "timeline",
      turnId: "turn-1",
      item: { type: "assistant_message", text: "hello world" },
    });
    runner.emit({
      type: "timeline",
      turnId: "turn-1",
      item: { type: "assistant_message", text: "!" },
    });
    runner.emit({ type: "turn_completed", turnId: "turn-1" });

    await expect(resultPromise).resolves.toMatchObject({
      finalText: "hello world!",
    });
  });

  // AgentDeck：协议约定 assistant_message 为增量 chunk，默认 reducer 追加拼接
  test("appends assistant message deltas by default", async () => {
    const runner = new FakeTurnRunner("turn-1", "session-1");
    const resultPromise = runProviderTurn({
      prompt: "hi",
      startTurn: (prompt, options) => runner.startTurn(prompt, options),
      subscribe: (callback) => runner.subscribe(callback),
      getSessionId: () => runner.getSessionId(),
    });

    runner.emit({ type: "timeline", turnId: "turn-1", item: { type: "reasoning", text: "思考" } });
    runner.emit({
      type: "timeline",
      turnId: "turn-1",
      item: { type: "assistant_message", text: "hel" },
    });
    runner.emit({
      type: "timeline",
      turnId: "turn-1",
      item: { type: "assistant_message", text: "lo" },
    });
    runner.emit({ type: "turn_completed", turnId: "turn-1" });

    const result = await resultPromise;
    expect(result.finalText).toBe("hello");
    expect(result.timeline).toHaveLength(3);
  });

  test("supports whole-message replace reducer", async () => {
    const runner = new FakeTurnRunner("turn-1", "session-1");
    const resultPromise = runProviderTurn({
      prompt: "hi",
      startTurn: (prompt, options) => runner.startTurn(prompt, options),
      subscribe: (callback) => runner.subscribe(callback),
      getSessionId: () => runner.getSessionId(),
      reduceFinalText: replaceFinalTextWithAssistantMessage,
    });

    runner.emit({
      type: "timeline",
      turnId: "turn-1",
      item: { type: "assistant_message", text: "first" },
    });
    runner.emit({
      type: "timeline",
      turnId: "turn-1",
      item: { type: "assistant_message", text: "second" },
    });
    runner.emit({ type: "turn_completed", turnId: "turn-1" });

    await expect(resultPromise).resolves.toMatchObject({ finalText: "second" });
  });

  test("resolves with the partial result when the turn is canceled", async () => {
    const runner = new FakeTurnRunner("turn-1", "session-1");
    const resultPromise = runProviderTurn({
      prompt: "hi",
      startTurn: (prompt, options) => runner.startTurn(prompt, options),
      subscribe: (callback) => runner.subscribe(callback),
      getSessionId: () => runner.getSessionId(),
    });

    runner.emit({
      type: "timeline",
      turnId: "turn-1",
      item: { type: "assistant_message", text: "partial" },
    });
    runner.emit({ type: "turn_canceled", turnId: "turn-1", reason: "user" });

    await expect(resultPromise).resolves.toMatchObject({
      sessionId: "session-1",
      finalText: "partial",
    });
  });
});
