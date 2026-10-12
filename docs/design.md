# AgentDeck 设计文档

> 状态：P0–P4 实施中（2026-10-12 立项）。本文件是 Rust 外壳、Node sidecar、React 前端三方之间的**契约来源**，改契约必须先改本文件。

## 1. 定位

AgentDeck 是一个多 Agent 编排桌面工具：
- **界面与框架**：派生自 Hermes-CN-Desktop（Tauri v2 + React + Vite + TanStack Query + Jotai + CSS Modules）。
- **调用方式**：借鉴 paseo（Apache-2.0），自己不直接调模型 API，而是驱动用户本机已安装的编程 Agent：
  - Claude Code：`@anthropic-ai/claude-agent-sdk` 的 `query()`（streaming input 长会话）
  - Codex：`codex app-server` 子进程，stdio 上的换行分隔 JSON-RPC
  - 通用 ACP：`@agentclientprotocol/sdk` 的 `ClientSideConnection`（gemini / qwen / kimi / hermes acp 等）
- **不包含**：Hermes Python Core、模型供应商配置、记忆、技能、cron、IM 接入、profiles 等 Hermes 专属功能。

## 2. 架构

```
React 前端 ──WS JSON-RPC 2.0──► Node sidecar（packages/sidecar）──► claude / codex app-server / ACP CLI
   ▲  invoke get_sidecar_config                     ▲
   │                                                │ 拉起 + Job Object + 监管重启
Rust（Tauri）── src/process/sidecar.rs ─────────────┘
```

- Rust 只负责：拉起与监管 sidecar、把 sidecar 地址和 token 交给前端、本地能力（git / terminal / 文件预览 / ui_store / 通知 / 托盘 / CLI 检测）。
- sidecar 负责：Agent 会话管理、provider 适配、事件归一化、权限审批中转。
- 前端直连 sidecar 的 WS；webview 拦截 `ws://` 时走 Rust 中继 `ws_proxy.rs`（线协议不变）。

## 3. Rust ↔ sidecar 启动契约

### 3.1 定位 node 与入口（按顺序取第一个命中的）

node 可执行文件：
1. 环境变量 `AGENTDECK_NODE`
2. 主程序 exe 同目录的 `node.exe` / `node`（打包态，P7 提供）
3. PATH 上的 `node`（用 `path_resolver` 实时解析的 PATH 查找）

sidecar 入口：
1. 环境变量 `AGENTDECK_SIDECAR_ENTRY`（指向 .mjs/.js 时直接 `node <entry>`；指向 .ts 时 `node --import tsx <entry>`）
2. 资源目录 `<resource_dir>/sidecar/bundle.mjs`（打包态，P7 提供）
3. 开发态：`<CARGO_MANIFEST_DIR>/packages/sidecar/src/main.ts`，命令 `node --import tsx src/main.ts`，**cwd 设为 `<CARGO_MANIFEST_DIR>/packages/sidecar`**（tsx 是该包的 devDependency）

### 3.2 传给 sidecar 的环境变量

| 变量 | 含义 |
|---|---|
| `AGENTDECK_TOKEN` | 随机 32 字节 hex，WS 鉴权用。**只走环境变量，不走命令行** |
| `AGENTDECK_PORT` | 监听端口，`0` 表示由系统分配（默认） |
| `AGENTDECK_DATA_DIR` | 应用数据目录（会话元数据等） |
| `AGENTDECK_LOG_DIR` | 日志目录，sidecar 自己写 `sidecar.log` |
| `AGENTDECK_PARENT_PID` | Rust 主进程 PID，sidecar 轮询它，父进程消失即自杀 |
| `PATH` | 用 `path_resolver` 解析出的最新 PATH（Windows 读注册表合并） |

### 3.3 握手与生命周期

- sidecar 监听 `127.0.0.1:<port>` 成功后，向 **stdout 输出且只输出一行**：
  `{"type":"ready","port":<number>,"version":"<sidecar 版本>","pid":<number>}`
- 其余所有日志写 stderr 和日志文件。Rust 持续读空 stdout/stderr 并转发到 `log`。
- Rust 等待 ready 行，超时 20 秒判定启动失败。
- 退出：
  1. Rust 关闭 sidecar 的 stdin → sidecar 监听到 `stdin end` 后关闭所有 Agent 子进程（tree-kill）并退出；
  2. 等待 3 秒；
  3. 仍未退出则 `TerminateJobObject` / `taskkill /T /F`。
- Windows：`CREATE_NO_WINDOW`，子进程放入 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job（沿用原 dashboard.rs 的实现）。
- 监管：沿用原 supervisor 策略（5 秒轮询，60 秒内连续失败 5 次停止重启）。重启后 token 重新生成，端口可能变化，前端通过事件得知并重连。

### 3.4 Rust 暴露给前端的接口

- 命令 `get_sidecar_config` → `{ wsUrl: string, token: string, version: string | null, status: "starting" | "ready" | "failed" | "stopped", error: string | null }`
  - `wsUrl` 形如 `ws://127.0.0.1:<port>/rpc`
- 命令 `restart_sidecar` → 同上结构
- 事件 `sidecar-status`：载荷同 `get_sidecar_config` 的返回值（状态每次变化都发）

### 3.5 实现补充约定（P1 落地时确定）

- 3.1 中「命中」指文件存在；`AGENTDECK_NODE` / `AGENTDECK_SIDECAR_ENTRY` 指向不存在的文件时记警告并继续找下一候选。
- 用 `AGENTDECK_SIDECAR_ENTRY` 指定入口时，cwd 为该脚本所在目录。
- ready 行之前的非 ready 输出只记日志，继续等待；进程在 ready 前退出立即判失败。
- 进程自行退出后仍会结束 Job / 进程组，清理可能残留的孙进程。
- 监管：连续失败暂停后监管循环不退出，手动 `restart_sidecar` 成功后恢复监管；**首次拉起失败不自动重试**，只能手动重启。
- sidecar 未就绪时 `wsUrl` 为空字符串；`starting` 状态已带 token。
- 数据目录：`AGENTDECK_HOME`，否则 Tauri `app_data_dir`；日志 `<data>/logs`；ui_store 数据库 `<data>/ui.sqlite`；单实例锁按数据目录，开关变量 `AGENTDECK_SINGLE_INSTANCE`；开发地址变量 `AGENTDECK_DEV_URL`。
- WS 中继沿用命令 `gateway_ws_open/send/close` 与事件 `gateway-ws-message` / `gateway-ws-closed`，目标为当前 sidecar 的 `wsUrl?token=...`，sidecar 未就绪时返回错误。

## 4. 前端 ↔ sidecar 协议（JSON-RPC 2.0 over WebSocket）

- 地址：`ws://127.0.0.1:<port>/rpc?token=<token>`。token 不匹配直接以 HTTP 401 拒绝升级。
- `GET /health`（无需 token）→ `{ "ok": true, "version": "..." }`
- 每个 WS 文本帧是一个 JSON-RPC 2.0 对象。客户端发请求，服务端回响应；服务端主动推送用**通知**（无 id）。
- 错误码：`-32700` 解析错误、`-32600` 非法请求（含批量请求、二进制帧）、`-32601` 方法不存在、`-32602` 参数错误（`data.issues` 为 zod 校验详情）、`-32000` 业务错误（`data.code` 给出细分：`PROVIDER_NOT_FOUND`、`PROVIDER_UNAVAILABLE`、`AGENT_NOT_FOUND`、`AGENT_CLOSED`、`TURN_IN_PROGRESS`、`PERMISSION_NOT_FOUND`、`NOT_SUPPORTED`、`INTERNAL_ERROR`）。未预期异常也走 `-32000` + `INTERNAL_ERROR`。

### 4.1 请求方法

| 方法 | 参数 | 返回 |
|---|---|---|
| `sidecar.info` | — | `{ version, pid }` |
| `provider.list` | — | `ProviderInfo[]` |
| `provider.listModels` | `{ provider, cwd? }` | `{ models: AgentModelDefinition[], modes: AgentMode[] }` |
| `agent.create` | `{ provider, cwd, model?, modeId?, title? }` | `{ agent: AgentSnapshot }` |
| `agent.list` | — | `{ agents: AgentSnapshot[] }` |
| `agent.send` | `{ agentId, prompt: AgentPromptInput, clientMessageId? }` | `{ turnId }` |
| `agent.cancel` | `{ agentId }` | `{}` |
| `agent.permission.respond` | `{ agentId, requestId, response: AgentPermissionResponse }` | `{}` |
| `agent.setModel` | `{ agentId, modelId: string \| null }` | `{ agent: AgentSnapshot }` |
| `agent.setMode` | `{ agentId, modeId }` | `{ agent: AgentSnapshot }` |
| `agent.close` | `{ agentId }` | `{}` |
| `agent.timeline` | `{ agentId, sinceSeq? }` | `{ epoch, entries: AgentStreamEnvelope[] }` |

同一 agent 同一时刻只允许一个进行中的 turn；忙时 `agent.send` 返回 `-32000` + `TURN_IN_PROGRESS`。

### 4.2 通知

| 方法 | 参数 |
|---|---|
| `agent.stream` | `AgentStreamEnvelope` = `{ agentId, seq, epoch, timestamp, event: AgentStreamEvent }` |
| `agent.state` | `{ agent: AgentSnapshot }`（创建、状态变化、模型/模式变化、关闭时推送） |

`seq` 每个 agent 从 1 自增；`epoch` 是 sidecar 进程启动时生成的随机串，用来让前端识别 sidecar 重启。断线重连后前端调用 `agent.timeline { sinceSeq }` 补齐。

### 4.3 共享类型（唯一来源：`packages/protocol/src/agent-api.ts`，纯 TS 类型）

类型形状移植自 paseo `packages/server/src/server/agent/agent-sdk-types.ts`（精简版），如下：

```ts
export type AgentProviderId = string;            // "claude" | "codex" | "mock" | `acp:${string}`
export type AgentProviderKind = "claude" | "codex" | "acp" | "mock";

export interface ProviderInfo {
  id: AgentProviderId; kind: AgentProviderKind; label: string;
  available: boolean; unavailableReason?: string;
  command?: string[];                             // ACP 的启动命令；claude/codex 为解析到的可执行文件
}

export interface AgentMode { id: string; label: string; description?: string }
export interface AgentModelDefinition {
  provider: AgentProviderId; id: string; label: string; description?: string; isDefault?: boolean;
}

export type AgentPromptInput = string | Array<
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }   // data 为 base64
>;

export interface AgentUsage {
  inputTokens?: number; cachedInputTokens?: number; outputTokens?: number;
  totalCostUsd?: number; contextWindowMaxTokens?: number; contextWindowUsedTokens?: number;
}

export type ToolCallDetail =
  | { type: "shell"; command: string; cwd?: string; output?: string; exitCode?: number | null }
  | { type: "read"; filePath: string; content?: string; offset?: number; limit?: number }
  | { type: "edit"; filePath: string; oldString?: string; newString?: string; unifiedDiff?: string }
  | { type: "write"; filePath: string; content?: string }
  | { type: "search"; query: string; toolName?: "search" | "grep" | "glob" | "web_search"; content?: string; filePaths?: string[] }
  | { type: "fetch"; url: string; prompt?: string; result?: string }
  | { type: "plan"; text: string }
  | { type: "plain_text"; label?: string; text?: string }
  | { type: "unknown"; input: unknown; output: unknown };

export type ToolCallStatus = "running" | "completed" | "failed" | "canceled";
export interface ToolCallTimelineItem {
  type: "tool_call"; callId: string; name: string; status: ToolCallStatus;
  detail: ToolCallDetail; error?: string | null; metadata?: Record<string, unknown>;
}

export type AgentTimelineItem =
  | { type: "user_message"; text: string; messageId?: string; clientMessageId?: string }
  | { type: "assistant_message"; text: string; messageId?: string }   // 增量 chunk，前端按 messageId/顺序拼接
  | { type: "reasoning"; text: string }                              // 增量 chunk
  | ToolCallTimelineItem                                              // 同 callId 多次推送，后者覆盖前者
  | { type: "todo"; items: { text: string; completed: boolean }[] }
  | { type: "error"; message: string };

export interface AgentPermissionAction { id: string; label: string; behavior: "allow" | "deny" }
export interface AgentPermissionRequest {
  id: string; provider: AgentProviderId; name: string;
  kind: "tool" | "plan" | "question" | "mode" | "other";
  title?: string; description?: string; input?: Record<string, unknown>;
  detail?: ToolCallDetail; actions?: AgentPermissionAction[];
}
export type AgentPermissionResponse =
  | { behavior: "allow"; selectedActionId?: string; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; selectedActionId?: string; message?: string; interrupt?: boolean };

export type AgentStreamEvent =
  | { type: "thread_started"; sessionId: string }
  | { type: "turn_started"; turnId: string }
  | { type: "turn_completed"; turnId: string; usage?: AgentUsage }
  | { type: "turn_failed"; turnId: string; error: string; code?: string }
  | { type: "turn_canceled"; turnId: string; reason: string }
  | { type: "timeline"; turnId?: string; item: AgentTimelineItem }
  | { type: "permission_requested"; turnId?: string; request: AgentPermissionRequest }
  | { type: "permission_resolved"; requestId: string; response: AgentPermissionResponse }
  | { type: "usage_updated"; usage: AgentUsage }
  | { type: "model_changed"; modelId: string | null }
  | { type: "mode_changed"; modeId: string };

export interface AgentStreamEnvelope {
  agentId: string; seq: number; epoch: string; timestamp: number; event: AgentStreamEvent;
}

export type AgentStatus = "starting" | "idle" | "running" | "error" | "closed";
export interface AgentPersistenceHandle {
  provider: AgentProviderId; sessionId: string; nativeHandle?: string; metadata?: Record<string, unknown>;
}
export interface AgentSnapshot {
  id: string; provider: AgentProviderId; cwd: string; title?: string;
  model?: string | null; modeId?: string | null; availableModes?: AgentMode[];
  status: AgentStatus; activeTurnId?: string | null;
  pendingPermissions: AgentPermissionRequest[];
  lastUsage?: AgentUsage; lastError?: string | null;
  persistence?: AgentPersistenceHandle | null;
  createdAt: number; updatedAt: number;
}
```

### 4.4 实现补充约定（P2 落地时确定）

- `user_message` 由 AgentManager 在调用 `startTurn` 前统一写入（带 `clientMessageId`，不带 turnId）；**provider 不得发 `user_message`**。
- `timeline` / `permission_requested` 未带 turnId 时，AgentManager 自动补上当前 turnId。
- provider 未发 `permission_resolved` / `model_changed` / `mode_changed` 时由 AgentManager 补发；重复事件去重。
- `usage_updated` 只更新快照的 `lastUsage`，不推 `agent.state`。
- `agent.close` 后 agent 保留在注册表中（status `closed`），仍可查询 `agent.timeline`；再 `agent.send` 返回 `AGENT_CLOSED`。
- `agent.create` 未传 model / modeId 时快照中为 `null`，表示使用 provider 默认值；`availableModes` 取自 `fetchCatalog`。
- turn 结束时清空 pendingPermissions；`turn_failed` 记录 `lastError`，下一轮开始时清空。

## 5. sidecar 内部结构（packages/sidecar）

```
packages/sidecar/
├── package.json            @agentdeck/sidecar，"type":"module"
├── src/
│   ├── main.ts             读环境变量 → 起 HTTP+WS 服务 → 输出 ready 行 → 父进程/stdin 监视
│   ├── server/rpc-server.ts    JSON-RPC 分发、token 校验、广播通知
│   ├── agent/types.ts          AgentClient / AgentSession 接口（内部用，事件类型从 protocol 导入）
│   ├── agent/agent-manager.ts  会话注册表、seq/epoch、事件串行、文本合并、权限中转、单 turn 约束
│   ├── agent/coalescer.ts      移植 paseo agent-stream-coalescer（60ms 合并文本）
│   ├── providers/registry.ts   provider 注册表（mock / claude / codex / acp:*）
│   ├── providers/mock/         假 provider：流式回显、模拟工具调用与审批，供测试与无 CLI 环境
│   ├── providers/claude/       P3
│   ├── providers/codex/        P3
│   ├── providers/acp/          P3（含内置 ACP 命令目录）
│   └── utils/                  spawn（Windows .cmd 处理）、tree-kill、executable-resolution、promise-timeout
└── test/                   vitest
```

内部接口（移植自 paseo，精简）：

```ts
interface AgentSession {
  readonly provider: AgentProviderId;
  readonly id: string | null;                       // 原生会话 id，thread_started 后可得
  startTurn(prompt: AgentPromptInput, opts?: { clientMessageId?: string }): Promise<{ turnId: string }>;
  subscribe(cb: (e: AgentStreamEvent) => void): () => void;
  getPendingPermissions(): AgentPermissionRequest[];
  respondToPermission(requestId: string, r: AgentPermissionResponse): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  describePersistence(): AgentPersistenceHandle | null;
  setModel?(modelId: string | null): Promise<void>;
  setMode?(modeId: string): Promise<void>;
}
interface AgentClient {
  readonly provider: AgentProviderId;
  readonly kind: AgentProviderKind;
  readonly label: string;
  isAvailable(): Promise<{ available: boolean; reason?: string }>;
  fetchCatalog(opts?: { cwd?: string }): Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }>;
  createSession(cfg: { cwd: string; model?: string; modeId?: string }): Promise<AgentSession>;
  resumeSession?(handle: AgentPersistenceHandle, cfg: { cwd: string }): Promise<AgentSession>;
  shutdown?(): Promise<void>;
}
```

补充：`AgentClient.isAvailable()` 实际返回 `{ available, reason?, command? }`，`command` 用于填 `ProviderInfo.command`。provider 注册方式：`src/providers/{claude,codex,acp}/index.ts` 各导出一个 `ProviderFactory`（`(ctx: { logger, dataDir?, env }) => AgentClient[] | Promise<AgentClient[]>`），`registry.ts` 固定汇总，各 provider 只改自己的目录。会话事件约定：每轮必须先发 `turn_started`，结束时只发一次 `turn_completed` / `turn_failed` / `turn_canceled`；`respondToPermission` 返回前发 `permission_resolved`；AgentManager 在 `createSession` 返回后才订阅，所以 `thread_started` 要在首轮发；**provider 代码绝不能写 `process.stdout`**（stdout 只留给 ready 行）。

### 5.1 provider 要点（P3）

- **Claude**：一个会话一个长生命周期 `query({ prompt: AsyncIterable<SDKUserMessage>, options })`，每轮 push 一条用户消息；`includePartialMessages: true`；`canUseTool` → `permission_requested`，allow 时必须回传 `updatedInput`；`interrupt()` 外包 3 秒超时；`systemPrompt: { type: "preset", preset: "claude_code" }`；`settingSources: ["user","project","local"]`。
  可执行文件定位顺序：设置项 / 环境变量 `AGENTDECK_CLAUDE_PATH` → PATH 上的 `claude.exe` → 解析 npm `claude.cmd` shim 得到真实 exe → SDK 自带平台包（仅开发态存在）→ 报不可用。**必须传 `pathToClaudeCodeExecutable` 指向真实 exe，不能传 .cmd**；用 `spawnClaudeCodeProcess` 接管 spawn 并 `shell:false`。
- **Codex**：`codex app-server` 子进程；`initialize`（`clientInfo` + `capabilities.experimentalApi: true`）→ `initialized` 通知 → `thread/start { model?, cwd, approvalPolicy, sandbox }` → `turn/start { threadId, input:[{type:"text",text,text_elements:[]}] }`；处理通知 `item/agentMessage/delta`、`item/reasoning/summaryTextDelta`、`item/started`、`item/completed`、`turn/started`、`turn/completed`、`thread/tokenUsage/updated`；审批请求 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval` 应答 `{ decision: "accept" | "decline" | "cancel" }`；中断 `turn/interrupt { threadId, turnId }`（需先拿到 turn/started 的原生 turnId）；`model/list` 拉模型。
  模式预设：`read-only`（on-request + read-only）、`auto`（on-request + workspace-write，默认）、`full-access`（never + danger-full-access）。
  可执行文件定位：`AGENTDECK_CODEX_PATH` → PATH 上的 `codex.exe` → 解析 npm `codex.cmd` → `node_modules/@openai/codex/bin/codex.js` 用当前 node 执行 → 报不可用。
- **ACP**：`spawn(command)` + NDJSON 流 → `ClientSideConnection`；`initialize { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile:false, writeTextFile:false }, terminal:false } }`；`newSession { cwd, mcpServers: [] }`；`prompt` 的 Promise resolve 即 turn 结束；`sessionUpdate`：`agent_message_chunk`→assistant_message、`agent_thought_chunk`→reasoning、`tool_call`/`tool_call_update`→tool_call（按 toolCallId 合并）、`plan`→todo；`requestPermission`：options 映射为 actions，按 selectedActionId 或 allow_once/allow_always、reject_once/reject_always 选；中断 `cancel { sessionId }`；模型 `unstable_setSessionModel`，失败忽略。
  内置命令目录：`acp:gemini` = `npx -y @google/gemini-cli --acp`、`acp:qwen` = `npx -y @qwen-code/qwen-code --acp`、`acp:kimi` = `kimi acp`、`acp:hermes` = `hermes acp`；另支持用户在 `AGENTDECK_DATA_DIR/acp-agents.json` 自定义 `{ id, label, command: string[] }[]`。

### 5.2 Windows 子进程规则

- 所有 spawn 设 `windowsHide: true`。
- 能解析到真实 `.exe` 就 `shell:false` 直接 spawn；`.cmd` shim 优先解析出背后的 exe 或 js（js 用 `process.execPath` 执行）；万不得已才 `shell:true` 并按 paseo `windows-command.ts` 做 cmd 转义。**内联 JSON 参数绝不能经过 cmd.exe。**
- 关闭会话时 tree-kill 整棵子进程树。

## 6. 前端接缝（P4）

保留 Hermes 的渲染层：`ChatSessionRuntime` / `HermesUIMessage` / `ChatMessage` / `MessageTimeline` / `GooseComposer` / `PreviewRail`。替换三处：
1. **事件入口**：`stores/chat.ts` 新增 `reduceAgentEvent(runtime, envelope)` 与 `applyAgentEventAtom`，把 `AgentStreamEvent` 翻译成 `HermesUIMessage.parts`（assistant_message→text、reasoning→reasoning、tool_call→tool part、error→notice）。
2. **动作 hook**：新增 `hooks/use-agent-session.ts` 替换 `useGateway()` 的调用方，方法：`createSession`、`sendPrompt`、`interrupt`、`closeSession`、`respondPermission`、`setModel`、`setMode`、`listProviders`、`listModels`。
3. **历史**：`detail.tsx` 从 `agent.timeline` 重建消息，替代 Hermes REST 历史。
4. **传输**：新增 `lib/sidecar-client.ts`，复用 `gateway-client.ts` 的 JSON-RPC 与重连/退避逻辑以及 `gateway-socket-path.ts` 的原生 WS / Rust 中继回退；地址与 token 来自 `get_sidecar_config`，订阅 `sidecar-status` 事件。
5. **审批**：`ApprovalDialog` 抽到 `components/chat/`，按 `AgentPermissionRequest.actions` 渲染多按钮。
6. **新建会话**：composer 上的模型选择器改为「Agent（provider）+ 模型 + 模式」，工作目录沿用 workspace picker。

## 7. 阶段计划

| 阶段 | 内容 | 验证 |
|---|---|---|
| P0 建仓 | 复制 Hermes-CN-Desktop，改名（AgentDeck / `@agentdeck/*` / crate `agentdeck`），补许可声明，git init | pnpm install / typecheck / test:unit / cargo check |
| P1 Rust 瘦身 | 删 Hermes 专属模块，`dashboard.rs`→`sidecar.rs`，supervisor 改监管 sidecar，实现第 3 节契约 | cargo fmt --check / clippy -D warnings / cargo test |
| P2 sidecar 骨架 | packages/sidecar：RPC 服务、AgentManager、mock provider；protocol 新增 agent-api.ts | vitest；本地 `node --import tsx` 启动输出 ready 行；WS 跑通 mock 会话 |
| P3 provider | Claude / Codex / ACP 适配器 + Windows spawn 工具 | 单元测试（假子进程 / 假 ACP agent）；本机真实 claude、codex 冒烟 |
| P4 前端接入 | 第 6 节全部 | typecheck / vitest；dev 下三种 Agent 手动跑通 |
| P5 裁剪页面 | 删除 Hermes 专属路由、组件、hooks、lib | typecheck / vitest / grid:check |
| P6 持久化 | 会话元数据落盘、resumeSession | 重启后可继续会话 |
| P7 打包 | node.exe 下载校验、esbuild bundle、NSIS | 干净机器安装运行，退出无残留进程 |

## 8. 许可

- 主体派生自 Hermes-CN-Desktop：PolyForm Noncommercial 1.0.0，保留 `LICENSE` 与两条 `Required Notice`，**仅限非商业用途**。
- Agent 适配层移植自 paseo：Apache-2.0，见 `legal/paseo.Apache-2.0.txt`；被移植/修改的文件头注明 `Derived from paseo <原路径> (Apache-2.0); modified for AgentDeck`。
- 部分前端代码源自 Hermes Agent 上游（Nous Research，MIT），见 `legal/hermes-agent-upstream.MIT.txt`。
- HarmonyOS Sans 字体许可见 `legal/HarmonyOS_Sans_LICENSE.txt`。
