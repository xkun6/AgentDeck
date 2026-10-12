// Derived from paseo packages/server/src/server/agent/providers/provider-runner.ts (Apache-2.0); modified for AgentDeck
// 把 AgentSession 风格的 startTurn + subscribe 收敛为“跑完一轮并拿到结果”的 Promise。
// AgentDeck 的常规会话由 AgentManager 驱动（不经过这里）；此 helper 供 provider 内部的一次性调用
// （如标题生成、结构化输出）或测试使用。类型改为依赖 @agentdeck/protocol 与 AgentSession.startTurn 的 opts。
import type {
  AgentPromptInput,
  AgentStreamEvent,
  AgentTimelineItem,
  AgentUsage,
} from "@agentdeck/protocol";

/** 与 AgentSession.startTurn 的第二个参数一致 */
export interface ProviderTurnOptions {
  clientMessageId?: string;
}

export interface ProviderRunResult {
  sessionId: string | null;
  finalText: string;
  usage?: AgentUsage;
  timeline: AgentTimelineItem[];
}

export type ProviderFinalTextReducer = (params: {
  current: string;
  item: AgentTimelineItem;
}) => string;

export interface ProviderTurnRunner {
  startTurn: (
    prompt: AgentPromptInput,
    options?: ProviderTurnOptions,
  ) => Promise<{ turnId: string }>;
  subscribe: (callback: (event: AgentStreamEvent) => void) => () => void;
  getSessionId: () => string | null | Promise<string | null>;
}

export interface RunProviderTurnOptions extends ProviderTurnRunner {
  prompt: AgentPromptInput;
  runOptions?: ProviderTurnOptions;
  reduceFinalText?: ProviderFinalTextReducer;
}

export function getAgentStreamEventTurnId(event: AgentStreamEvent): string | undefined {
  return "turnId" in event ? event.turnId : undefined;
}

export async function runProviderTurn({
  prompt,
  runOptions,
  startTurn,
  subscribe,
  getSessionId,
  // AgentDeck：协议约定 assistant_message 为增量 chunk，默认按追加拼接（paseo 默认是整段替换）
  reduceFinalText = appendAssistantMessageDelta,
}: RunProviderTurnOptions): Promise<ProviderRunResult> {
  const timeline: AgentTimelineItem[] = [];
  let finalText = "";
  let usage: ProviderRunResult["usage"];
  let turnId: string | null = null;
  const bufferedEvents: AgentStreamEvent[] = [];
  let settled = false;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;

  const processEvent = (event: AgentStreamEvent) => {
    if (settled) {
      return;
    }
    const eventTurnId = getAgentStreamEventTurnId(event);
    if (turnId && eventTurnId && eventTurnId !== turnId) {
      return;
    }
    if (event.type === "timeline") {
      timeline.push(event.item);
      finalText = reduceFinalText({ current: finalText, item: event.item });
      return;
    }
    if (event.type === "turn_completed") {
      usage = event.usage;
      settled = true;
      resolveCompletion();
      return;
    }
    if (event.type === "turn_failed") {
      settled = true;
      rejectCompletion(new Error(event.error));
      return;
    }
    if (event.type === "turn_canceled") {
      settled = true;
      resolveCompletion();
    }
  };

  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const unsubscribe = subscribe((event) => {
    if (!turnId) {
      bufferedEvents.push(event);
      return;
    }
    processEvent(event);
  });

  try {
    const result = await startTurn(prompt, runOptions);
    turnId = result.turnId;
    for (const event of bufferedEvents) {
      processEvent(event);
    }
    await completion;
  } finally {
    unsubscribe();
  }

  return {
    sessionId: await getSessionId(),
    finalText,
    usage,
    timeline,
  };
}

/** 默认 reducer：assistant_message 视为增量 chunk，直接追加 */
export function appendAssistantMessageDelta({
  current,
  item,
}: {
  current: string;
  item: AgentTimelineItem;
}): string {
  return item.type === "assistant_message" ? `${current}${item.text}` : current;
}

/** provider 原生事件每次给整段文本时使用：后一条整段替换前一条 */
export function replaceFinalTextWithAssistantMessage({
  current,
  item,
}: {
  current: string;
  item: AgentTimelineItem;
}): string {
  return item.type === "assistant_message" ? item.text : current;
}

/** 混合场景：新文本以已有文本为前缀则替换（整段增长），否则追加 */
export function appendOrReplaceGrowingAssistantMessage({
  current,
  item,
}: {
  current: string;
  item: AgentTimelineItem;
}): string {
  if (item.type !== "assistant_message") {
    return current;
  }
  if (!current) {
    return item.text;
  }
  return item.text.startsWith(current) ? item.text : `${current}${item.text}`;
}
