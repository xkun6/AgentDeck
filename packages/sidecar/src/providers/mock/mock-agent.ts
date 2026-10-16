import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type {
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentQuestion,
  AgentStreamEvent,
  ElicitationField,
  ToolCallTimelineItem,
} from "@agentdeck/protocol";

import type {
  AgentAvailability,
  AgentClient,
  AgentSession,
  AgentSessionConfig,
} from "../../agent/types.js";
import { AgentRpcError } from "../../agent/errors.js";
import { OutputSpeedTracker } from "../shared/output-speed.js";

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
  /** 挂起的审批（/multi 场景会同时挂起多条） */
  pendingPermissions: Map<
    string,
    {
      request: AgentPermissionRequest;
      resolve: (response: AgentPermissionResponse) => void;
    }
  >;
}

/** 交互场景（prompt 里带对应关键字触发，供真机 / 手工测试审批 UI；见 design.md 4.31「Mock 审批场景」） */
type MockScenario =
  | "question"
  | "plan"
  | "multi"
  | "elicit"
  | "elicit-url"
  | "always"
  | "always-deny"
  | "textq";

function pickScenario(text: string): MockScenario | undefined {
  if (text.includes("/question")) return "question";
  if (text.includes("/plan")) return "plan";
  if (text.includes("/multi")) return "multi";
  // 必须先判断带后缀的：/elicit-url 包含 /elicit，/always-deny 包含 /always
  if (text.includes("/elicit-url")) return "elicit-url";
  if (text.includes("/elicit")) return "elicit";
  if (text.includes("/always-deny")) return "always-deny";
  if (text.includes("/always")) return "always";
  if (text.includes("/textq")) return "textq";
  return undefined;
}

/** /elicit 的表单：string 必填、enum 单选（≤4 项，单选组）、boolean、number 带范围、多选 */
export const MOCK_ELICIT_FIELDS: ElicitationField[] = [
  { key: "name", title: "名称", description: "必填，至少 2 个字符", required: true, type: "string", minLength: 2 },
  {
    key: "level",
    title: "等级",
    required: false,
    type: "select",
    options: [
      { value: "low", label: "低" },
      { value: "mid", label: "中" },
      { value: "high", label: "高" },
    ],
    default: "mid",
  },
  { key: "enabled", title: "启用", required: false, type: "boolean", default: true },
  { key: "ratio", title: "比例", description: "0 到 10", required: false, type: "number", min: 0, max: 10 },
  {
    key: "tags",
    title: "标签",
    description: "最多选 2 项",
    required: false,
    type: "multiselect",
    max: 2,
    options: [
      { value: "alpha", label: "Alpha" },
      { value: "beta", label: "Beta" },
      { value: "gamma", label: "Gamma" },
    ],
  },
];

/** /textq 的提问：纯文本题、遮罩的纯文本题，另有一道不允许「其他」的单选 */
export const MOCK_TEXT_QUESTIONS: AgentQuestion[] = [
  { question: "项目叫什么？", header: "名称", multiSelect: false, options: [], isOther: false, freeText: true },
  {
    question: "API Key 是什么？",
    header: "密钥",
    multiSelect: false,
    options: [],
    isOther: false,
    isSecret: true,
    freeText: true,
  },
  {
    question: "选哪个环境？",
    header: "环境",
    multiSelect: false,
    options: [
      { label: "开发", description: "本机" },
      { label: "生产", description: "线上" },
    ],
    isOther: false,
  },
];

/** 与 Claude AskUserQuestion 映射后的 detail 一致：两题，一题单选带 preview，一题多选；界面都会再追加「其他」 */
export const MOCK_QUESTIONS: AgentQuestion[] = [
  {
    question: "用哪个日期库？",
    header: "库",
    multiSelect: false,
    options: [
      { label: "dayjs", description: "轻量，约 2KB", preview: "import dayjs from 'dayjs';\nconst now = dayjs().format('YYYY-MM-DD');" },
      { label: "luxon", description: "功能全面，时区支持好", preview: "import { DateTime } from 'luxon';\nconst now = DateTime.now().toISODate();" },
    ],
  },
  {
    question: "启用哪些功能？",
    header: "功能",
    multiSelect: true,
    options: [
      { label: "缓存", description: "缓存查询结果" },
      { label: "日志", description: "记录每次请求" },
      { label: "监控", description: "上报耗时指标" },
    ],
  },
];

export const MOCK_PLAN_TEXT = [
  "## 重构登录模块",
  "",
  "1. **梳理现状**：阅读 `src/auth/*`，列出所有调用点",
  "2. **拆分职责**：",
  "   - 会话存储移到 `session-store.ts`",
  "   - 令牌刷新移到 `token-refresh.ts`",
  "3. **补测试**：为两个新模块各写单测",
  "",
  "> 预计改动 6 个文件，不影响对外接口。",
  "",
  "```ts",
  "export function refresh(token: string): Promise<string>;",
  "```",
].join("\n");

class TurnAbortedError extends Error {}

export class MockAgentSession implements AgentSession {
  readonly provider = MOCK_PROVIDER_ID;

  private sessionId: string | null = null;
  private model: string | null;
  private modeId: string;
  private readonly listeners = new Set<(event: AgentStreamEvent) => void>();
  private active: ActiveTurn | null = null;
  private closed = false;
  /** 输出速度（design.md 4.30）：与真实 provider 共用同一个 tracker，审批等待不计入 tok/s */
  private readonly outputSpeed: OutputSpeedTracker;
  private speedTokens = 0;

  constructor(
    cfg: AgentSessionConfig,
    resumeSessionId: string | null = null,
    /** 时钟（仅测试注入，用于模拟审批等待时长） */
    now: () => number = Date.now,
  ) {
    this.outputSpeed = new OutputSpeedTracker(now);
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
      pendingPermissions: new Map(),
    };
    this.active = turn;
    this.outputSpeed.reset();
    this.speedTokens = 0;

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
    return Array.from(this.active?.pendingPermissions.values() ?? [], (pending) => pending.request);
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    const pending = this.active?.pendingPermissions.get(requestId);
    if (!pending) {
      throw new AgentRpcError("PERMISSION_NOT_FOUND", `找不到待处理的权限请求：${requestId}`);
    }
    this.active!.pendingPermissions.delete(requestId);
    const isElicitation = pending.request.kind === "elicitation";
    // 与真实 provider 一致：表单内容不进 permission_resolved（该事件会广播并落盘）
    this.emit({
      type: "permission_resolved",
      requestId,
      response:
        isElicitation && response.behavior === "allow"
          ? { behavior: "allow", ...(response.selectedActionId ? { selectedActionId: response.selectedActionId } : {}) }
          : response,
    });
    pending.resolve(response);
    // 表单 / 浏览器流程的「取消」（deny + interrupt）会中断本回合
    if (isElicitation && response.behavior === "deny" && response.interrupt === true) {
      await this.interrupt();
    }
  }

  async interrupt(): Promise<void> {
    const turn = this.active;
    if (!turn) {
      return;
    }
    this.active = null;
    turn.abort.abort();
    for (const { request } of turn.pendingPermissions.values()) {
      this.emit({
        type: "permission_resolved",
        requestId: request.id,
        response: { behavior: "deny", message: "回合已取消", interrupt: true },
      });
    }
    turn.pendingPermissions.clear();
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
    // 先让 tracker 看到 permission_requested / permission_resolved，再通知订阅方
    this.outputSpeed.observe(event);
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

  /** 发出 permission_requested 并等待应答；回合被中断时 reject */
  private requestPermission(turn: ActiveTurn, request: AgentPermissionRequest): Promise<AgentPermissionResponse> {
    return new Promise<AgentPermissionResponse>((resolve, reject) => {
      turn.pendingPermissions.set(request.id, { request, resolve });
      turn.abort.signal.addEventListener("abort", () => reject(new TurnAbortedError()), { once: true });
      this.emit({ type: "permission_requested", turnId: turn.turnId, request });
    });
  }

  /** 交互场景：发审批、等应答，返回要输出的回复（回显收到的回答 / 理由，便于核对） */
  private async runScenario(turn: ActiveTurn, scenario: MockScenario): Promise<string> {
    if (scenario === "question") {
      const request: AgentPermissionRequest = {
        id: randomUUID(),
        provider: MOCK_PROVIDER_ID,
        name: "AskUserQuestion",
        kind: "question",
        title: "Mock 有问题需要你回答",
        input: { questions: MOCK_QUESTIONS },
        detail: { type: "question", questions: MOCK_QUESTIONS },
        actions: [
          { id: "submit", label: "提交回答", behavior: "allow" },
          { id: "skip", label: "跳过", behavior: "deny" },
        ],
      };
      const response = await this.requestPermission(turn, request);
      if (response.behavior === "deny") {
        return `Mock 收到：跳过了问题${response.message ? `（${response.message}）` : ""}`;
      }
      const answers = (response.updatedInput?.answers ?? {}) as Record<string, string>;
      const lines = Object.entries(answers).map(([question, answer]) => `- ${question} → ${answer}`);
      return `Mock 收到的回答：\n${lines.length > 0 ? lines.join("\n") : "（空）"}`;
    }
    if (scenario === "plan") {
      const request: AgentPermissionRequest = {
        id: randomUUID(),
        provider: MOCK_PROVIDER_ID,
        name: "ExitPlanMode",
        kind: "plan",
        title: "Mock 提交了计划，等待你确认",
        input: { plan: MOCK_PLAN_TEXT },
        detail: { type: "plan", text: MOCK_PLAN_TEXT },
        actions: [
          { id: "approve", label: "批准计划", behavior: "allow" },
          { id: "keep_planning", label: "继续规划", behavior: "deny" },
        ],
      };
      const response = await this.requestPermission(turn, request);
      return response.behavior === "allow"
        ? "Mock 收到：计划已批准"
        : `Mock 收到：继续规划，意见：${response.message?.trim() || "（无）"}`;
    }
    if (scenario === "elicit" || scenario === "elicit-url") {
      const isUrl = scenario === "elicit-url";
      const detail = isUrl
        ? {
            type: "elicitation" as const,
            serverName: "mock-oauth",
            mode: "url" as const,
            message: "Mock 服务需要你在浏览器里完成授权，完成后回到这里点「已完成」。",
            url: "https://example.com/mock-auth",
            elicitationId: "mock-elicit-1",
          }
        : {
            type: "elicitation" as const,
            serverName: "mock-forms",
            mode: "form" as const,
            message: "请填写下面的资料。",
            fields: MOCK_ELICIT_FIELDS,
          };
      const request: AgentPermissionRequest = {
        id: randomUUID(),
        provider: MOCK_PROVIDER_ID,
        name: `mcp:${detail.serverName}`,
        kind: "elicitation",
        title: isUrl ? `${detail.serverName} 需要你在浏览器中完成操作` : `${detail.serverName} 需要你填写表单`,
        input: { serverName: detail.serverName, mode: detail.mode, message: detail.message },
        detail,
        actions: [
          { id: isUrl ? "done" : "submit", label: isUrl ? "已完成" : "提交", behavior: "allow" },
          { id: "decline", label: "拒绝", behavior: "deny" },
          { id: "cancel", label: "取消", behavior: "deny" },
        ],
      };
      const response = await this.requestPermission(turn, request);
      if (response.behavior === "deny") {
        return `Mock 收到：${response.interrupt ? "取消（已中断回合）" : "拒绝"}`;
      }
      if (isUrl) {
        return "Mock 收到：浏览器流程已完成";
      }
      const content = (response.updatedInput?.content ?? {}) as Record<string, unknown>;
      const lines = Object.entries(content).map(([key, value]) => `- ${key} → ${JSON.stringify(value)}`);
      return `Mock 收到的表单内容：\n${lines.length > 0 ? lines.join("\n") : "（空）"}`;
    }
    if (scenario === "always" || scenario === "always-deny") {
      const command = "git status";
      const request: AgentPermissionRequest = {
        id: randomUUID(),
        provider: MOCK_PROVIDER_ID,
        name: "shell",
        kind: "tool",
        title: "运行命令",
        description: `Mock 想要运行：${command}`,
        input: { command },
        detail: { type: "shell", command },
        ...(scenario === "always-deny" ? { defaultDeny: true } : {}),
        actions: [
          { id: "allow", label: "允许一次", behavior: "allow" },
          { id: "deny", label: "拒绝", behavior: "deny" },
          {
            id: "allow_session",
            label: "本会话始终允许",
            behavior: "allow",
            persist: "session",
            description: "仅本会话有效，不写入文件：Bash(git status)",
          },
          {
            id: "allow_project",
            label: "永久允许",
            behavior: "allow",
            persist: "permanent",
            description: "写入项目的 .claude/settings.local.json：Bash(git status)",
          },
        ],
      };
      const response = await this.requestPermission(turn, request);
      const action = request.actions?.find((item) => item.id === response.selectedActionId);
      return `Mock 收到的动作：${response.selectedActionId ?? "（未带 selectedActionId）"}（${action?.label ?? "未知"}，${
        response.behavior === "allow" ? "允许" : "拒绝"
      }）`;
    }
    if (scenario === "textq") {
      const request: AgentPermissionRequest = {
        id: randomUUID(),
        provider: MOCK_PROVIDER_ID,
        name: "request_user_input",
        kind: "question",
        title: "Mock 有问题需要你回答",
        input: { itemId: "mock-text-question" },
        detail: { type: "question", questions: MOCK_TEXT_QUESTIONS },
        actions: [
          { id: "submit", label: "提交回答", behavior: "allow" },
          { id: "skip", label: "跳过", behavior: "deny" },
        ],
      };
      const response = await this.requestPermission(turn, request);
      if (response.behavior === "deny") {
        return `Mock 收到：跳过了问题${response.message ? `（${response.message}）` : ""}`;
      }
      const answers = (response.updatedInput?.answers ?? {}) as Record<string, string>;
      const secret = new Set(MOCK_TEXT_QUESTIONS.filter((q) => q.isSecret).map((q) => q.question));
      // 遮罩题只回显长度，避免把密钥写进时间线
      const lines = Object.entries(answers).map(
        ([question, answer]) => `- ${question} → ${secret.has(question) ? `（已收到，${Array.from(answer).length} 个字符）` : answer}`,
      );
      return `Mock 收到的回答：\n${lines.length > 0 ? lines.join("\n") : "（空）"}`;
    }
    // multi：同时挂起 2 条工具审批，用于验证「还有 N 条待处理」
    const requests = [1, 2].map((index): AgentPermissionRequest => {
      const command = `echo 第 ${index} 条审批`;
      return {
        id: randomUUID(),
        provider: MOCK_PROVIDER_ID,
        name: "shell",
        kind: "tool",
        title: `运行命令（${index}/2）`,
        description: `Mock 想要运行：${command}`,
        input: { command },
        detail: { type: "shell", command },
        actions: [
          { id: "allow", label: "允许一次", behavior: "allow" },
          { id: "deny", label: "拒绝", behavior: "deny" },
        ],
      };
    });
    const responses = await Promise.all(requests.map((request) => this.requestPermission(turn, request)));
    const lines = responses.map((response, index) =>
      response.behavior === "allow"
        ? `- 第 ${index + 1} 条：允许`
        : `- 第 ${index + 1} 条：拒绝${response.message ? `，理由：${response.message}` : ""}`,
    );
    return `Mock 收到的处理结果：\n${lines.join("\n")}`;
  }

  private async runTurn(turn: ActiveTurn, text: string): Promise<void> {
    const { turnId } = turn;
    try {
      for (const chunk of REASONING_CHUNKS) {
        await this.pause(turn);
        this.outputSpeed.markOutput();
        this.emit({ type: "timeline", turnId, item: { type: "reasoning", text: chunk } });
      }
      // 思考结束，后面是工具 / 审批 / 回复：关闭当前生成段（回复的 chunk 会重新开段）
      this.outputSpeed.markIdle();

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

      const scenario = pickScenario(text);
      if (scenario) {
        await this.streamReply(turn, text, await this.runScenario(turn, scenario));
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
        const response = await this.requestPermission(turn, request);
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

      await this.streamReply(turn, text, `Mock 回复：${text}`);
    } catch (error) {
      if (error instanceof TurnAbortedError) {
        return; // interrupt() 已发 turn_canceled
      }
      if (this.active === turn) {
        this.finish(turn, { type: "turn_failed", turnId, error: String(error) });
      }
    }
  }

  /** 把回复分段流式输出并正常结束回合 */
  private async streamReply(turn: ActiveTurn, text: string, reply: string): Promise<void> {
    const { turnId } = turn;
    const messageId = randomUUID();
    for (const chunk of splitIntoChunks(reply)) {
      await this.pause(turn);
      this.outputSpeed.markOutput();
      this.emit({
        type: "timeline",
        turnId,
        item: { type: "assistant_message", text: chunk, messageId },
      });
      // 回合中最多每秒一次、只带 outputTokensPerSecond 的 usage_updated
      this.speedTokens += Array.from(chunk).length;
      const live = this.outputSpeed.throttledSpeed(this.speedTokens);
      if (live !== undefined) {
        this.emit({ type: "usage_updated", usage: { outputTokensPerSecond: live } });
      }
    }

    const outputTokens = Array.from(reply).length;
    this.outputSpeed.endResponse(outputTokens);
    const usage = {
      inputTokens: Array.from(text).length,
      outputTokens,
      ...this.outputSpeed.finalUsage(),
    };
    this.emit({ type: "usage_updated", usage });
    this.finish(turn, { type: "turn_completed", turnId, usage });
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
