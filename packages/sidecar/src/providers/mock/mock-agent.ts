import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type {
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentStreamEvent,
  ToolCallTimelineItem,
} from "@agentdeck/protocol";

import type {
  AgentAvailability,
  AgentClient,
  AgentSession,
  AgentSessionConfig,
} from "../../agent/types.js";

export const MOCK_PROVIDER_ID = "mock";

/** mock-fast 带两档思考强度（design.md 4.10，供测试切换与回退），mock-slow 不支持 */
export const MOCK_MODELS: AgentModelDefinition[] = [
  {
    provider: MOCK_PROVIDER_ID,
    id: "mock-fast",
    label: "Mock Fast",
    isDefault: true,
    thinkingOptions: [
      { id: "low", label: "低" },
      { id: "high", label: "高" },
    ],
    defaultThinkingOptionId: "high",
  },
  { provider: MOCK_PROVIDER_ID, id: "mock-slow", label: "Mock Slow" },
];

const MOCK_THINKING_OPTION_IDS = new Set(["low", "high"]);

export const MOCK_MODES: AgentMode[] = [
  { id: "default", label: "默认" },
  { id: "plan", label: "计划" },
];

const CHUNK_DELAY_MS: Record<string, number> = {
  "mock-fast": 20,
  "mock-slow": 300,
};

const REASONING_CHUNKS = ["正在分析请求", "……", "准备模拟回复"];

/** 假 provider：始终可用，流式回显 prompt，模拟工具调用与审批，供测试与无 CLI 环境使用 */
export class MockAgentClient implements AgentClient {
  readonly provider = MOCK_PROVIDER_ID;
  readonly kind = "mock" as const;
  readonly label = "Mock Agent";

  async isAvailable(): Promise<AgentAvailability> {
    return { available: true };
  }

  async fetchCatalog(): Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }> {
    return { models: MOCK_MODELS.map((m) => ({ ...m })), modes: MOCK_MODES.map((m) => ({ ...m })) };
  }

  async createSession(cfg: AgentSessionConfig): Promise<AgentSession> {
    if (cfg.modeId !== undefined) {
      assertMockMode(cfg.modeId);
    }
    if (cfg.thinkingOptionId != null) {
      assertMockThinking(cfg.thinkingOptionId);
    }
    return new MockAgentSession(cfg);
  }

  /** 恢复：沿用原 sessionId 的新会话（mock 没有真实上下文可恢复） */
  async resumeSession(handle: AgentPersistenceHandle, cfg: { cwd: string }): Promise<AgentSession> {
    return new MockAgentSession({ cwd: cfg.cwd }, handle.sessionId);
  }
}

interface ActiveTurn {
  turnId: string;
  abort: AbortController;
  /** 当前正在运行的工具调用（interrupt 时置 canceled） */
  runningTool: ToolCallTimelineItem | null;
  pendingPermission: {
    request: AgentPermissionRequest;
    resolve: (response: AgentPermissionResponse) => void;
  } | null;
}

class TurnAbortedError extends Error {}

export class MockAgentSession implements AgentSession {
  readonly provider = MOCK_PROVIDER_ID;

  private sessionId: string | null = null;
  private model: string | null;
  private modeId: string;
  private readonly listeners = new Set<(event: AgentStreamEvent) => void>();
  private active: ActiveTurn | null = null;
  private closed = false;

  constructor(cfg: AgentSessionConfig, resumeSessionId: string | null = null) {
    this.model = cfg.model ?? null;
    this.modeId = cfg.modeId ?? "default";
    this.sessionId = resumeSessionId;
  }

  get id(): string | null {
    return this.sessionId;
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    if (this.closed) {
      throw new Error("Mock 会话已关闭");
    }
    if (this.active) {
      throw new Error("Mock 会话正在执行中");
    }
    const turnId = randomUUID();
    const turn: ActiveTurn = {
      turnId,
      abort: new AbortController(),
      runningTool: null,
      pendingPermission: null,
    };
    this.active = turn;

    if (!this.sessionId) {
      this.sessionId = `mock-${randomUUID()}`;
      this.emit({ type: "thread_started", sessionId: this.sessionId });
    }
    this.emit({ type: "turn_started", turnId });

    void this.runTurn(turn, promptText(prompt));
    return { turnId };
  }

  subscribe(cb: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    const pending = this.active?.pendingPermission;
    return pending ? [pending.request] : [];
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    const pending = this.active?.pendingPermission;
    if (!pending || pending.request.id !== requestId) {
      throw new Error(`找不到待处理的权限请求：${requestId}`);
    }
    this.active!.pendingPermission = null;
    this.emit({ type: "permission_resolved", requestId, response });
    pending.resolve(response);
  }

  async interrupt(): Promise<void> {
    const turn = this.active;
    if (!turn) {
      return;
    }
    this.active = null;
    turn.abort.abort();
    if (turn.pendingPermission) {
      const { request } = turn.pendingPermission;
      turn.pendingPermission = null;
      this.emit({
        type: "permission_resolved",
        requestId: request.id,
        response: { behavior: "deny", message: "回合已取消", interrupt: true },
      });
    }
    if (turn.runningTool) {
      this.emit({
        type: "timeline",
        turnId: turn.turnId,
        item: { ...turn.runningTool, status: "canceled" },
      });
      turn.runningTool = null;
    }
    this.emit({ type: "turn_canceled", turnId: turn.turnId, reason: "interrupted" });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    await this.interrupt();
    this.closed = true;
    this.listeners.clear();
  }

  describePersistence(): AgentPersistenceHandle | null {
    return this.sessionId ? { provider: MOCK_PROVIDER_ID, sessionId: this.sessionId } : null;
  }

  async setModel(modelId: string | null): Promise<void> {
    if (modelId !== null && !MOCK_MODELS.some((m) => m.id === modelId)) {
      throw new Error(`Mock 不支持模型：${modelId}`);
    }
    this.model = modelId;
    this.emit({ type: "model_changed", modelId });
  }

  async setMode(modeId: string): Promise<void> {
    assertMockMode(modeId);
    this.modeId = modeId;
    this.emit({ type: "mode_changed", modeId });
  }

  async setThinking(thinkingOptionId: string | null): Promise<{ notice?: string }> {
    if (thinkingOptionId !== null) {
      assertMockThinking(thinkingOptionId);
    }
    this.emit({ type: "thinking_option_changed", thinkingOptionId });
    return this.active ? { notice: "思考强度将在下一轮生效" } : {};
  }

  // -------------------------------------------------------------------------

  private emit(event: AgentStreamEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private get chunkDelayMs(): number {
    return CHUNK_DELAY_MS[this.model ?? "mock-fast"] ?? CHUNK_DELAY_MS["mock-fast"]!;
  }

  private async pause(turn: ActiveTurn): Promise<void> {
    try {
      await sleep(this.chunkDelayMs, undefined, { signal: turn.abort.signal });
    } catch {
      throw new TurnAbortedError();
    }
    if (this.active !== turn) {
      throw new TurnAbortedError();
    }
  }

  private async runTurn(turn: ActiveTurn, text: string): Promise<void> {
    const { turnId } = turn;
    try {
      for (const chunk of REASONING_CHUNKS) {
        await this.pause(turn);
        this.emit({ type: "timeline", turnId, item: { type: "reasoning", text: chunk } });
      }

      if (text.includes("/fail")) {
        await this.pause(turn);
        this.finish(turn, {
          type: "turn_failed",
          turnId,
          error: "Mock 模拟失败（prompt 含 /fail）",
          code: "MOCK_FAILURE",
        });
        return;
      }

      const command = `echo ${Array.from(text).slice(0, 20).join("")}`;
      const tool: ToolCallTimelineItem = {
        type: "tool_call",
        callId: randomUUID(),
        name: "shell",
        status: "running",
        detail: { type: "shell", command },
      };

      if (text.includes("/approve")) {
        const request: AgentPermissionRequest = {
          id: randomUUID(),
          provider: MOCK_PROVIDER_ID,
          name: "shell",
          kind: "tool",
          title: "运行命令",
          description: `Mock 想要运行：${command}`,
          input: { command },
          detail: { type: "shell", command },
          actions: [
            { id: "allow", label: "允许一次", behavior: "allow" },
            { id: "deny", label: "拒绝", behavior: "deny" },
          ],
        };
        const response = await new Promise<AgentPermissionResponse>((resolve, reject) => {
          turn.pendingPermission = { request, resolve };
          turn.abort.signal.addEventListener("abort", () => reject(new TurnAbortedError()), {
            once: true,
          });
          this.emit({ type: "permission_requested", turnId, request });
        });
        if (response.behavior === "deny") {
          this.emit({
            type: "timeline",
            turnId,
            item: { ...tool, status: "failed", error: response.message ?? "用户拒绝了该操作" },
          });
          this.finish(turn, { type: "turn_completed", turnId });
          return;
        }
      }

      turn.runningTool = tool;
      this.emit({ type: "timeline", turnId, item: tool });
      await this.pause(turn);
      turn.runningTool = null;
      this.emit({
        type: "timeline",
        turnId,
        item: {
          ...tool,
          status: "completed",
          detail: { type: "shell", command, output: command.slice(5), exitCode: 0 },
        },
      });

      const reply = `Mock 回复：${text}`;
      const messageId = randomUUID();
      for (const chunk of splitIntoChunks(reply)) {
        await this.pause(turn);
        this.emit({
          type: "timeline",
          turnId,
          item: { type: "assistant_message", text: chunk, messageId },
        });
      }

      const usage = {
        inputTokens: Array.from(text).length,
        outputTokens: Array.from(reply).length,
      };
      this.emit({ type: "usage_updated", usage });
      this.finish(turn, { type: "turn_completed", turnId, usage });
    } catch (error) {
      if (error instanceof TurnAbortedError) {
        return; // interrupt() 已发 turn_canceled
      }
      if (this.active === turn) {
        this.finish(turn, { type: "turn_failed", turnId, error: String(error) });
      }
    }
  }

  private finish(turn: ActiveTurn, event: AgentStreamEvent): void {
    if (this.active !== turn) {
      return;
    }
    this.active = null;
    this.emit(event);
  }
}

function assertMockMode(modeId: string): void {
  if (!MOCK_MODES.some((mode) => mode.id === modeId)) {
    throw new Error(`Mock 不支持模式：${modeId}`);
  }
}

function promptText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  return prompt
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** 把回复按码点均分成 3~5 段 */
export function splitIntoChunks(text: string): string[] {
  const chars = Array.from(text);
  const count = Math.min(5, Math.max(3, Math.ceil(chars.length / 8)));
  const size = Math.ceil(chars.length / count);
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += size) {
    chunks.push(chars.slice(i, i + size).join(""));
  }
  return chunks;
}

function assertMockThinking(thinkingOptionId: string): void {
  if (!MOCK_THINKING_OPTION_IDS.has(thinkingOptionId)) {
    throw new Error(`Mock 不支持思考强度：${thinkingOptionId}`);
  }
}
