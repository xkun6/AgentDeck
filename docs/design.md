# AgentDeck 设计文档

> 状态：P0–P7 已完成（2026-10-12）。P5 裁剪 Hermes 页面与换品牌、P6 会话持久化与恢复、P7 NSIS 打包均已落地；release 版 `agentdeck.exe` 已实测 mock 会话、重开恢复、删除与退出无残留。Claude provider 已改为直连本机 claude CLI（stream-json），安装包不含 Anthropic / OpenAI 代码。干净机器安装测试待用户执行。本文件是 Rust 外壳、Node sidecar、React 前端三方之间的**契约来源**，改契约必须先改本文件。

## 1. 定位

AgentDeck 是一个多 Agent 编排桌面工具：
- **界面与框架**：派生自 Hermes-CN-Desktop（Tauri v2 + React + Vite + TanStack Query + Jotai + CSS Modules）。
- **调用方式**：借鉴 paseo（Apache-2.0），自己不直接调模型 API，而是驱动用户本机已安装的编程 Agent：
  - Claude Code：直接拉起用户本机 `claude` CLI，走 stream-json stdio 协议（长会话），不依赖 claude-agent-sdk
  - Codex：`codex app-server` 子进程，stdio 上的换行分隔 JSON-RPC
  - 通用 ACP：`@agentclientprotocol/sdk` 的 `ClientSideConnection`（内置 DeepSeek Harness `dsh --profile acp`，另可在 `acp-agents.json` / 中转中自定义）
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
2. 开发态（仅 debug 构建，且源码存在）：`<CARGO_MANIFEST_DIR>/packages/sidecar/src/main.ts`，命令 `node --import tsx src/main.ts`，**cwd 设为 `<CARGO_MANIFEST_DIR>/packages/sidecar`**（tsx 是该包的 devDependency）
3. 资源目录 `<resource_dir>/sidecar/bundle.mjs`（打包态，P7 提供；release 构建只走这一项）

> 顺序说明（P7 调整）：tauri-build 每次编译都会把 externalBin 与 resources 复制到 `target/<profile>/`，若资源 bundle 排在开发态源码之前，`tauri dev` 会误用旧 bundle，所以开发态源码优先。

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

- 命令 `get_sidecar_config` → `{ wsUrl: string, token: string, version: string | null, status: "starting" | "ready" | "failed" | "stopped", error: string | null, pid: number | null }`（`pid` 为 sidecar 进程 pid，未运行时为 null；供 Debug 面板显示，4.18）
  - `wsUrl` 形如 `ws://127.0.0.1:<port>/rpc`
- 命令 `restart_sidecar` → 同上结构
- 事件 `sidecar-status`：载荷同 `get_sidecar_config` 的返回值（状态每次变化都发）

### 3.5 实现补充约定（P1 落地时确定）

- 3.1 中「命中」指文件存在；`AGENTDECK_NODE` / `AGENTDECK_SIDECAR_ENTRY` 指向不存在的文件时记警告并继续找下一候选。
- 用 `AGENTDECK_SIDECAR_ENTRY` 指定入口时，cwd 为该脚本所在目录。
- ready 行之前的非 ready 输出只记日志，继续等待；进程在 ready 前退出立即判失败。
- 进程自行退出后仍会结束 Job / 进程组，清理可能残留的孙进程。
- 监管：连续失败暂停后监管循环不退出，手动 `restart_sidecar` 成功后恢复监管；**首次拉起失败与手动重启失败不自动重试**，只能手动重启。
- 自动重启本身拉起失败（未就绪）时，下一个轮询周期继续重试，与「进程退出」共用同一连续计数与上限（相邻两次自动重启间隔 < 60 秒计为连续，超过 5 次暂停）；手动 `restart_sidecar` 清零连续计数与待重试标记。
- sidecar 未就绪时 `wsUrl` 为空字符串；`starting` 状态已带 token。
- 数据目录：`AGENTDECK_HOME`，否则 Tauri `app_data_dir`（Windows 为 `%APPDATA%local.agentdeck.desktop`）；WebView2 数据在设置了 `AGENTDECK_HOME` 时为 `<home>webview2`，否则为 `%LOCALAPPDATA%local.agentdeck.desktopEBWebView`；日志 `<data>/logs`；ui_store 数据库 `<data>/ui.sqlite`；单实例锁按数据目录，开关变量 `AGENTDECK_SINGLE_INSTANCE`；开发地址变量 `AGENTDECK_DEV_URL`。
- WS 中继沿用命令 `sidecar_ws_open/send/close` 与事件 `sidecar-ws-message` / `sidecar-ws-closed`，目标为当前 sidecar 的 `wsUrl?token=...`，sidecar 未就绪时返回错误。

## 4. 前端 ↔ sidecar 协议（JSON-RPC 2.0 over WebSocket）

- 地址：`ws://127.0.0.1:<port>/rpc?token=<token>`。token 不匹配直接以 HTTP 401 拒绝升级。
- `GET /health`（无需 token）→ `{ "ok": true, "version": "..." }`
- 每个 WS 文本帧是一个 JSON-RPC 2.0 对象。客户端发请求，服务端回响应；服务端主动推送用**通知**（无 id）。
- 错误码：`-32700` 解析错误、`-32600` 非法请求（含批量请求、二进制帧）、`-32601` 方法不存在、`-32602` 参数错误（`data.issues` 为 zod 校验详情）、`-32000` 业务错误（`data.code` 给出细分：`PROVIDER_NOT_FOUND`、`PROVIDER_UNAVAILABLE`、`AGENT_NOT_FOUND`、`AGENT_CLOSED`、`TURN_IN_PROGRESS`、`PERMISSION_NOT_FOUND`、`NOT_SUPPORTED`、`TASK_NOT_FOUND`、`RETRACT_UNAVAILABLE`、`INTERNAL_ERROR`）。未预期异常也走 `-32000` + `INTERNAL_ERROR`。

### 4.1 请求方法

| 方法 | 参数 | 返回 |
|---|---|---|
| `sidecar.info` | — | `{ version, pid }` |
| `provider.list` | — | `ProviderInfo[]` |
| `provider.listModels` | `{ provider, cwd? }` | `{ models: AgentModelDefinition[], modes: AgentMode[] }` |
| `agent.create` | `{ provider, cwd, model?, modeId?, thinkingOptionId?: string \| null, title? }` | `{ agent: AgentSnapshot }` |
| `agent.list` | — | `{ agents: AgentSnapshot[] }` |
| `agent.send` | `{ agentId, prompt: AgentPromptInput, clientMessageId? }` | `{ turnId }` |
| `agent.cancel` | `{ agentId }` | `{}` |
| `agent.retract` | `{ agentId }` | `{ prompt: AgentPromptInput, clientMessageId? }`（首次响应前撤回，见 4.16） |
| `agent.permission.respond` | `{ agentId, requestId, response: AgentPermissionResponse }` | `{}` |
| `agent.setModel` | `{ agentId, modelId: string \| null }` | `{ agent: AgentSnapshot }` |
| `agent.setMode` | `{ agentId, modeId }` | `{ agent: AgentSnapshot }` |
| `agent.setThinking` | `{ agentId, thinkingOptionId: string \| null }` | `{ agent: AgentSnapshot, notice?: string }`（见 4.10） |
| `agent.close` | `{ agentId }` | `{}` |
| `agent.timeline` | `{ agentId, sinceSeq? }` | `{ epoch, entries: AgentStreamEnvelope[] }` |
| `agent.subagents.list` | `{ agentId }` | `{ subagents: ProviderSubagentDescriptor[] }`（见 4.11） |
| `agent.subagents.timeline` | `{ agentId, subagentId, direction?, cursorSeq?, limit? }` | `{ rows, hasOlder, hasNewer }`（见 4.11） |
| `agent.commands` | `{ agentId }` | `{ commands: AgentSlashCommand[] }`（见 4.14） |
| `agent.mcp.status` | `{ agentId }` | `AgentMcpStatusResult`（见 4.14） |
| `agent.mcp.reconnect` | `{ agentId, serverName? }` | `AgentMcpStatusResult`（重连后的最新状态，见 4.14） |
| `agent.status` | `{ agentId }` | `{ sections: AgentStatusSection[] }`（AgentDeck 本地 `/status`，见 4.14） |
| `agent.tasks.list` | `{ agentId }` | `{ tasks: AgentBackgroundTask[] }`（见 4.15） |
| `agent.tasks.stop` | `{ agentId, taskId }` | `{}`（见 4.15） |
| `agent.tasks.output` | `{ agentId, taskId, maxBytes? }` | `{ text, truncated, size }`（见 4.15） |
| `agent.update` | `{ agentId, title?: string \| null, pinned?, archived? }` | `{ agent: AgentSnapshot }`（重命名 / 置顶 / 归档，见 4.17） |
| `agent.search` | `{ query, limit?, agentIds? }` | `{ hits: AgentSearchHit[], truncated }`（全文搜索，见 4.19） |
| `usage.summary` | `{ sinceMs?, untilMs? }` | `UsageSummary`（跨会话用量统计，见 4.20） |
| `agent.steer` | `{ agentId, prompt: AgentPromptInput, clientMessageId? }` | `{}`（运行中插话，见 4.22） |
| `agent.fork` | `{ agentId, throughSeq?, title? }` | `{ agent: AgentSnapshot }`（会话分叉，见 4.23） |
| `settings.get` / `settings.set` | `{}` / `{ patch }` | `SidecarSettings`（sidecar 设置，见 4.24） |
| `snapshot.list` / `snapshot.diff` / `snapshot.restore` / `snapshot.storage` / `snapshot.prune` | 见 4.24 | 按回合 git 快照（影子仓库） |
| `schedule.list` / `schedule.upsert` / `schedule.delete` / `schedule.runNow` / `schedule.runs` / `schedule.setPaused` | 见 4.25 | 定时任务、心跳、目标循环 |
| `group.create` / `group.list` / `group.get` / `group.delete` | 见 4.27 | 并行协作组（扇出 + 汇总） |
| `board.get` / `board.updateSettings` / `board.upsertTask` / `board.deleteTask` / `board.moveTask` / `board.merge` | 见 4.28 | 看板式任务分派 |

同一 agent 同一时刻只允许一个进行中的 turn；忙时 `agent.send` 返回 `-32000` + `TURN_IN_PROGRESS`。例外：进行中的是 CLI 自发轮次（`turn_started.origin === "background"`）时允许 send，见 4.12。

### 4.2 通知

| 方法 | 参数 |
|---|---|
| `agent.stream` | `AgentStreamEnvelope` = `{ agentId, seq, epoch, timestamp, event: AgentStreamEvent }` |
| `agent.state` | `{ agent: AgentSnapshot }`（创建、状态变化、模型/模式变化、关闭时推送） |
| `agent.subagents.update` | `ProviderSubagentUpdate`（见 4.11） |
| `agent.tasks.update` | `{ agentId, tasks: AgentBackgroundTask[] }`（后台任务整表，见 4.15） |

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
  | { type: "sub_agent"; subAgentType?: string; description?: string; childSessionId?: string;
      log: string; actions?: { index: number; toolName: string; summary?: string }[] }   // 4.11
  | { type: "plain_text"; label?: string; text?: string }
  | { type: "question"; questions: AgentQuestion[]; answers?: Record<string, string> }   // Claude AskUserQuestion，见 4.13
  | { type: "unknown"; input: unknown; output: unknown };

export interface AgentQuestionOption { label: string; description?: string; preview?: string }
export interface AgentQuestion { question: string; header?: string; multiSelect: boolean; options: AgentQuestionOption[] }

export type ToolCallStatus = "running" | "completed" | "failed" | "canceled";
export interface ToolCallTimelineItem {
  type: "tool_call"; callId: string; name: string; status: ToolCallStatus;
  detail: ToolCallDetail; error?: string | null; metadata?: Record<string, unknown>;
}

export type AgentTimelineItem =
  | { type: "user_message"; text: string; messageId?: string; clientMessageId?: string }
  | { type: "assistant_message"; text: string; messageId?: string; source?: "command" }   // 增量 chunk，前端按 messageId/顺序拼接；source=command 见 4.14
  | { type: "reasoning"; text: string }                              // 增量 chunk
  | ToolCallTimelineItem                                              // 同 callId 多次推送，后者覆盖前者
  | { type: "todo"; items: { text: string; completed: boolean }[] }
  | { type: "error"; message: string }
  | { type: "compaction"; compactionId: string; status: "running" | "completed" | "failed";
      trigger?: "auto" | "manual"; preTokens?: number; error?: string };   // 上下文压缩，同 compactionId 后者覆盖前者（4.13）

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
  | { type: "turn_started"; turnId: string; origin?: AgentTurnOrigin }   // AgentTurnOrigin = "background"（4.12）
  | { type: "turn_completed"; turnId: string; usage?: AgentUsage }
  | { type: "turn_failed"; turnId: string; error: string; code?: string }
  | { type: "turn_canceled"; turnId: string; reason: string }
  | { type: "timeline"; turnId?: string; item: AgentTimelineItem }
  | { type: "permission_requested"; turnId?: string; request: AgentPermissionRequest }
  | { type: "permission_resolved"; requestId: string; response: AgentPermissionResponse }
  | { type: "usage_updated"; usage: AgentUsage }
  | { type: "model_changed"; modelId: string | null }
  | { type: "mode_changed"; modeId: string | null }; // null = 回到「跟随 provider 设置」

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
  totalUsage?: { inputTokens: number; outputTokens: number };   // 会话累计（见 4.4）；只累加 turn_completed.usage，usage_updated 不计入
  persistence?: AgentPersistenceHandle | null;
  createdAt: number; updatedAt: number;
}
```

### 4.4 实现补充约定（P2 落地时确定）

- `user_message` 由 AgentManager 统一写入（带 `clientMessageId`，不带 turnId）；**provider 不得发 `user_message`**。它在事件链中占位于 `startTurn` 之前（排在本轮所有 provider 事件之前），但只有 `startTurn` 成功返回后才真正写入时间线与磁盘；`startTurn` 失败则不写入，`agent.send` 返回错误，避免留下没有回合的用户消息。
- `turn_completed.usage` 的 `inputTokens` / `outputTokens` 表示**本轮**合计用量（上下文窗口字段仍为最新值）；AgentManager 每次 `turn_completed` 把它累加进快照 `totalUsage`（随 meta.json 持久化，并推 `agent.state`）。早于该字段的旧会话没有 `totalUsage`，前端退回显示 `lastUsage`。
- `timeline` / `permission_requested` 未带 turnId 时，AgentManager 自动补上当前 turnId。
- provider 未发 `permission_resolved` / `model_changed` / `mode_changed` 时由 AgentManager 补发；重复事件去重。
- `usage_updated` 只更新快照的 `lastUsage`，不推 `agent.state`。**语义为浅合并**（`{ ...prev, ...event.usage }`，AgentManager 与前端运行时一致），provider 可以只带部分字段（如回合中只带上下文字段）而不抹掉其余；`turn_completed.usage` 才计入 `totalUsage`，`usage_updated` 一律不计入。
- `agent.close` 后 agent 保留在注册表中（status `closed`），仍可查询 `agent.timeline`；再 `agent.send` 时若可恢复则自动恢复（见 4.5），否则返回 `AGENT_CLOSED`。
- `agent.create` 未传 model / modeId 时快照中为 `null`，表示使用 provider 默认值；`availableModes` 取自 `fetchCatalog`。
- turn 结束时清空 pendingPermissions；`turn_failed` 记录 `lastError`，下一轮开始时清空。

### 4.5 协议补充与会话持久化（P5/P6）

**类型补充**（`agent-api.ts`）：
- `AgentMode.dangerous?: boolean`：跳过权限确认类模式为 true（Claude `bypassPermissions`、Codex `full-access`），前端据此标红，不再写死 id。
- `AgentStatus` 增加 `"dormant"`：已持久化但未加载到内存的会话（sidecar 重启后的历史会话）。
- `AgentSnapshot` 增加：`preview?: string`（首条用户消息前 120 字）、`lastSeq: number`（该 agent 当前最大 seq，无事件为 0）、`resumable: boolean`（有 persistence 句柄且 provider 支持 `resumeSession`）。
- 新方法 `agent.delete { agentId }` → `{}`：若在运行先关闭，然后从注册表与磁盘删除。
- 新通知 `agent.removed { agentId }`：agent 被删除时广播。

**持久化**（仅当设置了 `AGENTDECK_DATA_DIR`；未设置时保持纯内存行为）：
- 目录 `<AGENTDECK_DATA_DIR>/agents/<agentId>/`：`meta.json`（快照中除 pendingPermissions / activeTurnId 外的字段，含 persistence 句柄）与 `timeline.jsonl`（每行一个经合并后的 `AgentStreamEnvelope`）。
- 写入：timeline 逐条追加；meta 在状态变化时以「写临时文件 + rename」原子更新，500ms 防抖，turn 结束与 shutdown 时强制落盘。损坏的行/文件记日志后跳过，不得导致 sidecar 启动失败。
- 启动：扫描全部 meta.json，原状态为 starting / idle / running / error 的恢复为 `dormant`，`closed` 保持 `closed`；timeline 在首次 `agent.timeline` 请求时惰性读取；seq 从持久化的 `lastSeq` 继续递增。`agent.list` 按 `updatedAt` 倒序返回。
- 恢复：对 `dormant` 或 `closed` 的 agent 调 `agent.send` 时，若 `resumable` 则自动 `client.resumeSession(persistence, { cwd })`（状态 dormant/closed → starting → idle → running），若快照记录了非 null 的 model / modeId 则恢复后重新设置；不可恢复时返回 `-32000` + `NOT_SUPPORTED`（message「该会话无法恢复，请新建会话」）。恢复失败返回 `PROVIDER_UNAVAILABLE` 并把错误写入 lastError。
- `agent.timeline` 返回的 `epoch` 为当前进程 epoch；历史条目保留原 seq 与原 epoch，前端按 seq 去重。

**P6 落地细则**（实现与上文有出入时以此为准）：
- 不可恢复时的错误码：`dormant` 且不可恢复 → `NOT_SUPPORTED`；`closed` 且不可恢复 → `AGENT_CLOSED`。
- seq 续号：`max(meta.lastSeq, timeline 中最大 seq) + 1`，防止 meta 防抖未落盘时 seq 回退。
- ACP agent 的 `resumeSession` 返回 `NOT_SUPPORTED` 时，把该 agent 的 `resumable` 置为 false 并落盘。
- `dormant` 状态下调 `agent.setModel` / `agent.setMode` / `agent.permission.respond` → `AGENT_CLOSED`；对 `dormant` 调 `agent.close` 直接转为 `closed`。
- 恢复进行中再次 `agent.send` → 立即返回 `TURN_IN_PROGRESS`。
- `agent.delete` 删磁盘目录失败 → `INTERNAL_ERROR`，agent 保持 `closed` 留在注册表。
- mock provider 恢复时沿用原 sessionId。

### 4.6 本地文件列表（Rust 命令，P5）

- 命令 `fs_list`，参数按仓库惯例包在 `input` 中：`invoke("fs_list", { input: { path?: string, showHidden?: boolean } })`（`input` 可省略）→ `{ path, parent: string | null, home, entries: { name, path, isDir }[], error?: string }`（无错误时不含 `error` 字段）。非 Windows 下 `path` 为空字符串列根目录 `/`。
- `path` 缺省时列出用户主目录；Windows 下 `path` 为空字符串时返回盘符列表（entries 为 `C:\` 等，parent 为 null）。
- 目录在前、文件在后，各自按名称不区分大小写排序；默认隐藏以 `.` 开头的条目与 Windows 隐藏属性条目。
- 读取失败（不存在 / 无权限）不抛错，返回 `error`（中文）与空 entries，便于前端就地提示。

### 4.7 自定义 provider / 三方中转（参照 paseo `docs/custom-providers.md`）

用户可基于 Claude Code / Codex / ACP 定义任意多个「中转 provider」：同一个本机 CLI，换接口地址、密钥、模型列表，每个配置在 Agent 列表中显示为独立一项。

**配置文件** `<AGENTDECK_DATA_DIR>/providers.json`（原子写入；未设 `AGENTDECK_DATA_DIR` 时 get 返回空、set 返回 `NOT_SUPPORTED`）：

```ts
interface ProviderConfigFile { version: 1; providers: ProviderProfile[] }

interface ProviderProfile {
  id: string;                       // ^[a-z][a-z0-9-]{0,31}$，provider id 为 `custom:<id>`
  extends: "claude" | "codex" | "acp";
  label: string;                    // 1–40 字
  description?: string;
  enabled?: boolean;                // 默认 true；false 时不出现在 provider.list
  baseUrl?: string;                 // http(s) URL，去掉末尾 /
  apiKey?: string;
  authMode?: "auth_token" | "api_key"; // 仅 claude，默认 auth_token
  env?: Record<string, string>;     // 额外环境变量，最后应用（可覆盖推导值）
  command?: string[];               // acp 必填；claude / codex 可选：覆盖可执行文件
  models?: { id: string; label: string; description?: string; isDefault?: boolean }[];
  disallowedTools?: string[];       // 仅 claude
}
```

**对子进程的映射**：
- 公共：先从继承环境中剔除该族的凭据变量（claude：`ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`；codex：`OPENAI_BASE_URL` / `OPENAI_API_KEY`），再应用推导值，最后应用 `env`。
- claude：`baseUrl` → `ANTHROPIC_BASE_URL`；`apiKey` → `authMode` 为 `auth_token` 时写 `ANTHROPIC_AUTH_TOKEN`，为 `api_key` 时写 `ANTHROPIC_API_KEY`；`disallowedTools` → `--disallowedTools`，设置了 `baseUrl` 且未显式给出时默认 `["WebSearch"]`（三方接口不支持服务端 WebSearch）。用户 `~/.claude/settings.json` 的 `env` 优先级高于进程环境，因此中转配置还必须通过 `--settings <json>` 以 flag 级设置注入同一组 env，保证中转值生效。
- codex：`apiKey` → `OPENAI_API_KEY`；`baseUrl` 存在时注入 Codex 配置 `model_provider = "<id>"`、`model_providers.<id> = { name: label, base_url: baseUrl（不以 /v1 结尾则补 /v1）, wire_api: "responses", env_key: "OPENAI_API_KEY"（有 apiKey 时）, requires_openai_auth: false（有 apiKey 时）}`；注入方式以本机 codex app-server 实际支持的为准（thread/start 的 config 覆盖或启动参数 `-c`）。端点必须支持 OpenAI Responses API。
- acp：`command` 为启动命令，`env` 合并进环境；`baseUrl` / `apiKey` 不使用。
- `models` 非空时作为静态模型列表（替代动态发现）；为空时 claude / codex 沿用各自的动态发现，并在中转环境下运行。

**协议补充**：
- `ProviderInfo` 增加 `custom?: boolean`、`extends?: "claude" | "codex" | "acp"`、`description?: string`；自定义项 `kind` 取 `extends` 的值。
- `provider.config.get {}` → `{ providers: ProviderProfile[]; path: string | null }`（含明文 apiKey，仅本机 token 鉴权的连接可见；前端负责遮挡显示）。
- `provider.config.set { providers: ProviderProfile[] }` → `{ providers: ProviderInfo[] }`：整表替换；校验失败返回 `-32602`（`data.issues`）；id 重复或与内置 id 冲突同样视为校验失败。写盘后重建自定义 provider，已在运行的会话继续使用旧配置直到关闭；之后恢复（resume）使用新配置；被删除 provider 的会话恢复时返回 `PROVIDER_NOT_FOUND`。成功后广播通知 `provider.changed {}`，前端据此刷新 provider.list。
- `provider.test { profile: ProviderProfile }` → `{ ok: boolean; status?: number; latencyMs?: number; models?: { id: string; label: string }[]; error?: string }`：可测试未保存的表单。claude：`GET {baseUrl}/v1/models`，头 `anthropic-version: 2023-06-01` 加 `Authorization: Bearer <key>`（auth_token）或 `x-api-key: <key>`（api_key）；codex：`GET {baseUrl 补 /v1}/models`，头 `Authorization: Bearer <key>`；10 秒超时；2xx 即 ok，并尽量从响应 `data[].id`（`display_name` 作为 label）解析模型列表；acp：只检查 command 能否解析。不发起任何对话，不计费。
- 日志与错误信息中不得出现 apiKey 与 `env` 的值（只打印键名）。
- 旧的 `<AGENTDECK_DATA_DIR>/acp-agents.json` 继续读取（兼容），新界面只写 `providers.json`。

**落地细则**（实现与上文有出入时以此为准）：
- Claude：`--settings` 直接接受内联 JSON（shell:false 传参，不落临时文件）；凭据隔离见下方「中转凭据隔离」。密钥因此会出现在 claude 进程的命令行与环境中，同用户进程可见；`providers.json` 为明文。
- Codex：经 `thread/start` / `thread/resume` 的 `config` 字段注入 `{ model_provider, model_providers }`，键名为 `agentdeck-<id>`（避免与用户 `config.toml` 中同名 provider 合并而带出用户密钥）。Codex 的 `model/list` 只返回内置 OpenAI 目录、不会请求中转，因此 **codex 中转应填写 `models`**。
- 「与内置冲突」：id 不得等于内置 id（claude / codex / mock）、ACP 条目去掉 `acp:` 后的名字（含 acp-agents.json 条目），以及保留字 `acp` / `custom`。可选文本字段传空字符串视为未填写；校验错误路径形如 `providers.<i>.<field>`，message 为中文。
- `provider.config.set` 返回完整 provider.list（含内置项）。
- `models` 非空时，`agent.create` 未传 model 则以 `isDefault` 模型启动，快照中 model 仍为 null。
- `command` 覆盖（claude / codex）：只认 `command[0]` 为可执行文件，解析不到即不可用，不回退 PATH；`command[1..]` 作为附加参数。
- 脱敏：apiKey 一律脱敏；env 值长度 ≥ 6 才脱敏；`turn_failed` 与 timeline 中的错误同样脱敏。
- `provider.test` 未填 baseUrl 时，claude 用 `https://api.anthropic.com`，codex 用 `https://api.openai.com/v1`。
- 已删除 / 停用 provider 的会话：运行中继续使用旧 client；关闭或 dormant 后恢复返回 `PROVIDER_NOT_FOUND`。

**Claude 中转的整份设置（settings）**（仅 `extends: "claude"`）：
- `ProviderProfile` 增加 `settings?: Record<string, unknown>`（JSON 对象，明文保存在 `providers.json`）；其它 extends 填写时校验失败。前端表单只有一个「设置 JSON」输入框。
- 不支持外部设置文件：早期版本的 `settingsFile` 字段已移除。`providers.json` 中仍带该字段的项照常加载（zod 对象默认剥离未知键），该字段被忽略并记一条中文 warn（提示把原 settings.json 内容粘贴到「设置 JSON」）；下次保存时不再写出。`provider.config.set` 传入该字段同样被剥离、不报错。
- 合并顺序（后者覆盖前者）：`settings` → 中转推导的 env（baseUrl / apiKey / 置空另一个凭据）→ `profile.env`。对象按键深合并，数组与标量整体替换。合并结果作为**一份** JSON 通过 `--settings` 传入（flag 级，优先级高于用户 / 项目 / local 设置，低于企业策略）。
- 表单未填 baseUrl / apiKey 时不推导，settings 中 `env` 里的 `ANTHROPIC_BASE_URL` / 凭据照常生效（启动前仍会剔除继承环境中的同名变量）；`provider.test` 未填 baseUrl / apiKey 时回退使用合并后 settings.env 中的值。
- **中转凭据隔离**（`launch.ts` 的 `isolateRelayCredentials`，启动与 `provider.test` 共用）：合并后（settings → 表单推导 → profile.env）有效 `ANTHROPIC_BASE_URL` 非空即为中转。中转时 `--settings` 的 env 必须同时显式写出 `ANTHROPIC_AUTH_TOKEN` 与 `ANTHROPIC_API_KEY`：profile 自己提供的保留，未提供 / 空白的写 `""`；两者都未提供时 `ANTHROPIC_AUTH_TOKEN` 写占位值 `agentdeck-no-key`。非中转原样不动。表单填了 apiKey 时仍会把未选用的那种凭据压成 `""`（即使 settings 里给了它）。
  - 依据（Claude Code 2.1.296 实测）：中转且两个凭据都为空时，claude 会把 claude.ai OAuth 令牌（`$CLAUDE_CONFIG_DIR/.credentials.json` 的 `claudeAiOauth.accessToken` 或环境变量 `CLAUDE_CODE_OAUTH_TOKEN`）作为 Bearer 发给中转；只要设置了任一凭据就不再发送 OAuth。只置空另一个凭据而不显式写出时，用户 settings 中的另一个凭据会随请求外发。
  - `provider.test` 只用 profile 自己提供的凭据；占位值不算凭据，无凭据时不带鉴权头；不读取 `~/.claude` 或进程环境中的凭据。
  - 中转时启动环境还会剔除继承的 `CLAUDE_CODE_OAUTH_TOKEN`（与占位值双重保护）；非中转的自定义配置保留它（可能正依赖它登录）。`profile.env` 显式设置的值仍在剔除之后叠加。
- `--settings` 与用户 settings 之间按 Claude Code 自身规则合并（Claude Code 2.1.296 实测）：`env` 按键合并、同名键以 flag 为准；`hooks` 跨来源叠加（两边的 hook 都执行）；`permissions.allow` 跨来源叠加（deny 推断同理，未单独测）。
- WebSearch 默认禁用的条件：表单 baseUrl 或合并后 settings.env 中的 `ANTHROPIC_BASE_URL` 任一非空，且未显式给出 `disallowedTools`。
- 合并后的整份设置（含其中密钥）会出现在 claude 的命令行中。
- 脱敏：`settings.env` 的值与 `profile.env` 同样规则脱敏；日志中不打印 settings 全文。

### 4.8 编程 Agent 可执行文件路径（Rust 命令 + sidecar 共用）

「编程 Agent」设置页可为 Claude Code / Codex 手动指定可执行文件，Rust 检测与 sidecar 启动共用同一份配置。

- **配置文件**：`<数据目录>/coding-agent-paths.json`（数据目录见 3.5，即 sidecar 的 `AGENTDECK_DATA_DIR`），内容 `{ "claude"?: string, "codex"?: string }`；键缺省、`null` 或空字符串（去首尾空白后）= 自动查找。文件不存在或不是合法 JSON 对象时视为全部自动查找（允许 UTF-8 BOM）。
- **Rust 命令**（`src/commands/coding_agents.rs`，逻辑在 `src/coding_agents.rs`）：
  - `coding_agent_paths_get` → `{ claude?: string, codex?: string }`（未配置的键省略）。
  - `coding_agent_paths_set { paths: { claude?: string | null, codex?: string | null } }` → 规范化后的同结构：整份替换；非空值必须是绝对路径且文件存在（目录不算），否则返回中文错误（`AppError` 的 message，如「Codex 可执行文件不存在：…」）且不改动已有文件；写入为「临时文件 `coding-agent-paths.json.tmp` + rename」。
  - `coding_agents_check` 读取该文件：某 agent 配置了路径时**只探测该路径**（不再回退 PATH 与常见安装点）；路径不存在时 `installed=false`，`version` 字段为「配置的路径不存在：…」。`CodingAgentStatus` 增加 `configuredPath: string | null`（未配置为 null）。
- **sidecar 优先级**：配置文件 > 环境变量（`AGENTDECK_CLAUDE_PATH` / `AGENTDECK_CODEX_PATH`）> 自动查找。配置中的路径沿用环境变量那套解析（Claude：`.cmd` shim → 真实 exe 或 cli.js，并跑 `--version` 校验；Codex：`.js` 入口 / `.cmd` shim → 平台原生 exe 或 node + codex.js，其它直接执行）。配置路径无效（不存在、shim 解析不出、Claude `--version` 失败）时 provider 不可用，`unavailableReason` 为中文原因（「配置的 … 路径不存在：…；请在「编程 Agent」页修改路径或恢复自动查找」），`agent.create` 返回 `PROVIDER_UNAVAILABLE`，**不静默回退**。基于 claude / codex 的中转（未填 `command`）同样使用该配置；中转填了 `command` 时以 `command` 为准。读取工具 `packages/sidecar/src/utils/coding-agent-paths.ts`。
- **即时生效**：sidecar 每次解析可执行文件都同步重读配置文件（文件很小）。Codex 每次 `isAvailable` / 建会话都重新解析；Claude 的解析结果原本缓存 60 秒，缓存键改为「当前配置的 claude 路径」，配置变化即作废重解析。因此保存后无需重启 sidecar，下一次 `provider.list` / 新建会话即按新配置。已在运行的会话继续使用旧可执行文件直到关闭。前端保存成功后让 `coding_agents_check` 查询与 sidecar 的 provider.list / 模型目录查询失效并重新获取。
- **前端**：`settings-coding-agents.tsx` 的 Claude Code / Codex 卡片各有「可执行文件路径」一栏（输入框占位「留空则自动查找」、「浏览…」、「保存」、「恢复自动查找」），显示当前生效路径与是否手动配置；「浏览…」经 bridge 的 `pickExecutableFile` 直接调用 dialog 插件 open（Windows 过滤 `.exe` / `.cmd`）；保存时先 `coding_agent_paths_get` 再整份 `coding_agent_paths_set`。

### 4.9 环境检查一键安装（Rust 命令）

设置「环境」页（`web/src/routes/environment.tsx`，数据来自 `environment_check`）对缺失的工具项提供「一键安装」。逻辑在 `src/environment.rs`，命令在 `src/commands/environment.rs`。

- **白名单（只在 Rust 内写死，前端只传检测项 id，绝不接受任意命令）**：
  - `git` / `bash`：Windows `winget install --id Git.Git -e`；macOS `brew install git`
  - `node` / `npm`：Windows `winget install --id OpenJS.NodeJS.LTS -e`；macOS `brew install node`
  - `ripgrep`：Windows `winget install --id BurntSushi.ripgrep.MSVC -e`；macOS `brew install ripgrep`
  - `ffmpeg`：Windows `winget install --id Gyan.FFmpeg -e`；macOS `brew install ffmpeg`
  - `agent-browser` / `claude-code` / `codex`：`npm install -g agent-browser` / `@anthropic-ai/claude-code` / `@openai/codex`（Windows / macOS）
  - winget 统一追加 `--accept-package-agreements --accept-source-agreements --disable-interactivity --silent`。Linux 及其它平台无方案（只保留 recommendation 文本）。
- **`EnvironmentCheckItem.install?`**：`{ command: string /* 展示用完整命令行 */, available: boolean, unavailableReason?: string }`，仅在该项「未找到」且当前平台有方案时给出。winget / brew / npm 按有效 PATH（`path_resolver`）查找，找不到时 `available=false`，原因分别为「未找到 winget，请从 Microsoft Store 安装“应用安装程序”」「未找到 Homebrew，…」「需先安装 Node.js（含 npm）」。
- **命令 `environment_install { id }`** → `{ ok: boolean, exitCode: number | null, output: string }`：
  - 不在白名单 / 当前平台无方案 / 安装器不可用 → 中文错误（`AppError` message）；全局同时只允许一个安装，忙时返回「已有安装任务在进行」。
  - 执行前后各 force 刷新一次有效 PATH 缓存；子进程 `.env("PATH", 有效 PATH)`、Windows `CREATE_NO_WINDOW`、stdin null、捕获 stdout/stderr；20 分钟超时结束整棵进程树（Windows `taskkill /T /F`，Unix 独立进程组 SIGKILL）。npm 在 Windows 为 `npm.cmd`，由 Rust std 经 cmd.exe 调用（参数全为常量）。
  - `output` 为 stdout + stderr 末尾最多 4000 字符（winget 进度条的 `\r` 重绘只保留每行最后一帧）。退出码 0 为成功；winget 另把 `0x8A15002B`（UPDATE_NOT_APPLICABLE）与 `0x8A150061`（PACKAGE_ALREADY_INSTALLED）视为成功。
  - winget 某些安装包会弹 UAC，属预期，不绕过。
- **前端**：缺失项有 `install` 时显示「一键安装」（`available=false` 时禁用并显示原因）；点击先 `useConfirm` 确认（展示完整命令，提示可能弹管理员授权、需要几分钟）；安装中该按钮 loading、其它安装按钮禁用；成功显示「安装完成」并让环境检查与编程 Agent 检测查询失效重取，node / npm / claude-code / codex / agent-browser 额外提示「如 Agent 仍显示不可用，请重启 sidecar」；失败显示退出码与可折叠的输出末尾。

### 4.10 思考强度（会话内可切换，下一轮生效）

参照 paseo 的 thinkingOptions（`packages/protocol/src/agent-types.ts`）。

**类型**（`agent-api.ts`）：
- `AgentThinkingOption { id: string; label: string; description?: string }`。
- `AgentModelDefinition` 增加 `thinkingOptions?: AgentThinkingOption[]` 与 `defaultThinkingOptionId?: string`（provider 自身的默认档位，仅供展示）。档位按模型挂载；ACP 的档位是会话级的，同样挂到该 provider 的每个模型上。模型没有 `thinkingOptions` 表示不支持选择思考强度（前端隐藏选择器）。
- `AgentSnapshot.thinkingOptionId?: string | null`：`null` / 缺省 = 跟随 CLI 自身设置（不传任何思考参数）。随 meta.json 持久化，恢复会话后重新设置（同 model / modeId）。
- `agent.create` 增加可选 `thinkingOptionId: string | null`（null / 省略 = 跟随 CLI）。
- 新方法 `agent.setThinking { agentId, thinkingOptionId: string | null }` → `{ agent: AgentSnapshot, notice?: string }`；`notice` 为中文提示（正在运行一轮时为「思考强度将在下一轮生效」）。provider 不支持 → `NOT_SUPPORTED`；档位不合法 → `INTERNAL_ERROR`（中文 message）；dormant 同 setModel 返回 `AGENT_CLOSED`。
- 新流事件 `{ type: "thinking_option_changed"; thinkingOptionId: string | null }`：更新快照并推 `agent.state`；provider 未发时由 AgentManager 补发，重复值去重。

**AgentManager**：
- `agent.setModel` 之后若快照 `thinkingOptionId` 非 null，按 provider 目录（建会话时取到的目录，没有再 `fetchCatalog`）查新模型（`modelId` 为 null 时取 `isDefault` 模型）；找到该模型且其 `thinkingOptions` 不含当前档位（或没有档位）→ 调 `setThinking(null)` 回退为跟随 CLI，并发 `thinking_option_changed { thinkingOptionId: null }`。目录里找不到该模型时不动。

**Claude**（`providers/claude/thinking-options.ts`）：
- 档位来源优先级：① initialize 应答 `models[]` 的 `supportsEffort` / `supportedEffortLevels`（Claude Code 2.1.296 实测每个模型都带，如 opus / sonnet / haiku 均为 low…max 五档）；`supportsEffort === false` 则无档位；② 否则按移植自 paseo `model-manifest.ts` 的清单（按 id 或 `resolvedModel` 归一化查找，清单内无 effortLevels 的模型如 Haiku 4.5 无档位）；③ 都判断不了（静态别名回退、设置发现的模型、未知 id）给标准组 low / medium / high / max。
- 「关闭思考」`off` 只给 paseo 清单中 `supportsThinkingDisabled` 的模型（按 id 或 `resolvedModel` 归一化命中）；paseo 的 `ultracode` 档位不移植。
- 档位顺序 off → low → medium → high → xhigh → max；`defaultThinkingOptionId` 为 `high`（含 high 时）。
- 下发：`--effort <level>`；`off` 为 `--thinking disabled`（隐藏参数，Agent SDK 同样使用）；null 不传。
- 会话中切换：只记录新档位；若 claude 子进程已在运行，标记「下一轮需重启」，下一次 `startTurn` 前结束旧进程，以 `--resume <sessionId>` 带新参数重新拉起（与进程意外退出后的重启是同一机制）。运行中切换返回 notice。
- 基于 claude 的中转：静态模型一律补标准组（low / medium / high / max）；未配静态模型时同内置规则。

**Codex**：
- `model/list` 每项的 `supportedReasoningEfforts[].reasoningEffort`（description 原样带上）生成档位，`defaultReasoningEffort` 为 `defaultThinkingOptionId`（不在列表里时补一项）。
- 下发：`turn/start` 带 `effort: <thinkingOptionId>`（null 不带）；setThinking 只改配置，下一次 turn/start 生效，运行中切换返回 notice。
- codex 的 turn 级 effort 覆盖会延续到后续回合，因此从具体档位切回 null 后的下一轮显式带默认档位：先取 `config/read` 的 `model_reasoning_effort`，取不到再用当前模型（未指定时为默认模型）的 `defaultReasoningEffort`；都取不到则不带。
- 基于 codex 的中转静态模型：补 low / medium / high 标准组。

**ACP**：
- 从 `session/new`（或 `session/load`）应答及 `config_option_update` 通知的 `configOptions` 中取 `category === "thought_level"` 的 select 项（分组选项展开），`options[].value` / `name` / `description` → 档位；建会话时的 `currentValue` 为 `defaultThinkingOptionId`。
- agent 不提供 `models`（如 DeepSeek Harness 只给 configOptions）但有思考档位时，目录给一个占位模型 `{ id: "default", label: "默认（跟随 Agent 设置）", isDefault: true }` 承载档位；对该占位模型的 setModel / 建会话 model 参数视为「不指定」。
- setThinking → `session/set_config_option { sessionId, configId, value }`；null 时设回建会话时的 `currentValue`。成功后发 `thinking_option_changed`。agent 没有 thought_level 项 → `NOT_SUPPORTED`。
- `config_option_update` 中 thought_level 的 `currentValue` 与已知值不同时，同步发 `thinking_option_changed { thinkingOptionId: currentValue }`。
- 建会话时带 `thinkingOptionId` 则在 session/new 后立即设置（失败只记日志，同模型）。

**前端**：
- 输入框工具栏「Agent / 模型 / 模式」后追加「思考」chip：选项 = 当前模型（未选模型时为 `isDefault` 模型）的 `thinkingOptions`，首项「默认」= null（跟随 CLI 设置）；该模型没有 `thinkingOptions` 时隐藏。
- 新建会话：选择随 `agent.create` 传入，并与模型 / 模式一起记忆在 ui_store（`agentdeck.composer.agent-selection` 增加 `thinkingOptionId`）；切换模型 / Agent 后若当前档位不在新模型选项中，重置为默认。
- 会话中：调 `agent.setThinking`，运行中也可切换（其它 chip 运行中仍禁用），显示返回的 notice；快照经 `agent.state` 同步显示。

### 4.11 provider 子代理（Claude / Codex；ACP 不支持）

参照 paseo 的 provider subagents（`packages/server/src/server/agent/provider-subagents/store.ts`、`providers/claude/subagents/*`、`providers/claude/sidechain-tracker.ts`、`providers/codex-app-server-agent.ts`，以及 `packages/protocol/src/messages.ts` 的 `agent.provider_subagents.*`）。子代理**只存在于 sidecar 内存**，不落盘、不随会话恢复；父时间线里的 `sub_agent` 工具卡片照常持久化。

**类型**（`agent-api.ts`）：
- `ToolCallDetail` 增加 `sub_agent`（见 4.3）：父会话时间线中「派出子代理」的工具卡片。`log` 每行一个动作，形如 `[Read] src/a.ts`（`[工具显示名] 摘要`，无摘要时只有 `[工具显示名]`）；Codex 还会出现 `[Assistant] …` / `[Thought] …` / `[User] …` 行。前端显示名取 `subAgentType ?? "Task"`、摘要取 `description`。
- `ProviderSubagentStatus = "running" | "completed" | "failed" | "canceled"`。
- `ProviderSubagentDescriptor { id; parentAgentId; parentSubagentId: string | null; provider; title: string | null; description: string | null; status; createdAt: number; updatedAt: number; toolCallId: string | null; cwd: string | null; subtitle: string | null }`（时间为毫秒时间戳）。`parentSubagentId` 为 null 表示父会话的直接子代理，否则为上级子代理 id（孙代理）。
- `ProviderSubagentTimelineRow { seq; timestamp; item: AgentTimelineItem }`：每个子代理一条独立时间线（seq 从 1 递增），item 与主时间线同形（`assistant_message` / `reasoning` 可能是增量，前端照主时间线规则拼接）。
- `ProviderSubagentUpdate`：
  - `{ kind: "upsert"; agentId; subagent }`
  - `{ kind: "timeline"; agentId; subagentId; row }`
  - `{ kind: "remove"; agentId; subagentId }`

**RPC**：
- `agent.subagents.list { agentId }` → `{ subagents }`：该会话全部层级的子代理，按 createdAt 升序；agent 不存在 → `AGENT_NOT_FOUND`。
- `agent.subagents.timeline { agentId, subagentId, direction?: "tail" | "before" | "after", cursorSeq?: number, limit?: number }` → `{ rows, hasOlder, hasNewer }`：`tail`（缺省）取最近 limit 条；`before` 取 `seq < cursorSeq` 的最近 limit 条；`after` 取 `seq > cursorSeq` 的前 limit 条（before / after 缺 cursorSeq 时按 tail 处理）。limit 缺省 200，范围 1–1000。子代理不存在返回空 rows（不报错）。
- 通知 `agent.subagents.update`：向所有连接广播，前端按 `agentId` 过滤。

**sidecar 内部**：
- provider 会话通过内部流事件 `{ type: "provider_subagent"; event }` 上报（不进主时间线、不占 seq，`AgentSession.subscribe` 的回调类型为 `AgentSessionEvent = AgentStreamEvent | ProviderSubagentStreamEvent`）。`event`：
  - `{ type: "upsert"; id; title?; description?; status?; toolCallId?; cwd?; subtitle?; parentSubagentId?; timestamp? }`：字段**省略 = 保留原值，显式 null = 清空**；status 省略时保留（新建默认 running）。
  - `{ type: "timeline"; id; item; timestamp? }`：追加到该子代理时间线（不存在则先建空时间线，但不建描述）。
  - `{ type: "remove"; id }`。
- `ProviderSubagentStore`（`agent/provider-subagent-store.ts`）：键 `parentAgentId\0subagentId`；每个子代理时间线最多保留 2000 行（超出丢最旧的，hasOlder 以实际保留为准）。AgentManager 在事件尾链中拦截 `provider_subagent` 写入 store，并经监听器 `onSubagent` 推给 RpcServer 广播。
- 清理：会话关闭（`agent.close`、shutdown）与删除时清空该会话的全部子代理，并逐个广播 `remove`。

**Claude**：
- initialize 控制请求体带 `forwardSubagentText: true`（与 Agent SDK 一致；不加则 CLI 不转发子代理的完整 assistant 消息）。
- task 协议（Claude Code 2.1.296 实测）：`system` 消息 `task_started { task_id, tool_use_id, description, subagent_type, task_type, prompt, skip_transcript? }`、`task_updated { task_id, patch: { status?, is_backgrounded? } }`、`task_progress { task_id, usage: { total_tokens } }`、`task_notification { task_id, tool_use_id, status, usage? }`。只把 `task_type` 为 `local_agent` / `local_workflow`（无 task_type 时要求有 subagent_type）、且未标 `skip_transcript` 的任务当作子代理；`local_bash`（后台命令）等忽略。子代理 id = `task_started.tool_use_id`（同一 task 再次 task_started 带新 tool_use_id 时视为别名）；状态 pending / running / paused → running，completed → completed，failed → failed，killed / stopped → canceled。title 取 Task 调用 input 的 `name`，否则 `subagent_type`（workflow 为 `Workflow`）；description 取 `task_started.description`；首条子代理时间线为 `user_message`（task prompt；workflow 用 description）。subtitle 为「类型 · 模型 · effort · Nk tokens」（模型取子代理 assistant 帧的 `message.model`，tokens 取 task_progress / task_notification 的 usage；effort 不采集）。
- 带 `parent_tool_use_id` 的帧（子代理 sidechain）不进父时间线：本会话已出现过 task 公告后，未声明的 id 的帧直接丢弃；否则交给 sidechain tracker：完整 assistant 消息的 text → `assistant_message`、thinking → `reasoning`、tool_use → running `tool_call`；子代理 user 消息里的 tool_result → completed / failed `tool_call`；**不处理子代理的 stream_event 增量**。tracker 同时维护父卡片 `sub_agent` detail 的 log（最多 200 条、单条摘要 160 字）。
- 父卡片：callId 为 Task/Agent 的 tool_use_id。主时间线的 Task/Agent 工具调用本身 detail 即为 `sub_agent`（subagent_type → subAgentType，description → description）；`task_started` 时立即补一张父卡片（后台子代理没有 sidechain 帧）；sidechain 帧到达时更新 log。同一 callId 的后续推送在 sidecar 内合并（保留已有 log / 类型 / 描述；终态不会被 running 覆盖），因此「后者覆盖前者」对前端仍成立。嵌套子代理（由子代理派出）的父卡片只出现在上级子代理的时间线里，不进父会话时间线；其 `parentSubagentId` 为上级子代理 id。
- 生命周期：回合被中断时，未后台化（`task_updated.patch.is_backgrounded` 不为 true）且仍在运行的子代理记为 canceled；claude 进程意外退出时所有仍在运行的子代理记为 failed；`task_notification` 之后的状态以它为准。父消息出现该 Task/Agent 的 tool_result 时 tracker 结束该 sidechain。
- 不做：子代理 effort hooks、从磁盘回放子代理历史。

**Codex**：
- `collabAgentToolCall`（spawnAgent / wait 等）与 `subAgentActivity` 映射为 `sub_agent` detail（名称 `Sub-agent`；collab 的 description 为 prompt；状态由 `agentsStates` 汇总：任一子线程 failed / notFound → failed，shutdown → canceled，全部 completed → completed，否则 running；subAgentActivity 的 subAgentType 由 agentPath 生成，kind interrupted → canceled、completed → completed，其余 running）。
- codex-cli 0.162.1 实测：派出子代理是主线程上的 `subAgentActivity`（kind `started`，`agentThreadId` 为子线程），子线程回合结束时主线程收到 `subAgentActivity`（kind `completed`，id `subagent-completed-…`）；`wait` 是 `receiverThreadIds` 为空的 `collabAgentToolCall`，作为普通 sub_agent 卡片显示。已登记子线程的 subAgentActivity 只更新原卡片，不另起卡片；子线程发给父线程的 subAgentActivity（`agentThreadId` 为父线程）不把父线程登记成子代理。
- 主线程上出现 sub_agent 工具项时登记 `receiverThreadIds` 与 `agentThreadId`（子线程 → 父 callId，先登记者为准），对每个子线程发 upsert（子代理 id = 子线程 id，title = subAgentType，description，toolCallId = callId）。
- 按通知的 threadId 路由：主线程 → 原逻辑；已登记子线程 → 子代理时间线（`item/agentMessage/delta`、`item/reasoning/*Delta` 增量照发；`item/started` / `item/completed` 的工具项与完整消息；`turn/started` → running，`turn/completed` → completed / failed / canceled）；未登记的其它线程先缓冲（最多 32 个线程、每线程 128 条，超出丢最旧），登记后按序回放。子线程活动同时累积到父卡片：log 由子线程条目整理（`[工具] 摘要`、`[Assistant] 文本`、`[Thought] 文本`），父卡片在子线程条目开始 / 完成与回合变化时重推（文本增量只累积、不逐条重推，避免父时间线被大量卡片更新淹没；终态不被 running 覆盖，子线程重新 turn/started 时可重新打开）；嵌套子线程的卡片冒泡到上级子代理。
- 子线程通知不受父会话是否在回合中的限制。恢复会话时不递归读取子线程历史。

**前端**：
- 时间线 `sub_agent` 卡片：显示名为 subAgentType（缺省 Task）、标题行为 description；展开显示 log 解析出的动作列表（`[Tool] summary` 行）与其余文本、状态。同一 callId 的工具卡片在任意已有消息里按 callId 原地更新（子代理活动可能晚于回合结束）。
- 输入框上方「子代理」药丸：只统计当前层级（父会话视图为 `parentSubagentId === null`），文案按状态计数如「2 运行中 · 1 失败」，没有运行中 / 失败时显示「N 个子代理」；展开列出子代理行（标签优先 description，其次 title；行尾 subtitle 与状态），点击一行打开子代理面板。
- 子代理面板：右侧分栏（与预览面板同位置，打开时替代预览面板），只读时间线（复用主时间线渲染，无输入框、无审批卡片），顶部「加载更早记录」按 before 分页；面板内也有本层级的子代理药丸，可进入孙代理并返回上一级。
- 数据：进入会话时 `agent.subagents.list` 拉一次（重连后重拉），之后由 `agent.subagents.update` 增量维护；打开面板时 `agent.subagents.timeline` 拉 tail，之后实时 timeline 行按 seq 追加去重。

### 4.12 CLI 自发轮次（origin: "background"）

Claude Code 的后台子代理（`Agent` 工具 `run_in_background`）与后台命令（`Bash` `run_in_background`）完成后，CLI 会把 `<task-notification>` 注入为一条内部 user 消息并**自行开始新的一轮**，不需要 AgentDeck 发 prompt。参照 paseo 的 autonomous turn（`providers/claude/agent.ts` 的 `startAutonomousTurn` / `completeAutonomousTurn`）。

**协议**：
- `AgentTurnOrigin = "background"`；`turn_started` 增加可选 `origin`，缺省 = 由 `agent.send` 发起，`"background"` = provider 在没有 startTurn 的情况下自行开始的轮次。之后的 timeline / 权限 / usage 与普通回合相同，结束时同样只发一次 `turn_completed` / `turn_failed` / `turn_canceled`。
- AgentManager：自发轮次同样置 `status: "running"`、`activeTurnId`，结束恢复 `idle`（与普通回合同一套快照、落盘与 agent.state 推送）；不写 `user_message`。自发轮次进行中 `agent.send` **不**返回 `TURN_IN_PROGRESS`，交给 provider 的 startTurn 接管（见下）；普通回合进行中仍返回。`agent.cancel` 对自发轮次同样有效。
- 前端：没有前置用户消息的 `turn_started` 另起一条助手消息（回放同理），运行态显示「运行中」，结束后恢复；输入框在运行中照常禁用、可中断。

**Claude（2.1.296 实测 stream-json 线上格式）**：
- 自发轮次的输出顺序：`system task_notification`（子代理 / 后台命令完成）→ `system init` → `status requesting` → `stream_event` / `assistant` … → `result`（**不带** `user_message_uuid`）；之后常紧跟一个只有 `init` + 空 `result`（同样不带 uuid）的空轮。被注入的 `<task-notification>` user 消息**不会**出现在 stdout，因此不存在「把注入消息显示成用户消息」的问题（provider 本来也不发 `user_message`）。用户发起的每一轮（含 `/cost`、`/compact` 等本地斜杠命令）的 result 都回显 `user_message_uuid`。
- 识别：CLI 每开始一轮都先发 `system init`。收到 init 时没有进行中的回合 → 记「CLI 正在自发跑一轮」，等它真正有内容（`status requesting`、主线程 `stream_event` / `assistant` / `user`，或工具权限请求）时才开自发轮次（发 `turn_started { origin: "background" }`），之后照常翻译，收到任意 result 结束（success → `turn_completed`，否则 `turn_failed`）；只有 init + result 的空轮不显示。与 paseo 用 assistant / stream_event 等「像输出的消息」直接触发不同，这里以 init 为前提：中断后 CLI 还会吐出被中断那一轮的尾巴（没有 init），不会被误开成新回合，也就不需要 paseo 的 pendingInterruptAbort 抑制。
- 后台任务完成提示（参照 paseo `task-notification-tool-call.ts` / `appendTaskNotificationEvents`）：非子代理任务（如后台命令 `local_bash`）的 `task_notification` 转成一张已结束的工具卡片：`name: "task_notification"`，`callId: "task_notification_<task_id>"`，detail `plain_text`（label = `summary`，如 `Background command "…" completed (exit code 0)`，缺省为「后台任务已完成 / 失败 / 已停止」；有 `output_file` 时 text 为「输出文件：…」），status completed / failed（failed / error）/ canceled（stopped / killed），`metadata.source = "claude_task_notification"`。子代理任务的完成已由子代理卡片与状态表达，不出卡片；子代理发起的任务进该子代理的时间线。没有进行中的回合时先暂存，下一轮（通常就是紧随其后的自发轮次）`turn_started` 之后再发。
- 竞态（自发轮次中用户发送，参照 paseo `startTurn` 先 `completeAutonomousTurn`）：startTurn 先作废仍挂起的审批（否则 CLI 卡在审批上、用户消息永远轮不到），发自发轮次的 `turn_completed`，再发新回合的 `turn_started`，用户消息照常写入 stdin——CLI 把它排在当前这一轮之后（实测 `command_lifecycle` 为 queued，自发轮次的 result 之后才 started，并有自己带 uuid 的 result）。自发轮次剩余的输出（以及紧随的空轮）并入新回合（不丢）；用户回合里不带 uuid 的 result 都属于排在用户消息之前的自发轮次，一律跳过（会话里见过一次 uuid 回显后生效；此前作为兜底只跳过一次），新回合以回显自己 uuid 的 result 结束。CLI 刚发 init、自发轮次还没显示时用户发送，同样按「先到的无 uuid result 不属于本回合」处理。接管时若有「思考强度切换待重启」，推迟到之后的回合，免得杀掉正在进行的那一轮。
- 中断：`interrupt()` 对自发轮次同样发 interrupt 控制请求并 `turn_canceled`；之后的过期 result 因没有进行中的回合而丢弃。
- 已知局限：用户在「接管后的新回合」里中断时，CLI 中断的是仍在跑的自发那一轮，已排队的用户消息仍可能随后执行；它以 init 开头，会作为新的自发轮次显示，不会丢失或卡住。

**Codex**（codex-cli 0.162.1 实测，主线程派出子代理后不 wait 直接结束回合）：子线程跑完后主线程只收到一条 `item/started` / `item/completed`（`subAgentActivity`，kind `completed`，turnId 为**已结束**的父回合），180 秒内主线程没有新的 `turn/started`——app-server 不会在没有 `turn/start` 的情况下自行开始主线程回合，无需处理。该条 subAgentActivity 因 turnId 属于已结束回合而被忽略，父卡片的完成状态由子线程的 `turn/completed` 路由更新（4.11）。

### 4.13 Agent 提问（AskUserQuestion）与上下文压缩

**提问（仅 Claude）**：Claude Code 的 `AskUserQuestion` 工具经 `can_use_tool` 到达，input 为 `{ questions: Array<{ question; header; options: Array<{ label; description; preview? }>; multiSelect }> }`（1–4 题，每题 2–4 个选项，「其他」由界面自行提供）。CLI 从 `updatedInput.answers` 读回答案，allow 时不带 `answers` 会被视为「用户没有回答」。
- 类型：`ToolCallDetail` 增加 `{ type: "question"; questions: AgentQuestion[]; answers?: Record<string, string> }`；`AgentQuestionOption { label; description?; preview? }`、`AgentQuestion { question; header?; multiSelect; options }`。`answers` 的键为 question 原文，值为选中的 label；多选以 `", "` 拼接；「其他」自由输入时值为用户文本。
- sidecar：`permission_requested` 的 `kind: "question"`、title「Claude 有问题需要你回答」、`detail` 为 question 类型（宽松解析，非法题目 / 选项跳过）、actions `[{ id: "submit", label: "提交回答", behavior: "allow" }, { id: "skip", label: "跳过", behavior: "deny" }]`。应答 allow 时 `updatedInput = { ...原 input, ...response.updatedInput }`（保证 questions 原样回传），合并后没有非空 `answers` 对象则按 deny 处理（message「用户没有回答问题」）；deny 缺省 message 为「用户跳过了这些问题」。合并后的 input 同时写回该工具调用（按 tool_use_id）的记录，工具卡片完成时 detail 带上 answers。时间线中的 AskUserQuestion 工具卡片 detail 同为 question 类型（answers 取自 input.answers）。
- 前端应答：提交 `{ behavior: "allow", selectedActionId: "submit", updatedInput: { ...request.input, answers } }`；跳过 `{ behavior: "deny", selectedActionId: "skip", message: "用户跳过了这些问题" }`。

**上下文压缩**：`AgentTimelineItem` 增加 `{ type: "compaction"; compactionId; status: "running" | "completed" | "failed"; trigger?: "auto" | "manual"; preTokens?; error? }`，同 compactionId 多次推送后者覆盖前者（与 tool_call 相同）。`failed` 为对原设计的最小补充：Claude 压缩失败时只有 `status` 消息（`compact_result: "failed"`）而没有 `compact_boundary`，不补这一态「正在压缩」会一直挂着。
- Claude：`system` `status: "compacting"` → running（compactionId 为 `compact-<uuid>`）；`system` `compact_boundary`（`compact_metadata.trigger` / `pre_tokens`）→ 同一 id 的 completed（之前没有 running 时新建 id）；`status` 消息带 `compact_result: "failed"` 且有进行中的压缩 → failed（error 取 `compact_error`）。需要时以 4.12 的规则开自发回合。压缩完成后上下文用量的「已用」改为 `compact_metadata.post_tokens`（没有则清零），下一次 `message_start` 自然刷新，避免压缩后 result 仍报压缩前的大数字。
- Codex：ThreadItem `contextCompaction`（兼容 `context_compaction`）的 `item/started` → running、`item/completed` → completed（compactionId = item.id），不产生工具卡片；旧版 `thread/compacted` 通知在本回合没见过 contextCompaction item 时补一条 completed。
- 前端：每个 compactionId 对应一条居中分隔线样式的系统提示（消息 id `agent-compaction-<compactionId>`）：running「正在压缩上下文…」，completed 原地改为「上下文已自动压缩 / 上下文已手动压缩」（有 preTokens 时附「（压缩前 约 84.1k tokens）」），failed「上下文压缩失败」。提示插在当前回合尚无内容的助手消息之前，否则追加在末尾。completed 时清掉运行时 usage 的 `contextWindowUsedTokens`，输入框的上下文用量指示器随之隐藏，直到下一次 usage 到达。

**回合中的上下文用量（Claude）**：result 才带完整 usage，新会话 / 刚恢复 / 压缩后「思考中」整轮都没有可显示的用量，所以：
- 主线程（非子代理 sidechain）每个 `message_start` 发一次 `usage_updated`，只带 `{ contextWindowUsedTokens, contextWindowMaxTokens? }`（已用 = input + cache_creation + cache_read）。上限取最近已知的 contextWindow（result 的 `modelUsage` 缓存到会话）。
- 上限未知时向 CLI 发控制请求 `{ subtype: "get_context_usage" }`（应答 `totalTokens / maxTokens / rawMaxTokens / percentage / model`），拿到 `maxTokens` 后缓存并补发一次 `usage_updated`；失败只记 debug，不再重试（切换模型后重置）。会话进程 initialize 完成后也调一次，用 `totalTokens` 作为已用（还没有 message_start 时），让恢复的会话在第一轮之前就有用量。切换模型清掉缓存的上限。
- 这些中途事件不带 `inputTokens / outputTokens`，不进入 `totalUsage`；result 的完整 usage 覆盖同名字段。

### 4.14 斜杠命令与 MCP 状态

**类型**（`agent-api.ts`）：
```ts
export interface AgentSlashCommand { name: string; description?: string; argumentHint?: string; aliases?: string[] }   // name 不带前导 /
export type AgentMcpServerStatus = "connected" | "failed" | "needs-auth" | "pending" | "disabled";
export interface AgentMcpServer { name: string; status: AgentMcpServerStatus; error?: string; scope?: string; toolCount?: number }
export interface AgentStatusSection { title: string; rows: Array<{ label: string; value: string }> }   // value 为已格式化的中文文本
export type AgentMcpReconnectScope = "server" | "all";   // server = 可按服务器单独重连（Claude）；all = 只能整体重新加载（Codex）
export interface AgentMcpStatusResult { servers: AgentMcpServer[]; reconnect: AgentMcpReconnectScope }
```

**RPC**：
- `agent.status { agentId }` → `{ sections: AgentStatusSection[] }`：AgentDeck 本地 `/status`（Claude 无头模式没有该命令，initialize 的命令列表里也没有）。会话处理与 `agent.mcp.status` 完全一致（dormant / closed 且可恢复时先自动恢复，不受单 turn 约束，不可恢复按 4.5 报错），会话没实现 `getStatus` → `NOT_SUPPORTED`（「该 Agent 不支持查看状态」）。分组与行都是「缺的项跳过」，MCP 查询失败只在 MCP 分组显示「读取失败：…」，不让整体失败。自定义中转的 `getStatus` 逐行值按 4.7 规则脱敏。
- `agent.commands { agentId }` → `{ commands }`：结果按 name 去重（保留第一次出现）。有活会话且 provider 实现了 `listCommands` 时用它（失败记日志后退回目录）；否则（dormant / closed / 未实现）取 `client.fetchCatalog({ cwd })` 的 `commands`，没有则 `[]`。**不为此恢复会话**。agent 不存在 → `AGENT_NOT_FOUND`。
- `agent.mcp.status { agentId }` → `AgentMcpStatusResult`；`agent.mcp.reconnect { agentId, serverName? }` → 重连后再查一次的最新状态。需要活会话：dormant / closed 且可恢复时按 4.5 的规则先自动恢复（与 `agent.send` 共用同一次恢复，并发调用只恢复一次）；不可恢复按 4.5 返回 `NOT_SUPPORTED`（dormant）/ `AGENT_CLOSED`（closed）。会话没实现 → `NOT_SUPPORTED`（「该 Agent 不支持查看 MCP 服务器」/「该 Agent 不支持重连 MCP 服务器」）。**不受单 turn 约束**：回合进行中也可查询 / 重连。`serverName` 传空字符串为 `-32602`。
- `AgentClient.fetchCatalog` 的返回值增加可选 `commands`（sidecar 内部）；`provider.listModels` 的结果**不含** commands，保持 `{ models, modes }`。

**Claude**：
- 来源：`initialize` 控制应答的 `commands: Array<{ name; description; argumentHint; aliases? }>`（内置命令、skill、项目 / 用户命令，可能重名）；CLI 中途推 `system` `commands_changed { commands }` 时**整体替换**缓存（不进时间线）。宽松解析：name 非空字符串才收，description / argumentHint 为空不带，aliases 只留非空字符串；按 name 去重。
- `listCommands`：最近一次 `commands_changed` 的列表，否则会话进程 initialize 应答里的（进程重启后以新进程的应答为准）。claude 进程是懒启动的（首轮才拉起），尚未启动时**不为此启动**，退回 provider 目录的 commands。
- `fetchCatalog`：模型探测的临时进程（只发 initialize）顺带读出 commands。commands 与 cwd 相关（项目级 skill / 命令），而模型缓存不分 cwd，所以 commands **按 cwd 单独缓存** 10 分钟（最多 32 个目录）：模型与该 cwd 的命令都命中缓存才不起探测进程，否则按该 cwd 探测一次（同一 cwd 的并发探测共用）；未传 cwd 时只要模型命中就不为命令单独探测。代价：换一个新目录的第一次 `provider.listModels` 会多起一次探测进程（不对话、不计费）。
- MCP：控制请求 `{ subtype: "mcp_status" }` → `{ mcpServers: Array<{ name; status; error?; scope?; tools?: { name }[]; … }> }`，映射为 `AgentMcpServer`（status 不在五个合法值内归为 `pending`，toolCount = tools 数组长度），`reconnect: "server"`；`{ subtype: "mcp_reconnect", serverName }` 重连单个服务器，超时 60 秒，失败时控制应答为 error（以中文前缀转成 `INTERNAL_ERROR`）。MCP 需要运行中的 claude 进程：未启动时先拉起（不发用户消息，之后的回合复用该进程）。**Claude 的 reconnect 必须带 serverName**，缺省返回 `NOT_SUPPORTED`（「Claude 需要指定要重连的 MCP 服务器（serverName）」）。
- CLI 本地命令输出：`/usage` 等本地命令的结果由 CLI 以 `message.model === "<synthetic>"` 的完整 assistant 消息返回（0 tokens，无 stream_event 增量），其 text 块产出的 `assistant_message` 带 `source: "command"`（普通消息不带）。coalescer 只合并 messageId 与 source 都相同的相邻块。前端对 command 消息原样显示：不走 Markdown，`white-space: pre-wrap` 等宽字体、细边框块，上方弱化小标签「命令输出」，复制按钮照常。
- `/compact` 不需要专门代码：作为普通 user 消息发送即触发压缩，result 照常回显 user_message_uuid，压缩事件见 4.13。

**Codex**：
- 斜杠命令只有 `[{ name: "compact", description: "压缩当前对话上下文" }]`（`listCommands` 与 `fetchCatalog` 相同；带静态模型的 codex 中转同样返回）。
- `/compact` 拦截：`startTurn` 的 prompt 去掉首尾空白后**恰好**是 `/compact`（字符串，或只有一个 text 块且无图片）时，不调 `turn/start`，改调 `thread/compact/start { threadId }`（→ `{}`）；复用 ensureClient / ensureThread、首轮 `thread_started`、失败以 `turn_failed` 结束等普通回合路径。原生 turnId 由随后的 `turn/started` 通知设置，`contextCompaction` item → compaction（4.13），`turn/completed` 结束回合。`/compact 其它文字` 等其它情况照常走 `turn/start`。
- `getMcpStatus`：`mcpServerStatus/list { threadId, detail: "toolsAndAuthOnly", cursor? }`，有 `nextCursor` 就继续翻页（最多 20 页）汇总；线程尚不存在时先建线程（与回合并发时共用同一次 thread/start）。runtimeStatus 映射：connected → connected、authenticationRequired → needs-auth、failed / cancelled → failed、disabled → disabled、其余（notStarted / starting / null）→ pending；error 取 `toolsError`；toolCount = tools 的键数；`reconnect: "all"`。
- `reconnectMcp`：忽略 serverName，调 `config/mcpServer/reload`（无 params，→ `{}`）：从磁盘重载 MCP 配置并整体生效，没有按服务器重连。

**`/status` 内容**（`AgentSession.getStatus?(): Promise<AgentStatusSection[]>`）：
- Claude：「会话」= Claude Code 版本（`claude --version` 探测结果）/ 会话 ID / 工作目录 / 模型（快照 model，null 显示「默认（跟随设置）」）/ 权限模式 / 输出风格（initialize 应答 `output_style`）；「账户」= initialize 应答 `account`（SDK AccountInfo：email / organization / subscriptionType / apiProvider / tokenSource / apiKeySource，没有任何字段时整组省略）；「MCP」= 调现有 `getMcpStatus` 汇总，如「3 个服务器：1 已连接，1 失败，1 需要认证」，未连接的服务器逐个列出并带错误。需要活进程（未启动时先拉起，同 MCP）。
- Codex：「会话」= 线程 ID（尚无线程时跳过）/ 工作目录 / 模型 / 模式；「账户」= `account/read { refreshToken: false }`（apiKey / chatgpt（邮箱、套餐）/ amazonBedrock / null → 「未登录」），读取失败跳过；「用量限制」= `account/rateLimits/read` 的 `rateLimits.primary` / `secondary` 窗口，显示「已用 N%，约 X 后重置」，窗口名由 `windowDurationMins` 推出（300 → 「5 小时窗口」、10080 → 「每周窗口」，未知为「主要 / 次要窗口」），读不到跳过；「MCP」同上。
- ACP 不实现（`NOT_SUPPORTED`）。

**ACP**：sessionUpdate `available_commands_update { availableCommands: Array<{ name; description; input?: { hint } }> }` 缓存为 `AgentSlashCommand[]`（argumentHint = input.hint，按 name 去重；loadSession 重放期间收到的同样记录），`listCommands` 返回缓存（没收到过为 `[]`）。ACP 不实现 MCP 方法（`NOT_SUPPORTED`）。ACP 的 `fetchCatalog` 不带 commands。

**自定义中转**（4.7）：会话包装层转发 `listCommands` / `getMcpStatus` / `reconnectMcp`，MCP 的 error 文本按 4.7 规则脱敏。基于 claude 且配了静态 `models` 的中转，`fetchCatalog` 不起探测进程，因此会话未加载时 `agent.commands` 为空（会话运行后照常有命令）。

**前端约定**：
- Claude / Codex 会话中输入 `/mcp` 在前端本地拦截，打开 MCP 面板（`agent.mcp.status` / `agent.mcp.reconnect`），**不发给 Agent**；面板按 `reconnect` 决定是逐个服务器「重连」（server）还是一个「重新加载全部」（all）。
- Claude / Codex 会话中输入 `/status`（文本 trim 后恰为 `/status` 且无附件）同样本地拦截，不发送、不排队，打开状态对话框（`agent.status`）：按分组显示两列键值表，值可选中复制、长值换行，有加载中 / 错误态与「刷新」按钮。斜杠命令补全里本地 `mcp`、`status` 依次置顶（badge「AgentDeck」，status 描述「查看会话、账户与 MCP 状态」）。
- 手动压缩 = 发送 `/compact`（Claude 由 CLI 处理，Codex 由 sidecar 拦截为 `thread/compact/start`）。

### 4.15 后台任务（仅 Claude；Codex / ACP 不支持）

Claude 用 `run_in_background` 跑的后台 Shell 命令（Bash / PowerShell 工具）在 CLI 里是 `local_bash` task。AgentDeck 只把**后台 Shell**登记成「后台任务」，供界面按会话列出、在右侧面板看命令与实时输出、单独停止；子代理 / workflow（`local_agent` / `local_workflow`）由 4.11 的子代理列表负责，不进后台任务。任务表只存在 sidecar 内存，不落盘、不随会话恢复（sidecar 重启后为空）。

**类型**（`agent-api.ts`）：
```ts
export type AgentBackgroundTaskKind = "command" | "agent" | "workflow" | "other";   // 目前只会产生 "command"（local_bash）；其余保留类型兼容，前端不再区分
export type AgentBackgroundTaskStatus = "running" | "completed" | "failed" | "stopped";  // pending / paused 归 running；killed 归 stopped
export interface AgentBackgroundTask {
  taskId: string; kind: AgentBackgroundTaskKind; description: string; status: AgentBackgroundTaskStatus;
  startedAt: number; endedAt?: number;          // 毫秒时间戳
  summary?: string; error?: string; lastToolName?: string;
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
  hasOutput?: boolean;                          // 有可读的命令输出文件（只对 command）
  command?: string;                             // 后台命令文本：取自对应 Bash / PowerShell tool_use 的 input.command（用 tool_use_id 关联）
  exitCode?: number;                            // 退出码：从 task_notification 的 summary 里的 `exit code N` 解析，解析不到不填
}
export interface AgentBackgroundTaskOutput { text: string; truncated: boolean; size: number }
```

**RPC / 通知**：
- `agent.tasks.list { agentId }` → `{ tasks }`：有活会话且实现了 `listBackgroundTasks` 时取会话的任务表，否则取 AgentManager 缓存的最近一次快照（没有为 `[]`）；不恢复会话；agent 不存在 → `AGENT_NOT_FOUND`。
- `agent.tasks.stop { agentId, taskId }` → `{}`：会话进程未运行（dormant / closed）→ `AGENT_CLOSED`（不为此恢复会话）；会话没实现 → `NOT_SUPPORTED`；taskId 未知 → `TASK_NOT_FOUND`；任务已结束则什么也不做。成功只表示已发出停止请求，终态由随后的 `agent.tasks.update` 带回。
- `agent.tasks.output { agentId, taskId, maxBytes? }` → `{ text, truncated, size }`：读输出文件**尾部**，`maxBytes` 缺省 64KB、上限 256KB（超过按上限；非正整数为 `-32602`），按 UTF-8 解码；文件超过 maxBytes 时 `truncated: true` 并丢弃不完整首行；`size` 为文件当前总字节数；没有输出路径或文件不存在返回空文本。错误码同 stop。**只读 CLI 为该任务报告过的路径**，不接受前端传路径。
- 通知 `agent.tasks.update { agentId, tasks }`：整表推送，向所有连接广播，前端按 agentId 过滤。登记 / 状态 / 输出路径变化立即推；`task_progress` 这类进度变化节流到约 1 秒一次（尾部补发最新整表）。
- `TASK_NOT_FOUND` 是新增的业务错误码（`AgentRpcBusinessErrorCode`）。

**sidecar 内部**：
- `AgentSession` 增加可选 `listBackgroundTasks()` / `stopBackgroundTask(taskId)` / `readBackgroundTaskOutput(taskId, maxBytes)`；内部流事件 `{ type: "provider_background_tasks"; tasks }`（整表快照，不进时间线、不占 seq、不落盘，`AgentSessionEvent` 的第三种）。AgentManager 在事件尾链里缓存到该 agent 并经监听器 `onTasks` 推给 RpcServer 广播。
- 自定义中转（4.7）的会话包装层转发这三个方法与事件，描述 / 命令 / 摘要 / 错误 / 输出文本按 4.7 规则脱敏。

**Claude**（`providers/claude/background-tasks.ts` 的登记表）：
- 数据来源（协议见 4.11 的 task 消息，2.1.296 实测，类型参考 SDK 的 SDKTaskStarted / Updated / Progress / NotificationMessage）：`task_started { task_id, tool_use_id?, description, task_type?, subagent_type?, is_backgrounded? }`、`task_updated { task_id, patch: { status?, description?, end_time?, error?, is_backgrounded? } }`、`task_progress { task_id, usage: { total_tokens, tool_uses, duration_ms }, last_tool_name?, summary? }`、`task_notification { task_id, status: completed | failed | stopped, output_file, summary, usage? }`。
- 只登记**后台 Shell**：`task_type` 为 `local_bash` 且 `is_backgrounded === true`，或之后 `task_updated` 的 patch 把 `is_backgrounded` 变为 true 时再登记；没有 `task_type`（旧 CLI）时，以对应 tool_use 是 Bash / PowerShell 为准，仍要求 `is_backgrounded`。CLI 对**前台** Bash 也发 `task_started`（`is_backgrounded: false`），这些不登记（未转入后台就结束的直接丢弃记录）；`local_agent` / `local_workflow` / 其它 task_type 一律不登记。不论命令由主线程还是子代理发起，后台的都登记。`skip_transcript` 的任务也登记（这是任务面板）。
- 命令文本：assistant 的 `tool_use { id, name: "Bash" | "PowerShell", input: { command, run_in_background? } }` 先于 `task_started` 到达，按 `tool_use_id` 暂存 `input.command`（含子代理 sidechain 里的 tool_use，条数有上限、淘汰旧的），`task_started` 时用 `tool_use_id` 关联到 `command`；`task_started` 先到则在 tool_use 到达时补上并推送。
- 退出码：`task_notification.summary` 形如 `Background command "…" completed (exit code 0)`，宽松正则 `exit codes+(-?d+)` 解析为 `exitCode`，解析不到不填。
- 状态：pending / running / paused → running，completed → completed，failed → failed，killed / stopped → stopped；`endedAt` 取 `patch.end_time`，没有则取收到时刻；进度不会让已结束的任务复活，`task_updated` 明确给出的状态以它为准。
- 输出路径：后台 Bash 的工具结果文本形如 `Command running in background with ID: bk63yjvxs. Output is being written to: C:\Users\…\tasks\bk63yjvxs.output`，用 `tool_use_id` 关联到 task_started（结果可能先于 task_started 到达，先缓存），宽松正则 `Output is being written to:\s*(.+?\.output)`；`task_notification.output_file` 作兜底。
- 停止：控制请求 `{ subtype: "stop_task", task_id }`（30 秒默认超时）；成功时不在本地改状态，等 CLI 的 `task_updated` / `task_notification`。**失败兜底**：若该任务仍为 running 且不在最新存活集合里（或从未收到过存活集合），本地标为 `stopped`（error「CLI 中已不存在该任务」）并推送，正常返回、不抛错；任务确实存活时仍抛出原错误。
- **`background_tasks_changed` 对账**：`system` 子类型 `background_tasks_changed { tasks: [{ task_id, task_type, description }] }` 是电平信号，每当后台任务集合变化就推「当前仍存活的全部后台任务」（REPLACE 语义，按进程计，启动时不发，重复 initialize 后补发一次快照；通常先于对应的 task_* 边沿事件到达）。子代理发起的后台命令有时收不到 `task_updated` / `task_notification`，所以登记表记录最新存活集合：对 running 但不在集合里的任务启动约 2 秒的对账定时器，到期仍为 running 且仍不在最新集合里则标为 `completed`（`endedAt` 取当前时间，summary「已结束（未收到完成通知）」，不填 exitCode）并推送；期间重新出现在集合里则取消；之后迟到的 `task_updated` / `task_notification` 照常覆盖状态、退出码与 summary。会话关闭 / 进程退出时清理定时器。
- 进程退出 / 主动重建进程 / 会话关闭时，仍为 running 的任务标为 `stopped`（error「会话已结束」）并推送；进程重启（`--resume`）后旧任务保留为已结束，新进程的任务照常登记。
- **initialize 带 `perTaskStopAffordance: true`（行为变化）**：声明后，用户「中止」本轮（`interrupt`）时 CLI 不再连带杀掉后台任务，后台任务只能经 `agent.tasks.stop` 逐个停止（界面在输入框上方提供入口）。
- 与现有逻辑的关系：4.11 的子代理登记与 4.12 的 `task_notification` 卡片不变，后台任务登记表是并行的另一份视图（只含后台 Shell）。

**前端**：
- 进入会话时 `agent.tasks.list` 拉一次（断线重连后重拉），之后由 `agent.tasks.update` 整表替换（按 agentId 存）。
- 输入框上方、子代理药丸旁的「后台任务」药丸：有运行中显示「后台任务 N 运行中」，否则「N 个已结束」，没有任务不渲染；展开列出每个任务，**整行是可选中的 button**（`data-active` 高亮当前打开项，样式同子代理药丸的行）：Terminal 图标、描述（无描述时取命令首行）、状态文字、耗时、运行中时的「停止」小按钮（点击不触发选中）。「清除已结束」只在前端隐藏。
- 点选一行 → 在**右侧面板**（与子代理面板同一区域、同一布局）打开该任务；后台任务面板与子代理面板互斥，打开一个关闭另一个。面板内容：标题（描述）、状态 + 耗时 + 退出码、完整命令（等宽、可选中复制、长命令换行）、输出区、运行中的「停止」按钮、关闭按钮。
- 输出区：等宽字体显示尾部，任务运行中每 2 秒刷新并保持滚动在底部（用户上滚暂停），`truncated` 时提示「已截断，仅显示最后 N KB」，任务结束后再拉一次最终输出便停止轮询，保留最后输出。

### 4.16 首次响应前撤回用户消息

用户发送后、Agent 还没有任何输出时，可撤回这条消息：中止本轮、消息从对话移除、原文（含图片）回到输入框。

**协议**：
- RPC `agent.retract { agentId }` → `{ prompt: AgentPromptInput; clientMessageId? }`（本轮原始 prompt，含图片 base64）。
- 新事件 `{ type: "user_message_retracted"; turnId; clientMessageId? }`：照常分配 seq、写入时间线并落盘。前端据此（含回放）隐藏对应用户消息（按 clientMessageId，缺省则取该 turn 前最近的用户消息）与本轮空的助手占位，随后的 `turn_canceled` 不再显示「已中断」提示。
- 业务错误码 `RETRACT_UNAVAILABLE`：没有进行中的回合、回合为 CLI 自发（origin background）、本轮已有任何 provider 输出（timeline 任意条目或 `permission_requested`；`usage_updated`、`thread_started` 等不算）、或撤回已在进行中（重复调用）。message 如「Agent 已开始响应，无法撤回」。

**AgentManager**：为 `agent.send` 发起的回合记录原始 prompt、clientMessageId 与「是否已有输出」。retract 先等已到达事件处理完，再在事件链内校验并写 `user_message_retracted`（与输出事件串行，无竞态），然后走与 `agent.cancel` 相同的 interrupt 路径，回合随后以 `turn_canceled` 结束。撤回事件写入后到中断生效前 provider 仍吐出的 timeline 事件被丢弃。provider 无需改动。

**限制**：Claude 等 CLI 自身的历史（transcript）里仍会留下这条被中断的用户消息（CLI 无法删除）；只有 AgentDeck 自己的时间线把它隐藏。

### 4.17 会话管理：重命名、置顶、归档、导出、批量操作

**协议**：
- `AgentSnapshot` 增加 `pinned?: boolean`、`archived?: boolean`（缺省视为 false，随 meta.json 持久化）。`title` 表示用户自定义标题；未设置时前端沿用现有推导（`agentDisplayTitle`）。
- 新方法 `agent.update { agentId, title?: string | null, pinned?: boolean, archived?: boolean }` → `{ agent: AgentSnapshot }`：
  - 三个字段至少给一个，否则 `-32602`。`title` 去首尾空白后长度 1–200；`null` 或空字符串 = 清除自定义标题（快照中删除 `title`）。超长为 `-32602`。
  - 只改元数据：任何状态（含 running / dormant / closed）都可调用，**不恢复会话、不受单 turn 约束、不改 `updatedAt`**（避免改名把会话顶到列表最前）。
  - 立即落盘 meta（不走 500ms 防抖），随后推 `agent.state`。agent 不存在 → `AGENT_NOT_FOUND`。
- `agent.send` 发到 `archived: true` 的会话时自动取消归档（写入 `archived: false`，随本轮的 `agent.state` 推送）。

**导出**（前端生成内容，Rust 只负责保存对话框与写文件）：
- Rust 命令 `export_session_json` 改为 `export_session_file`，`input: { fileName, content, format: "json" | "markdown" }`；按 format 补 `.json` / `.md` 扩展名，保存对话框的过滤器与标题（「导出 AgentDeck 会话」）同步；返回结构不变（`{ ok, canceled, path?, bytes, error? }`）。
- 前端经 `agent.timeline { agentId }` 取全部条目（dormant / closed 也可取，不恢复会话）后生成：
  - JSON：`{ format: "agentdeck.session", version: 1, exportedAt: <ms>, agent: <快照，去掉 persistence / pendingPermissions / activeTurnId>, entries: AgentStreamEnvelope[] }`。
  - Markdown：一级标题为会话标题；元信息列表（Agent、模型、模式、工作目录、创建 / 更新时间、累计 tokens）；按时间顺序输出用户消息（「### 用户」）、助手消息（「### 助手」，按 messageId 拼接）、思考（`<details><summary>思考</summary>…</details>`）、工具调用（一行「- 工具 `name` · 状态」，shell 附命令）、错误与系统提示；图片写「[图片]」；被撤回的用户消息（4.16）不输出。
- 文件名默认 `<标题前 40 字，去掉非法字符>-<yyyyMMdd-HHmm>`。

**前端**：
- 会话右键菜单（`use-context-actions.tsx`）在现有项之外增加：重命名（弹窗，带「恢复自动标题」）、置顶 / 取消置顶、归档 / 取消归档、导出为 JSON、导出为 Markdown。运行中的会话不提供「归档」。
- 侧边栏会话列表：不显示归档的会话；置顶的会话排在最前（置顶组内仍按 `updatedAt` 倒序）。
- 历史页：
  - 状态筛选旁增加视图切换「全部会话 / 已归档」，默认视图不含归档的会话。置顶的会话在最前，单列一个「置顶」分组。
  - 新增「选择」模式：每行复选框、「全选当前筛选结果」、底部批量操作栏（已选 N 个）：删除（确认弹窗写明数量；运行中的会话由 `agent.delete` 先关闭再删除）、归档 / 取消归档、置顶 / 取消置顶。批量操作在前端逐个调用 RPC，结束后汇总提示成功与失败数量。
  - 全文搜索见后续 4.19（第 2 批）。
- 旧的 ui_store `session_ui_state` 表（archived / pinned 列）与 `set_session_archived` / `read_archived_session_ids` 删除；置顶与归档只以 sidecar 快照为准。项目置顶仍沿用 ui_store kv。

### 4.18 Debug 面板与诊断包

**sidecar 日志轮转**：sidecar 启动打开 `sidecar.log` 前，若文件超过 10 MB，先把它重命名为 `sidecar.log.1`（覆盖旧的 `.1`），再新建。运行中不轮转。

**Rust 命令**：
- `log_tail { input: { maxBytes?: number } }` → `{ path: string, text: string, truncated: boolean, size: number }`：读取 `<日志目录>/sidecar.log` 尾部，`maxBytes` 默认 256 KB、上限 2 MB；从截断处跳到下一个换行再返回，按 UTF-8 宽松解码。文件不存在时 `text` 为空字符串、`size` 为 0，不报错。
- `debug_paths {}` → `{ dataDir, logDir, webviewDataDir? }`。
- `export_debug_bundle { input: { diagnostics: string, frontendEvents: string } }` → `{ ok, canceled, path?, bytes, error? }`：弹出保存对话框（默认文件名 `agentdeck-debug-<yyyyMMdd-HHmmss>.zip`），zip 内容：
  - `diagnostics.json`：前端收集的诊断信息（见下）；
  - `frontend-events.jsonl`：前端调试事件；
  - `logs/sidecar.log`、`logs/sidecar.log.1`（存在才放，各取最后 5 MB）；
  - `config/providers.json`：按 4.7 规则脱敏（apiKey 一律脱敏，`env` / `settings.env` 中长度 ≥ 6 的值脱敏）；`config/coding-agent-paths.json` 原样。
  - **绝不包含** `AGENTDECK_TOKEN`、WS 地址中的 token、ui.sqlite 与会话时间线。
- 前端传入的 `diagnostics` / `frontendEvents` 在前端已经过 `debug-redact.ts` 脱敏；Rust 再对 providers.json 单独脱敏。

**前端**：
- 全局采集（应用启动时安装一次）：`console.error` / `console.warn`、`window` 的 `error` / `unhandledrejection`、sidecar RPC 请求失败（方法名、错误码、message）、sidecar 连接断开 / 重连、`sidecar-status` 变化，写入 `debug-bus`（环形缓冲 500 条，写入前脱敏）。
- 调试页（「高级」下新增「调试」子页，并在命令面板加入「打开调试面板」）：
  - 运行状态：应用版本 / 提交 / 构建日期；sidecar 状态、版本、pid、端口（来自 `get_sidecar_config`，**不显示 token**）；「重启 sidecar」按钮。
  - 路径：`debug_paths` 的各目录，每项带「打开」。
  - Agent 可用性：`provider.list` 的可用状态与不可用原因，`coding_agents_check` 的版本与路径。
  - 前端事件：按类型筛选、清空、复制。
  - sidecar 日志：`log_tail` 尾部，按级别（全部 / 警告及以上 / 错误）与关键字过滤，「自动刷新」开关（2 秒），「打开日志目录」。
  - 操作：「复制诊断信息」（diagnostics JSON 写入剪贴板）、「导出诊断包」。
- `diagnostics` 内容：上述运行状态、路径、Agent 可用性、平台与 UA、当前会话数量（按状态计数），不含会话内容。

### 4.19 会话全文搜索

- 新方法 `agent.search { query: string, limit?: number, agentIds?: string[] }` → `{ hits: AgentSearchHit[], truncated: boolean }`。
  - `query` 去首尾空白后 1–200 字，否则 `-32602`；`limit` 默认 100、上限 500（按命中条数计）。
  - `AgentSearchHit = { agentId: string; seq: number; timestamp: number; role: "user" | "assistant" | "reasoning" | "tool"; snippet: string; matchStart: number; matchLength: number }`。`snippet` 为命中处前后各约 60 字（换行压成空格），`matchStart` / `matchLength` 为命中在 snippet 内的位置（UTF-16 下标）。
  - 匹配：大小写不敏感的子串匹配（`toLocaleLowerCase`），支持中文。对象：`user_message` 文本、`assistant_message`（同一 messageId 的分段先拼接再匹配，seq 取该消息首段）、`reasoning`（同一回合内连续分段拼接）、`tool_call`（工具名、标题、shell 命令、文件路径）。被撤回的用户消息（4.16）不参与。
  - 每个会话最多返回 5 条命中；会话按 `updatedAt` 倒序扫描，凑够 `limit` 即停止并置 `truncated: true`。
  - 实现：逐个读取 `timeline.jsonl`（已在内存中的会话直接用内存时间线），不建常驻索引；读文件为流式逐行解析，坏行跳过。归档会话同样参与。
- 前端（历史页）：搜索框输入非空时（300ms 防抖）除现有的标题 / 元数据过滤外，另显示「内容匹配」分组：每条结果显示会话标题、角色、时间与高亮 snippet；点击跳转 `/tasks/:id?seq=<seq>`。详情页支持 `seq` 查询参数：时间线重建后滚动到包含该 seq 的消息并短暂高亮，找不到则停在底部。

### 4.20 用量统计（跨会话）

**账本**：sidecar 在 `<AGENTDECK_DATA_DIR>/usage/turns.jsonl` 为每个结束的回合（`turn_completed` / `turn_failed` / `turn_canceled`）追加一行 `UsageTurnRecord`：
```ts
interface UsageTurnRecord {
  ts: number;                 // 回合结束时间（ms）
  agentId: string;
  provider: AgentProviderId;
  model: string | null;       // 回合进行时快照中的 model；null = provider 默认
  turnId: string;
  origin: "user" | "background";
  outcome: "completed" | "failed" | "canceled";
  inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; costUsd?: number;
  durationMs?: number;        // turn_started → 结束
  ttftMs?: number;            // turn_started → 本回合第一个 assistant_message
}
```
- 账本与会话独立：删除会话不删除账本记录（统计是历史数据）。
- 回填：sidecar 启动时若 `usage/backfill-v1.done` 不存在，后台扫描全部会话时间线生成历史记录（model 取当时快照中的 model），完成后写标记文件；回填期间 `usage.summary` 照常返回已有数据并带 `backfilling: true`。
- 未设置 `AGENTDECK_DATA_DIR` 时只在内存中累计。

**RPC** `usage.summary { sinceMs?: number, untilMs?: number }` → `UsageSummary`：
```ts
interface UsageSummary {
  backfilling: boolean;
  totals: { turns: number; failedTurns: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; costUsd: number };
  byDay: Array<{ day: string /* 本地日期 yyyy-MM-dd */; inputTokens: number; outputTokens: number; cachedInputTokens: number; costUsd: number; turns: number }>;
  byProvider: Array<{ provider: AgentProviderId; label: string; inputTokens: number; outputTokens: number; costUsd: number; turns: number }>;
  byModel: Array<{ provider: AgentProviderId; model: string | null; inputTokens: number; outputTokens: number; costUsd: number; turns: number }>;
  topAgents: Array<{ agentId: string; title: string | null; provider: AgentProviderId; inputTokens: number; outputTokens: number; costUsd: number; turns: number; deleted: boolean }>; // 前 10
  perf: { ttftP50Ms?: number; ttftP95Ms?: number; durationP50Ms?: number; durationP95Ms?: number; outputTokensPerSecP50?: number };
}
```
- 时间范围缺省为最近 30 天；按天分桶用 sidecar 进程本地时区。
- 前端新增「用量统计」页（侧栏入口 + 命令面板）：时间范围切换（7 天 / 30 天 / 90 天 / 全部）、总量卡片、按天堆叠柱状图（输入 / 缓存 / 输出）、按 Agent 与按模型的占比、高用量会话前 10（点击跳转，已删除的会话不可点）、性能指标（TTFT 与耗时 P50 / P95、输出速度）。`backfilling` 时顶部提示「正在统计历史会话…」。
- ui_store 的 `turn_stats` / `ui_events` 表与相关命令删除（统计改以 sidecar 账本为准）。

**实现补充（4.19 / 4.20 落地时确定）**：
- `agent.search`：`limit` 超过 500 返回 `-32602`（不静默截断）；tool_call 的「标题」取 `metadata.title`（字符串时），另并入 `search` 详情的查询词；未带 `agentIds` 时扫描全部会话。`truncated` 在命中数达到 `limit` 时置位。
- 定位：前端消息带首个 seq（`AgentUIMessage.firstSeq`，乐观消息在服务端确认时补上）；`?seq=` 取「首个 seq 不大于目标的最后一条消息」，因为助手消息把一个回合的思考 / 工具 / 文本合在一起。
- 账本：失败 / 中断回合没有 usage，token 与费用字段缺省；去重键为 `agentId + turnId + ts`（回填与实时记录重叠时不重复）；回填时间线里没有 `model_changed` 才用 meta 里的 model，否则首次切换之前的回合记为 null。`usage.summary` 的 `topAgents.title` 取用户标题，缺省取首条消息预览，已删除的会话为 null；`byDay` 只含有数据的日期（前端补零）。
- 前端统计页的图表为纯 CSS 实现（无图表库依赖）。

### 4.21 重试

纯前端：回合以 `turn_failed` / `turn_canceled` 结束时，在该回合末尾显示「重试」；最后一条用户消息悬停时提供「再次发送」。两者都取该回合的用户消息重新 `agent.send`（新的 clientMessageId）：优先用前端运行时里该消息的 parts（含图片）；时间线的 `user_message` 只存文本（图片不落盘），所以重启后重建的消息只能重发文本，此时按钮提示「图片未保存，仅重发文字」。CLI 自身历史中仍保留上一次的尝试（与 4.16 的限制相同）。CLI 自发回合（origin background）不提供重试。

### 4.22 运行中插话（steer）

- `ProviderInfo` 增加 `capabilities?: { steer?: boolean; fork?: "native" | "summary" }`（4.23 同用）。
- 新方法 `agent.steer { agentId, prompt: AgentPromptInput, clientMessageId? }` → `{}`：把消息投递给**正在进行的回合**。
  - 没有进行中的回合 → `NOT_SUPPORTED`（message「当前没有进行中的回合」）；provider 不支持 → `NOT_SUPPORTED`（「该 Agent 不支持运行中插话」）。
  - AgentManager 照常写入 `user_message`（带 clientMessageId，并带 `steer: true`），归属当前 turnId，不开新回合。
- Codex：`turn/steer { threadId, input, expectedTurnId: <当前原生 turnId>, clientUserMessageId }`；当前回合为 review / compact（NonSteerableTurnKind）或请求失败时把错误原样返回（`INTERNAL_ERROR`，中文 message）。
- Claude：实现前必须实测 2.1.296 的 stream-json 行为——回合进行中（含工具执行中）再写入一条带新 `uuid` 的 user 消息：
  - 若 CLI 在当前回合内吸收这条消息（在当前 result 之前的 assistant 输出里能看到它的影响，且没有为它单独再出一个带其 uuid 的 result），则 `steer: true` 支持，当前回合仍以原 uuid 的 result 结束；
  - 若 CLI 把它排到当前回合之后单独执行（单独出带其 uuid 的 result），则 Claude 的 `capabilities.steer` 为 false（前端改用排队），并在本节补记实测结论。
  - **实测结论（2.1.296，stream-json，两次复测一致）：被吸收，`capabilities.steer = true`。** 第一条 user（uuid U1）让它跑 `ping -n 8 127.0.0.1` 再总结；工具执行期间写入第二条（uuid U2，「另外请在回答最后加一句：插话已收到」）。事件顺序：`command_lifecycle(U1) queued → started` → `init` → `assistant`（thinking / 文字 / PowerShell tool_use）→ 写入 U2 → `command_lifecycle(U2) queued` → 工具结果 `user` → `command_lifecycle(U2) started`（此刻工具刚结束，U2 并入当前回合）→ `assistant`（总结末尾带「插话已收到」）→ `command_lifecycle(U2) completed` → **`result` 只有一条，`user_message_uuid` 为 U1** → `command_lifecycle(U1) completed`。之后 150 秒内没有再出现带 U2 的 `result`，U2 的 `user` 消息也不会回显到 stdout。因此 Claude 的 `steer` 实现 = 向 stdin 再写一条带新 uuid 的 user 消息，回合仍以 U1 的 result 结束；`handleResult` 对 uuid 与当前回合不符的 result 本就忽略，未被吸收的兜底（排到回合之后单独执行）时其 result 不会提前结束新回合。仅用户回合支持；CLI 自发轮次进行中 `agent.steer` 返回 `NOT_SUPPORTED`（「CLI 自发轮次进行中不支持插话，请直接发送消息」）。探针与原始输出摘要见 `tmp/steer-probe.mjs`、`tmp/steer-probe-result.txt`（不入库）。
- ACP：不支持。
- 前端：回合运行中，输入框发送区显示「排队」与「插话」按钮；键位：Ctrl+Enter = 插话，Ctrl+Shift+Enter = 排队，用户发送快捷键设为 Enter 时 Enter = 排队，provider 不支持插话时只显示排队。插话的用户消息在当前助手消息流中以内联气泡显示（标注「插话」）。

### 4.23 会话分叉（fork）

- 新方法 `agent.fork { agentId, throughSeq?: number, title?: string }` → `{ agent: AgentSnapshot }`：基于原会话新建一个会话（同 provider / cwd / model / modeId / thinkingOptionId），新会话标题缺省为「<原标题>（分叉）」。
  - `throughSeq` 缺省 = 整个会话；给出时只保留到包含该 seq 的回合结束为止（必须落在已结束的回合上，否则 `-32602`）。
  - 原会话有进行中的回合时 → `TURN_IN_PROGRESS`（`throughSeq` 指向已结束回合时除外）。
  - 新会话的时间线：复制原时间线中 `throughSeq` 之前（含所在回合）的条目，重新编号 seq 从 1 开始、epoch 为当前进程 epoch，末尾追加一条系统提示 timeline 项 `{ type: "notice", text: "已从「<原标题>」分叉" }`（若无 notice 类型则用现有的系统提示表达方式，并在此处补记）。
- 方式（`capabilities.fork`）：
  - Claude `native`：新会话首次拉起进程时用 `--resume <原 sessionId> --fork-session`；`throughSeq` 不是最后一个回合时，若实测隐藏参数 `--resume-session-at <assistant message uuid>` 可用则使用，否则退回 `summary` 方式。
  - Codex `native`：`thread/fork { threadId, lastTurnId?: <throughSeq 所在回合的原生 turnId> }`，之后在新 thread 上 `turn/start`。
  - ACP / 其它 `summary`：新建空会话，并把截至 throughSeq 的对话整理为纯文本（用户 / 助手文本，工具调用一行摘要，超过 60k 字时保留最后 60k 字）存为待注入上下文；新会话第一次 `agent.send` 时在用户 prompt 前插入一个文本块：「以下是从另一个会话分叉过来的历史对话，仅供参考：\n<transcript>…</transcript>\n\n」，之后清除。该上下文随 meta 持久化（`pendingForkContext`），不进快照。
- 原会话不受影响；provider 原生 fork 失败时返回 `PROVIDER_UNAVAILABLE` 并删除刚建的会话。
- 前端：会话右键菜单「分叉会话」；消息悬停菜单「从这里分叉」（传该回合内任一 seq）；成功后跳到新会话。

**实测结论（claude 2.1.296、codex-cli 0.162.1，探针见 `tmp/fork-probe-*`）**：
- Claude `--resume <id> --fork-session`（stream-json 模式）：**可用**。首个 `system init` 即带**新的** `session_id`，新会话带着原历史（两轮会话 fork 后问「暗号是什么」答得出），原会话不变。隐藏参数 `--resume-session-at <assistant message uuid>`：**可用**，与 `--fork-session` 同用时只保留到该条 assistant 消息（fork 后问「第二个问题是什么」，回答把新问题当成第二条，说明原第二轮被截掉）。`assistant` 帧自带 `uuid`（一个回合里每个内容块一条 assistant 消息，同 `message.id`、不同 `uuid`；用回合里**最后一条主线程 assistant 消息的 uuid** 作锚点）。
- Codex `thread/fork { threadId, lastTurnId? }`：**可用**。应答 `{ thread: { id: <新 threadId>, turns }, … }`；新 thread 上直接 `turn/start` 即带完整历史（整会话 fork 后答得出「2 个问题、暗号蓝莓」）；带 `lastTurnId`（含）时 `thread.turns` 只剩到该回合，之后的问题不在上下文里（答「1 个问题」）。`turn/started` 的 `turn.id` 即原生 turnId。
- 因此 Claude 与 Codex 都按 `native` 实现，截断分叉也走原生，无需退回 summary（仅在缺少回合锚点时退回，见下）。

**协议与实现补充（落地时确定）**：
- 新 timeline 项 `{ type: "notice"; text: string }`：居中系统提示（`AgentTimelineItem` 里原先没有可用类型）；前端 `stores/chat.ts` 渲染为 id 前缀 `agent-timeline-notice-` 的 system 消息，时间线按居中分隔线显示（同压缩提示）。
- `turn_completed` 增加可选 `nativeRef`：provider 原生回合锚点（Claude = 本轮最后一条主线程 assistant 消息 uuid；Codex = 原生 turnId），供截断分叉使用；复制到新会话的时间线里会去掉它（对新会话无效）。`ProviderInfo.capabilities?: { steer?: boolean; fork?: "native" | "summary" }`：实现了 `forkSession` 的 provider 为 `native`，其余 `summary`；自定义 claude / codex 中转沿用其 extends 实现的值。
- `agent.fork` 的参数校验：`throughSeq` 必须是正整数且不超过当前最大 seq，并落在**已结束**的回合上（该 seq 之后存在回合结束事件），否则 `-32602`；缺省 `throughSeq` 且原会话有进行中的回合（含 send / 恢复中）→ `TURN_IN_PROGRESS`。保留范围 = 原时间线中 seq ≤ 「第一个 seq ≥ throughSeq 的回合结束事件」。
- 原生 / summary 的选择：provider 实现了 `forkSession`、原会话已有 persistence 句柄、且（保留整个会话——即所选回合是最后一个回合且原会话空闲——或所选回合有 `nativeRef`）→ native；否则（含旧会话没有 `nativeRef`、原会话是尚未发过消息的分叉会话、ACP / mock）→ summary。原会话 dormant / closed 时同样可分叉，不会恢复原会话。
- Claude 进程懒启动：native 分叉后新会话暂时没有自己的原生 id（`persistence` 为 null），首次拉起进程带 `--resume <原 id> --fork-session [--resume-session-at <uuid>]`，拿到新 `session_id`（`thread_started`）后后续重启一律 `--resume <新 id>`。拿到新 id 之前若 sidecar 重启，meta 里的 `pendingFork { handle, nativeRef? }`（同 `pendingForkContext`，不进快照）让该会话仍可恢复：恢复时再次调用 `forkSession`。Codex 在 fork 时立即 `thread/fork`，失败即 `PROVIDER_UNAVAILABLE`（此时新会话尚未登记，无需回滚）；Claude 的原生失败体现在首次 send 的 `turn_failed`。
- summary 注入：transcript 只含用户 / 助手文本与工具一行摘要（已撤回的用户消息、思考、待办、压缩、错误、系统提示不计入）；时间线里的用户消息仍是用户自己输入的文本，注入文本只发给 provider。`startTurn` 成功后才清除 `pendingForkContext` 并落盘。
- 前端：分叉 notice 之外，消息 `metadata.seq` 记下对应时间线 seq（用户消息 = 自己的 seq，助手消息 = 首个输出事件的 seq），「从这里分叉」传它；进行中的回合（最后一条用户消息起）不显示该操作；会话右键菜单「分叉会话」在会话运行中禁用。

### 4.24 sidecar 设置与按回合自动 git 快照（影子仓库）

**sidecar 设置**：`<AGENTDECK_DATA_DIR>/sidecar-settings.json`（原子写入），RPC `settings.get {}` → `SidecarSettings`、`settings.set { patch: Partial<SidecarSettings> }` → `SidecarSettings`，变化后广播 `settings.changed { settings }`。
```ts
interface SidecarSettings {
  snapshots: { enabled: boolean /* 默认 true */; maxFiles: number /* 默认 20000 */; maxFileBytes: number /* 默认 5 MB */ };
  interop: { enabled: boolean /* 默认 true，见 4.26 */ };
}
```

**影子仓库**：
- 位置 `<AGENTDECK_DATA_DIR>/snapshots/<sha1(规范化 cwd) 前 16 位>/repo`（bare 形式的 GIT_DIR），同目录 `meta.json` 记录 `{ cwd }`。所有命令形如 `git --git-dir=<repo> --work-tree=<cwd> …`，并设置 `GIT_CONFIG_NOSYSTEM=1`、`core.autocrlf=false`、`core.quotepath=false`、`user.name/email=AgentDeck`；spawn 一律 `windowsHide: true`、`shell:false`。git 不可用时快照功能静默关闭（日志记一次 warn）。
- 排除：`<repo>/info/exclude` 写入默认规则（`.git/`、`node_modules/`、`target/`、`dist/`、`build/`、`.venv/`、`__pycache__/`、`*.log` 等），工作目录自身的 `.gitignore` 照常生效；超过 `maxFileBytes` 的文件不纳入（`git add` 前用 `git ls-files -o -m --exclude-standard` 列出候选并过滤，经 `--pathspec-from-file` 添加）。候选文件数超过 `maxFiles` 时本回合跳过快照，并在该回合记录 `skipped: "too_many_files"`。
- 同一 cwd 的 git 操作在 sidecar 内串行（按 repo 加锁）。

**时机**：每个回合（含 origin background）`turn_started` 时拍「回合前」快照，回合结束（completed / failed / canceled）时拍「回合后」快照；两次树相同则不新建提交（复用上一次）。快照提交挂在 `refs/agentdeck/<agentId>` 上，提交信息含 agentId / turnId。

**索引**：`<agentDir>/snapshots.json`：`Array<{ turnId: string; seq: number /* 本回合 turn_started 的 seq */; startedAt: number; before: string | null; after: string | null; changedFiles: Array<{ path: string; status: "A" | "M" | "D" | "R" }>; skipped?: "too_many_files" | "git_unavailable" | "disabled" }>`。

**RPC**：
- `snapshot.list { agentId }` → `{ turns: SnapshotTurn[] }`（即上面的索引，按回合顺序）。
- `snapshot.diff { agentId, turnId, path?: string, against?: "after" | "current" }` → `{ diff: string, truncated: boolean }`：`before` 与 `after`（默认）或当前工作区的 unified diff，上限 512 KB。
- `snapshot.restore { agentId, turnId, paths?: string[] }` → `{ restored: string[], deleted: string[], backupCommit: string }`：把文件恢复到该回合**开始前**的状态。步骤：先对当前工作区拍一个「恢复前」快照（提交挂 `refs/agentdeck/restore`，供再次恢复）；再对 `before` 与当前之间的差异逐个处理——当前存在而 `before` 中没有的文件删除，其余从 `before` 检出；`paths` 给出时只处理这些路径。同一 cwd 上任一会话有进行中的回合 → `TURN_IN_PROGRESS`。
- `snapshot.storage {}` → `{ repos: Array<{ cwd: string; bytes: number }> }`；`snapshot.prune { cwd }` → `{}`：删除该 cwd 的影子仓库与各会话索引里对应的快照引用（索引项标记 `pruned: true`）。

**前端**：
- 每个已结束、有文件变化的回合末尾显示「本回合修改了 N 个文件」小条，点击在右侧预览栏打开快照面板：文件列表（状态标记）+ diff（复用现有 diff 渲染）+「回滚到本回合之前」（确认弹窗列出将恢复 / 删除的文件）。
- 会话右键菜单「快照历史」打开同一面板（按回合列出）。
- 设置页（「高级」）新增「文件快照」：开关、上限设置、各工作目录占用空间与「清理」。

**实现补充（落地时确定）**：
- git 命令：`--git-dir=<repo> --work-tree=<cwd> --literal-pathspecs -c core.autocrlf=false -c core.safecrlf=false -c core.quotepath=false -c core.fsmonitor=false -c core.longpaths=true -c gc.auto=0 -c user.name=AgentDeck -c user.email=agentdeck@localhost`，环境 `GIT_CONFIG_NOSYSTEM=1`、`GIT_TERMINAL_PROMPT=0`、`GIT_OPTIONAL_LOCKS=0`；git 经 `findExecutable("git")` 定位，`spawnProcess` 保证 `shell:false`、`windowsHide:true`。
- 拍快照流程（持 repo 锁）：`ls-files -z -o --exclude-standard`（未跟踪）/ `-m`（已修改）/ `-d`（已删除）得到候选，数量（三者之和）超过 `maxFiles` → `skipped: "too_many_files"`；对未跟踪与已修改的文件 `lstat` 过滤超过 `maxFileBytes` 的（已跟踪但变大的文件 `git rm --cached` 移出索引）；其余经 `git add -A --pathspec-from-file=- --pathspec-file-nul`（stdin，NUL 分隔）暂存，已删除文件同一命令暂存删除；`write-tree` 后与 `refs/agentdeck/<agentId>` 当前提交的树比较，相同则复用该提交，否则 `commit-tree` + `update-ref`。影子仓库用持久索引，所以后续快照只需处理增量。嵌套仓库（`ls-files -o` 里以 `/` 结尾的项）忽略。
- 索引项在 `turn_started` 时登记（`before` 之后才有 `after`），回合结束后补 `after` 与 `changedFiles`（`diff-tree -r --name-status --no-renames`，因此不产生 `R`，重命名表现为 `D` + `A`）；`before` 为 null 的回合（跳过 / 失败）不计算 `changedFiles`。同一会话的回合前 / 后任务在 sidecar 内串行，`snapshot.list` 会先等待该会话排队中的任务，前端在回合结束后刷新即可拿到最新结果。未设置 `AGENTDECK_DATA_DIR` 时没有地方存放影子仓库，回合记 `skipped: "disabled"`。
- `snapshot.restore`：`before` 与「恢复前快照」（`refs/agentdeck/restore`）之间 `diff-tree` 得到差异，`A` 删除（并清理空目录）、`M` / `D` 用 `git checkout <before> --pathspec-from-file=- --pathspec-file-nul` 检出；`paths` 为精确文件或目录前缀；路径含 `..` / 绝对路径 → `-32602`。注意是「回合前快照 → 当前」的整体差异，因此也会回退该回合之后各回合的改动，前端确认弹窗按该回合及之后各回合的 `changedFiles` 折叠出预计的恢复 / 删除列表。`snapshot.prune` 同样在同 cwd 有运行中回合时返回 `TURN_IN_PROGRESS`。
- `snapshot.diff`：`against: "current"` 时对当前工作区临时 `write-tree`（不产生提交）再 diff；输出超过 512 KB 终止 git 进程并 `truncated: true`。
- 前端：助手消息的 `firstSeq` 等于其回合 `turn_started` 的 seq，与索引项 `seq` 对应；快照面板是预览栏的「快照」标签，`?panel=snapshots&snapshotTurn=<turnId>` 深链；设置页路径 `/snapshots`。

### 4.25 调度器：定时任务、心跳、目标循环

**存储**：`<AGENTDECK_DATA_DIR>/schedules.json`（原子写入，内容 `{ version: 1, paused: boolean, schedules: Schedule[] }`）；运行记录追加到 `<AGENTDECK_DATA_DIR>/schedule-runs.jsonl`。

```ts
type ScheduleTarget =
  | { type: "agent"; agentId: string }
  | { type: "new"; provider: AgentProviderId; cwd: string; model?: string | null; modeId?: string | null; thinkingOptionId?: string | null; title?: string };

type Schedule = {
  id: string; name: string; enabled: boolean; createdAt: number; updatedAt: number;
} & (
  | { kind: "cron"; trigger: { cron: string } | { everyMinutes: number } | { at: number }; target: ScheduleTarget; prompt: string; onBusy: "skip" | "wait" }
  | { kind: "heartbeat"; agentId: string; idleMinutes: number; prompt: string; maxRuns?: number; runs: number }
  | { kind: "goal"; agentId: string; goal: string; doneMarker: string /* 默认 "GOAL_DONE" */; maxIterations: number; iterations: number;
      judge?: { provider: AgentProviderId; model?: string | null }; stopOnFailure: boolean; state: "running" | "done" | "stopped" | "exhausted" | "failed" }
);
interface ScheduleRun { scheduleId: string; ts: number; agentId?: string; turnId?: string; outcome: "sent" | "skipped_busy" | "skipped_paused" | "missed" | "failed" | "done"; message?: string }
```

**语义**：
- cron：5 段表达式（分 时 日 月 周，本地时区），用 `croner` 解析；`everyMinutes` ≥ 1；`at` 为一次性，触发后自动 `enabled: false`。应用未运行期间错过的触发不补跑（一次性任务过期记一条 `missed`）。到点向目标发送 prompt：`agent` 目标走与 `agent.send` 相同的路径（dormant / closed 可恢复则自动恢复）；`new` 目标每次新建一个会话（快照 `origin: "schedule"`）。目标忙时 `skip` 记 `skipped_busy`，`wait` 等到空闲再发（最多等 30 分钟，超时记 `skipped_busy`）。
- heartbeat：目标会话最近一次回合结束后空闲满 `idleMinutes` 时发送 prompt，每次空闲期只触发一次；达到 `maxRuns` 后自动停用。
- goal（目标循环）：启用时立即向会话发送首条提示「目标：<goal>\n请持续推进直到完成。完成时在回复最后单独一行输出 <doneMarker>。」；之后每次该会话的回合结束：
  - 回合最后一条助手消息末行等于 doneMarker → `state: "done"`；配置了 `judge` 时，改为新建一个隐藏的评判会话（快照 `origin: "judge"`，不在侧栏显示），发送目标与最后回复，要求只回答 `DONE` 或 `CONTINUE: <理由>`，DONE 即完成；
  - 否则 `iterations + 1`，未达 `maxIterations` 就发送「继续推进目标：<goal>。完成时在最后单独一行输出 <doneMarker>。」，达到则 `state: "exhausted"`；
  - `turn_failed` 且 `stopOnFailure` → `state: "failed"`；用户在该会话手动发送消息或中断时，循环暂停为 `stopped`（用户可在界面继续）。
- 全局暂停：`schedules.json` 的 `paused` 为 true 时所有触发记 `skipped_paused`，不发送。
- 结束（done / exhausted / failed）与定时任务失败时发系统通知（沿用现有通知设置）。

**RPC**：`schedule.list {}` → `{ schedules, paused }`；`schedule.upsert { schedule }`（无 id 为新建，zod 校验，cron 非法为 `-32602`）→ `{ schedule }`；`schedule.delete { id }`；`schedule.runNow { id }`；`schedule.runs { id?, limit? }` → `{ runs }`（默认 100，按时间倒序）；`schedule.setPaused { paused }` → `{ paused }`；通知 `schedule.changed { schedules, paused }`。

**前端**：
- 新增「自动化」页（侧栏入口 + 命令面板）：按类型分组的任务列表（名称、目标、下次触发时间 / 状态、启用开关、立即运行、编辑、删除）、运行记录、顶部「全部暂停」开关。新建 / 编辑弹窗按类型切换表单（cron 表达式带常用预设与下次 5 次触发预览）。
- 会话详情：该会话有心跳或目标循环时，在输入框上方显示状态条（如「目标循环 3/10 · 停止」/「心跳：空闲 30 分钟后发送」），可停止 / 继续。会话右键菜单「设置目标循环…」「设置心跳…」。

### 4.26 会话互通：sidecar 作为 MCP 服务端（Agent 发起的委派）

**端点**：sidecar 在同一 HTTP 服务上提供 MCP Streamable HTTP 端点 `POST http://127.0.0.1:<port>/mcp`（无状态模式，响应直接返回 JSON，不需要 SSE），使用官方 `@modelcontextprotocol/sdk` 的服务端实现。鉴权：每个会话一个随机 `interopToken`（只在 sidecar 内存中，重启后重新生成），请求头 `Authorization: Bearer <interopToken>`；sidecar 据此识别调用方 agentId。token 不匹配 → HTTP 401。`settings.interop.enabled` 为 false 时不注入、端点返回 404。

**注入**（会话进程每次拉起 / 恢复时注入当前端口与 token）：
- Claude：追加参数 `--mcp-config <内联 JSON>`，内容 `{"mcpServers":{"agentdeck":{"type":"http","url":"http://127.0.0.1:<port>/mcp","headers":{"Authorization":"Bearer <token>"}}}}`（shell:false 传参）。
- Codex：经 `thread/start` / `thread/resume` / `thread/fork` 的 `config` 注入 `mcp_servers.agentdeck = { url, http_headers: { Authorization: "Bearer <token>" } }`（键名以本机 codex 0.162.1 实际支持的为准，实现前实测并在此补记；若不支持 http_headers 则用 `bearer_token_env_var` + 子进程环境变量）。
- ACP：agent 的 initialize 应答声明 `mcpCapabilities.http` 时，`newSession` / `loadSession` 的 `mcpServers` 传 `[{ type: "http", name: "agentdeck", url, headers: [{ name: "Authorization", value: "Bearer <token>" }] }]`；不支持则不注入。
- 日志与诊断包中 token 一律脱敏。

**工具**（名称前缀由 CLI 自行加，如 `mcp__agentdeck__list_agents`）：
| 工具 | 参数 | 返回 |
|---|---|---|
| `list_providers` | — | 可用 provider（id、label、可用性） |
| `list_agents` | `{ includeArchived?: boolean }` | 会话列表（id、标题、provider、cwd、状态、模型、parentAgentId） |
| `read_agent` | `{ agentId, lastMessages?: number /* 默认 10，上限 50 */ }` | 最近的用户 / 助手消息文本（工具调用一行摘要），总长上限 40k 字 |
| `delegate` | `{ provider, prompt, cwd?, model?, modeId?, title?, worktree?: boolean, wait?: boolean, timeoutSec?: number }` | `{ agentId, status, reply? }`：新建子会话（`parentAgentId` = 调用方，`origin: "delegate"`），cwd 缺省为调用方 cwd；`worktree: true` 时按 4.27 的规则建 worktree 作为 cwd（分支 `agentdeck/delegate-<agentId 前 8 位>`）；`wait`（默认 true）时等到该回合结束返回最后一条助手消息（上限 40k 字），超时（默认 600 秒，上限 3600）返回 `status: "running"` |
| `send_to_agent` | `{ agentId, message, wait?: boolean, timeoutSec?: number }` | 同上；目标忙 → 工具错误「目标会话正在运行」 |
| `wait_agent` | `{ agentId, timeoutSec?: number }` | 等到目标当前回合结束，返回最后一条助手消息 |
| `cancel_agent` | `{ agentId }` | 中断目标会话当前回合 |

**安全约束**：
- 不能对自己调用 `send_to_agent` / `wait_agent`；委派深度（parent 链长度）上限 3，单个会话同时运行的子会话上限 8，超出返回工具错误。
- `delegate` 的 `modeId` 若为危险模式（`AgentMode.dangerous`）一律拒绝；缺省用 provider 默认模式。子会话的权限请求照常出现在 AgentDeck 界面由用户审批。
- `send_to_agent` 只允许发给调用方的子孙会话，或用户明确标记为「允许被其它会话调用」的会话（快照字段 `interopTarget?: boolean`，经 `agent.update` 设置）；否则返回工具错误。
- 工具调用的结果只包含文本，不包含 token、apiKey 等。

**快照**：`AgentSnapshot` 增加 `parentAgentId?: string`、`origin?: "user" | "delegate" | "group" | "schedule" | "judge" | "kanban"`、`groupId?: string`、`interopTarget?: boolean`。

**前端**：侧边栏子会话缩进显示在父会话下（可折叠）；详情页顶部显示「由 <父会话> 委派」链接；时间线里 agentdeck MCP 工具的工具卡片渲染为委派卡片（目标会话标题、状态、跳转）。设置「高级」中「会话互通」开关。会话右键菜单「允许被其它会话调用」开关。

**实测结论（claude 2.1.296、codex-cli 0.162.1，探针见 `tmp/mcp-probe.mjs`、`run-claude.mjs`、`run-codex.mjs`、`e2e.mjs`）**：
- Claude `--mcp-config '<内联 JSON>'`（`type: "http"` + `headers`，shell:false 传参）：**可用**。stream-json 模式下 `system init` 的 `mcp_servers` 里 `agentdeck` 为 `connected`（source `dynamic`），工具名 `mcp__agentdeck__<tool>`，调用结果正常返回。CLI 握手顺序为 `POST server/discover`（探测，返回 method-not-found 即可）→ `initialize` → `notifications/initialized` → `GET /mcp`（想开 SSE 通道，无状态端点返回 405 即可）→ `tools/list` → `tools/call`，均带 Authorization 头；与官方 SDK 的无状态 + `enableJsonResponse` 服务端兼容。用户 settings 允许时不弹权限；默认模式下每次工具调用走现有审批流。
- Codex `thread/start` 的 `config.mcp_servers.agentdeck`：`{ url, http_headers: { Authorization } }` 与 `{ url, bearer_token_env_var }` **两种都可用**（`mcpServerStatus/list` 为 `connected`，错误 token → `failed`），采用前者（不依赖子进程环境变量）。两个坑：① **URL 主机必须写 `localhost`**：本机系统代理开启时，codex 对 `127.0.0.1` 字面量的 MCP 请求会被送去代理（`HTTP 502`，连接根本没到 sidecar），`localhost` 直连正常，因此 Codex 注入时把 `127.0.0.1` 换成 `localhost`；② **`approvalPolicy: never`（full-access 模式）下 codex 直接拒绝需要审批的 MCP 工具调用**（`MCP tool call requires approval, but approval policy is never`），加 `default_tools_approval_mode: "approve"` 后可用。on-request 模式（read-only / auto）不加该项，工具调用走 codex 自身的 `mcpServer/elicitation/request`，在 AgentDeck 里表现为一条 `mcp:agentdeck` 工具审批，由用户批准。另加 `tool_timeout_sec: 3700`（默认 60 秒会打断 delegate / wait 的长等待）。时间线里 Codex 的工具名为 `agentdeck.<tool>`（Claude 为 `mcp__agentdeck__<tool>`），输出为 `{ content: [{ type: "text", text }] }`。

**实现补充（落地时确定）**：
- 模块：`server/interop-service.ts`（token ↔ agentId、端点）、`server/mcp-interop.ts`（`POST /mcp` 与工具）、`providers/shared/interop.ts`（三类 provider 的注入形态）、`git/worktree.ts`（共用 worktree 工具）。鉴权顺序：路径 `/mcp` → 互通关闭 404 → token 缺失 / 错误 401 → 非 POST 405。token 形如 `adi_<48 位 hex>`，sidecar 日志写入前统一把 `adi_[0-9a-f]{16,}` 替换为 `adi_***`（因此诊断包里的 `sidecar.log` 与 MCP 状态错误文本都不含 token）。
- 注入点：`AgentSessionConfig.interop` / `resumeSession` 的 `AgentResumeConfig.interop`（`{ url, token }`），由 AgentManager 在创建、恢复、分叉（含 Claude 懒启动的 pendingFork 恢复）时填入；token 每会话稳定、仅内存，sidecar 重启后重新生成并随恢复重新注入。互通关闭或端口未知时不注入。创建会话改为先生成 agentId 再建 provider 会话（`CreateAgentParams.id` 供委派预先建 worktree 分支）。
- `delegate`：`cwd` 相对路径按调用方 cwd 解析，目录必须存在；`worktree: true` 时 worktree 放 `<AGENTDECK_DATA_DIR>/worktrees/delegate-<agentId 前 8 位>`（要求设置了数据目录），失败 / 创建会话失败时回滚；`modeId` 除 `AgentMode.dangerous` 外，id 含 `bypass` / `full-access` / `dangerous` / `yolo` 或目录里查无此模式也拒绝；结果 JSON 为 `{ agentId, status: "completed" | "failed" | "canceled" | "running", reply?, error?, note?, worktree? }`，`reply` 超过 40k 字截断；`timeoutSec` 超过上限按上限处理。
- `wait_agent` 额外拒绝等待自己的上级会话（会互相等待）；`cancel_agent` 与 `send_to_agent` 同样只允许子孙或 `interopTarget` 会话；`read_agent` 不限制目标。
- `agent.update` 增加 `interopTarget?: boolean`（与 title / pinned / archived 至少给一个）。meta.json 持久化 `parentAgentId` / `origin` / `groupId` / `interopTarget`，加载时校验类型。
- 前端：委派卡片按工具名（`mcp__agentdeck__` 或 `agentdeck.` 前缀的 delegate / send_to_agent / wait_agent / cancel_agent / read_agent）识别，信息在 reducer 中从 `detail.unknown` 的入参与输出解析；侧栏子会话按 `parentAgentId` 嵌套（父会话缺失或成环时退化为顶层，整组在任一成员运行时归入「进行中」）；「会话互通」设置页路径 `/interop`。

### 4.27 界面发起的并行协作（扇出 + 汇总）

**共用 worktree 工具**：`packages/sidecar/src/git/worktree.ts`（4.26 先实现，4.27 / 4.28 复用）：`addWorktree({ repoCwd, path, branch })`（基于当前 HEAD，`git worktree add <path> -b <branch>`，要求 repoCwd 在 git 仓库内）、`removeWorktree({ repoCwd, path, branch, deleteBranch })`、`diffStat({ cwd })`；git 定位与 spawn 规则复用 4.24 的 `snapshots/git.ts`。worktree 统一放在 `<AGENTDECK_DATA_DIR>/worktrees/` 下。

**协作组**：
```ts
interface AgentGroup {
  id: string; title: string; prompt: string; cwd: string; createdAt: number;
  members: Array<{ agentId: string; provider: AgentProviderId; model?: string | null; worktree?: { path: string; branch: string } }>;
  chair?: { provider: AgentProviderId; model?: string | null; mode: "synthesize" | "review"; agentId?: string };
  status: "running" | "chairing" | "done" | "failed";
}
```
- 存储 `<AGENTDECK_DATA_DIR>/groups/<id>.json`。
- `group.create { title?, prompt, cwd, members: Array<{ provider, model?, modeId?, thinkingOptionId? }> /* 2–6 个 */, worktree: "none" | "per-member", chair?: { provider, model?, mode } }` → `{ group }`：
  - `per-member` 时要求 cwd 在 git 仓库内，为每个成员执行 `git worktree add <AGENTDECK_DATA_DIR>/worktrees/<groupId>/<n> -b agentdeck/<groupId>/<n>`（基于当前 HEAD），成员会话 cwd 指向该 worktree；失败则回滚已建 worktree 并返回 `INTERNAL_ERROR`。
  - 成员会话快照 `groupId` + `origin: "group"`，同时发送同一 prompt。
  - 全部成员首个回合结束（任一失败不阻塞其余）后若配置了 chair：新建汇总会话（cwd 为原 cwd），发送汇总提示——`synthesize`：「以下是 N 个 Agent 对同一任务的回答，请综合出一个最佳答案，并指出各自的优缺点」；`review`：「请评审以下 N 个方案，给出排序与理由」——附各成员最后一条助手消息（各上限 20k 字）与（per-member 时）各 worktree 的 `git diff --stat`。状态依次为 running → chairing → done。
- `group.list {}`、`group.get { id }`、`group.delete { id, removeWorktrees: boolean }`（成员会话不删除，只解除 groupId；removeWorktrees 时 `git worktree remove --force` 并删分支）；通知 `group.changed { group }`。

**前端**：新建会话页增加「并行协作」入口：多选 Agent（每个可选模型 / 模式）、是否每个成员独立 worktree、汇总设置；协作视图页：成员会话并排（每列复用只读时间线 + 状态，点击进入完整会话），底部汇总结果；per-member 时每列提供「查看 diff」（复用现有 git 审阅面板，cwd 指向成员 worktree）。侧边栏把同组会话聚在一个可折叠的协作组下。

### 4.28 看板式任务分派

**数据**：每个项目（规范化的项目根路径）一个看板，存 `<AGENTDECK_DATA_DIR>/boards/<sha1(path) 前 16 位>.json`：
```ts
interface Board { projectPath: string; settings: { worktreePerTask: boolean /* 默认 true（git 仓库时） */; autoDispatch: boolean /* 默认 false */; maxConcurrent: number /* 默认 2 */; defaultAssignee: { provider: AgentProviderId; model?: string | null; modeId?: string | null } }; tasks: BoardTask[] }
interface BoardTask {
  id: string; title: string; description: string;
  status: "todo" | "running" | "review" | "done" | "blocked";
  assignee?: { provider: AgentProviderId; model?: string | null; modeId?: string | null };
  dependsOn?: string[]; agentId?: string; worktree?: { path: string; branch: string };
  attempts: number; maxAttempts: number /* 默认 2 */; blockedReason?: string; order: number; createdAt: number; updatedAt: number;
}
```
**派发**：
- 任务被拖到 running（或 `autoDispatch` 时，依赖全部 done 的 todo 按 order 自动派发，受 `maxConcurrent` 限制）：按设置建 worktree（规则同 4.27，分支 `agentdeck/task-<id>`），新建会话（`origin: "kanban"`），发送提示：任务标题 + 描述 +「完成后在最后单独一行输出 TASK_DONE；无法完成时输出 TASK_BLOCKED: <原因>」。
- 回合结束：末行 `TASK_DONE` → review；`TASK_BLOCKED: …` → blocked（记录原因）；两者都没有 → review（交给人工判断）；`turn_failed` → `attempts + 1`，未到 `maxAttempts` 则在同一会话发送「上次执行失败：<错误>，请重试」，到达则 blocked。
- review → done 时可选「合并到项目当前分支」：在项目根执行 `git merge --no-ff agentdeck/task-<id>`，冲突则 `git merge --abort` 并把任务留在 review、返回冲突文件列表；成功后可选删除 worktree 与分支。
- 用户手动改任务状态总是允许（运行中的任务移出 running 时先中断会话）。

**RPC**：`board.get { projectPath }` → `{ board }`（不存在则返回空看板）；`board.updateSettings { projectPath, settings }`；`board.upsertTask { projectPath, task }`；`board.deleteTask { projectPath, taskId, removeWorktree?: boolean }`；`board.moveTask { projectPath, taskId, status, order? }`；`board.merge { projectPath, taskId, removeWorktree: boolean }` → `{ ok, conflicts?: string[] }`；通知 `board.changed { projectPath, board }`。

**前端**：项目详情页新增「看板」标签：五列（待办 / 运行中 / 待评审 / 完成 / 阻塞），卡片可拖拽（列间移动与列内排序）、显示指派的 Agent 与会话实时状态；点击卡片打开详情抽屉（编辑标题描述、指派、依赖、查看会话、查看 diff、合并）；看板设置（worktree、自动派发、并发上限、默认指派）。

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
│   ├── providers/registry.ts   provider 注册表（claude / codex / acp:*；mock 仅在 `AGENTDECK_ENABLE_MOCK=1` 时注册）
│   ├── providers/mock/         假 provider：流式回显、模拟工具调用与审批，供测试与开发调试；**只有 sidecar 进程环境变量 `AGENTDECK_ENABLE_MOCK=1` 时才注册**，正式环境不出现
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
  /** AgentSessionEvent = AgentStreamEvent | { type: "provider_subagent"; event }（4.11，内部事件） */
  subscribe(cb: (e: AgentSessionEvent) => void): () => void;
  getPendingPermissions(): AgentPermissionRequest[];
  respondToPermission(requestId: string, r: AgentPermissionResponse): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  describePersistence(): AgentPersistenceHandle | null;
  setModel?(modelId: string | null): Promise<void>;
  setMode?(modeId: string): Promise<void>;
  /** 4.10：null = 跟随 CLI；运行中切换时返回 notice */
  setThinking?(thinkingOptionId: string | null): Promise<{ notice?: string } | void>;
  /** 4.14：斜杠命令 / MCP 状态 / MCP 重连 */
  listCommands?(): Promise<AgentSlashCommand[]>;
  getMcpStatus?(): Promise<AgentMcpStatusResult>;
  reconnectMcp?(serverName?: string): Promise<void>;
}
interface AgentClient {
  readonly provider: AgentProviderId;
  readonly kind: AgentProviderKind;
  readonly label: string;
  isAvailable(): Promise<{ available: boolean; reason?: string }>;
  fetchCatalog(opts?: { cwd?: string }): Promise<{ models: AgentModelDefinition[]; modes: AgentMode[]; commands?: AgentSlashCommand[] }>;   // commands 见 4.14
  createSession(cfg: { cwd: string; model?: string; modeId?: string; thinkingOptionId?: string | null }): Promise<AgentSession>;
  resumeSession?(handle: AgentPersistenceHandle, cfg: { cwd: string }): Promise<AgentSession>;
  shutdown?(): Promise<void>;
}
```

补充：`AgentClient.isAvailable()` 实际返回 `{ available, reason?, command? }`，`command` 用于填 `ProviderInfo.command`。provider 注册方式：`src/providers/{claude,codex,acp}/index.ts` 各导出一个 `ProviderFactory`（`(ctx: { logger, dataDir?, env }) => AgentClient[] | Promise<AgentClient[]>`），`registry.ts` 固定汇总，各 provider 只改自己的目录。会话事件约定：每轮必须先发 `turn_started`，结束时只发一次 `turn_completed` / `turn_failed` / `turn_canceled`；`respondToPermission` 返回前发 `permission_resolved`；AgentManager 在 `createSession` 返回后才订阅，所以 `thread_started` 要在首轮发；**provider 代码绝不能写 `process.stdout`**（stdout 只留给 ready 行）。

### 5.1 provider 要点（P3）

- **Claude**（`providers/claude/claude-cli-session.ts`，协议类型自写于 `stream-json-types.ts`）：一个会话一个长生命周期 `claude` 子进程，参数 `--print --verbose --output-format stream-json --input-format stream-json --include-partial-messages --permission-prompt-tool stdio --setting-sources user,project,local [--permission-mode <m>] --allow-dangerously-skip-permissions [--model m] [--resume <id>]`；每轮向 stdin 写一条带 `uuid` 的 `user` 消息，以 `result.user_message_uuid` 识别中断后过期的 result。控制请求（我方 → CLI）：`initialize`（应答含 `models`、`current_permission_mode`、`commands`）、`interrupt`（外包 3 秒超时）、`set_model`、`set_permission_mode`、`mcp_status`、`mcp_reconnect { serverName }`（60 秒超时，见 4.14）、`stop_task { task_id }`（见 4.15），默认 30 秒超时；initialize 带 `forwardSubagentText` 与 `perTaskStopAffordance`（见 4.11 / 4.15）；CLI → 我方：`can_use_tool` → `permission_requested`，应答 `{behavior:"allow", updatedInput, toolUseID}` 或 `{behavior:"deny", message}`，`control_cancel_request` 撤回挂起的权限请求；`keep_alive` 忽略；`system` 的 status 只用 requesting（4.12）与 compacting / 压缩结果，`compact_boundary` 见 4.13，`commands_changed` 整体替换斜杠命令缓存（4.14），其余子类型忽略。子进程意外退出 → `turn_failed`，下一轮自动以 `--resume` 重启。
  可执行文件定位顺序：「编程 Agent」页配置的路径（见 4.8；配置了就只用它，无效即不可用、不回退）→ 环境变量 `AGENTDECK_CLAUDE_PATH` → PATH 上的 `claude.exe` → 解析 npm `claude.cmd` shim 得到真实 exe → 报不可用；PATH 中位于 `node_modules` 内的目录一律跳过（`tauri:dev` 会把仓库 `node_modules/.bin` 加进 PATH）。**必须直接执行真实 exe（`shell:false`），不能经 .cmd**。
- **Codex**：`codex app-server` 子进程；`initialize`（`clientInfo` + `capabilities.experimentalApi: true`）→ `initialized` 通知 → `thread/start { model?, cwd, approvalPolicy, sandbox }` → `turn/start { threadId, input:[{type:"text",text,text_elements:[]}] }`；处理通知 `item/agentMessage/delta`、`item/reasoning/summaryTextDelta`、`item/started`、`item/completed`、`turn/started`、`turn/completed`、`thread/tokenUsage/updated`；审批请求 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval` 应答 `{ decision: "accept" | "decline" | "cancel" }`；中断 `turn/interrupt { threadId, turnId }`（需先拿到 turn/started 的原生 turnId）；`model/list` 拉模型。
  模式预设：`read-only`（on-request + read-only）、`auto`（on-request + workspace-write，默认）、`full-access`（never + danger-full-access）。
  可执行文件定位：「编程 Agent」页配置的路径（见 4.8，规则同上）→ `AGENTDECK_CODEX_PATH` → PATH 上的 `codex.exe` → 解析 PATH 或 `%APPDATA%
pm` 下的 npm `codex.cmd` 得到全局安装的真实 exe → 报不可用；同样跳过 `node_modules` 内的 PATH 目录，只运行用户本机全局安装的 codex。
- **ACP**：`spawn(command)` + NDJSON 流 → `ClientSideConnection`；`initialize { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile:false, writeTextFile:false }, terminal:false } }`；`newSession { cwd, mcpServers: [] }`；`prompt` 的 Promise resolve 即 turn 结束；`sessionUpdate`：`agent_message_chunk`→assistant_message、`agent_thought_chunk`→reasoning、`tool_call`/`tool_call_update`→tool_call（按 toolCallId 合并）、`plan`→todo；`requestPermission`：options 映射为 actions，按 selectedActionId 或 allow_once/allow_always、reject_once/reject_always 选；中断 `cancel { sessionId }`；模型 `unstable_setSessionModel`，失败忽略。
  内置命令目录只有一项：`acp:dsh`「DeepSeek Harness」= `dsh --profile acp`；另支持用户在 `AGENTDECK_DATA_DIR/acp-agents.json` 自定义 `{ id, label, command: string[] }[]`（同 id 覆盖内置项）。Windows 上 DeepSeek Harness 的 bin 目录（`%APPDATA%\DeepSeek Harness\bin`）同时有 `dsh.exe` 与 `dsh.cmd`，经 cmd 启动 `dsh --profile acp` 会挂住无输出，必须直接启动 `dsh.exe`（shell:false）：`findExecutable` 在 PATH 命中 `.cmd` / `.bat` 且同目录存在同名 `.exe` 时优先 `.exe`（不受 PATHEXT 顺序影响）。
- **Mock**：`providers/mock/` 的 MockAgentClient 只在 sidecar 环境变量 `AGENTDECK_ENABLE_MOCK=1` 时注册（sidecar e2e 与 web 集成测试显式设置；`tauri:dev` 默认不设，需要时手动在启动环境里设置）。

### 5.2 Windows 子进程规则

- 所有 spawn 设 `windowsHide: true`。
- 能解析到真实 `.exe` 就 `shell:false` 直接 spawn；`.cmd` shim 优先解析出背后的 exe 或 js（js 用 `process.execPath` 执行）；万不得已才 `shell:true` 并按 paseo `windows-command.ts` 做 cmd 转义。**内联 JSON 参数绝不能经过 cmd.exe。**
- 关闭会话时 tree-kill 整棵子进程树。
- `CREATE_NO_WINDOW` 下每个 sidecar 仍伴随一个无窗口的 `conhost.exe`，随 sidecar 退出，属正常现象。

### 5.3 provider 实现约定（P3 落地时确定，前端需知）

通用：
- 同一 callId 的 `tool_call` 先推 running，再推 completed / failed / canceled，后者覆盖前者；中断或关闭时仍在运行的工具补推 `canceled`。
- `assistant_message` 一轮内可能有多条（不同 `messageId`），前端按 messageId 分段拼接；`reasoning` 不带 messageId。
- 首轮 `thread_started` 与 `turn_started` 的先后不固定（Claude、ACP 先 thread_started，Codex 先 turn_started），前端不得依赖二者顺序。
- `turn_started` 之前不一定有 `user_message`：CLI 自发轮次（4.12）只有 `turn_started { origin: "background" }`。

Claude：
- 权限 actions：普通工具 `allow`「允许一次」/ `deny`「拒绝」；计划（kind `plan`，detail `{type:"plan"}`）`approve`「批准计划」/ `keep_planning`「继续规划」；批准计划后自动切回 `default` 模式。
- detail 分布：Bash / PowerShell→shell（无 exitCode）、Read→read、Write→write、Edit / MultiEdit→edit、Grep / Glob / WebSearch→search、WebFetch→fetch、Task / Agent→sub_agent（见 4.11）、Skill→plain_text、MCP 等→unknown；TodoWrite 只发 `todo`。
- 始终传 `--allow-dangerously-skip-permissions` 以允许会话中途切到 `bypassPermissions`；前端须把 bypassPermissions 标为危险选项且不得默认选中。
- 模式表顺序：`default`「逐项审批」、`acceptEdits`「自动接受编辑」、`auto`「自动模式」（独立分类器模型审查，常规操作直接执行，越权 / 可疑 / 高风险操作被拦截；出处 code.claude.com/docs/en/permission-modes）、`plan`「计划模式」、`bypassPermissions`「跳过所有审批」（dangerous）。CLI 的 `manual` 是 `default` 的别名（2.1.296 实测两者都回报 `default`），传参仍用 `default`。
- modeId 为 null（前端「默认模式」）时**不传** `--permission-mode`，跟随用户 Claude 设置中的默认模式；initialize 应答的 `current_permission_mode` 记为会话「基础模式」。跟随设置时直接进入 plan（新建选计划模式或恢复）：先不带参数启动读取基础模式，再立即发 `set_permission_mode plan`。
- 批准计划后切回进入 plan 之前的模式；之前为 null 则切回基础模式且快照 modeId 回到 null；基础模式未知或本身为 plan 时退回 `default`。
- 子进程环境额外剔除 `CLAUDECODE`、`CLAUDE_CODE_ENTRYPOINT`、`CLAUDE_CODE_SSE_PORT`、`CLAUDE_AGENT_SDK_VERSION`（不设置 `CLAUDE_CODE_ENTRYPOINT`）；子代理内部消息（带 `parent_tool_use_id`）不进主时间线，改写入子代理时间线（见 4.11）；AskUserQuestion 暂按普通工具权限处理。
- `fetchCatalog` 起一个临时 claude 进程只发 `initialize`（不对话、不计费），读取应答中的 `models`（value / displayName / description）与 `commands`（4.14）后关闭；成功结果缓存 10 分钟（commands 按 cwd 缓存），失败回退静态别名（default / sonnet / opus / haiku），`default` 保留中文标签。
- 设置模型发现（参照 paseo）：之后追加用户 Claude 设置（`$CLAUDE_CONFIG_DIR/settings.json`，否则 `~/.claude/settings.json`；允许 BOM，读取失败忽略，只读）中顶层 `model` 与 `env` 的 `ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` / `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`，去重并保留原样 id；只读 settings 文件中的 env，不读进程环境。带 `[1m]` 的显示名追加「· 1M 上下文」。「默认模型」说明为「跟随 Claude Code 设置（当前：X）」，X 取 `env.ANTHROPIC_MODEL`，否则取 `model`。设置每次 fetchCatalog 重读，探测结果仍缓存 10 分钟。
- 1M 上下文的实际表达（实测）：选 `opus[1m]` 时请求体 model 为去掉后缀的 `claude-opus-5-5`，另带 beta 头 `context-1m-2025-08-07`；选 `opus` 则不带该 beta 头。
- 中转：配了静态 `models` 时只用静态列表；未配时按中转合并后的 settings 追加，不读用户 settings。注意中转的 claude 运行时仍加载用户 settings（`--setting-sources user,...`），中转未设 `model` 时用户设置中的 model 仍会生效。

Codex（以本机 0.162.1 协议为准）：
- 模式 `read-only` / `auto`（默认）/ `full-access`；`setMode` 只在切换后的下一轮带一次 approvalPolicy + sandboxPolicy。
- 审批 actions：`accept`「允许」/ `decline`「拒绝」；拒绝时 `interrupt:true` 使本轮以 `turn_canceled` 结束；被拒绝的命令 tool_call 为 failed，error「用户拒绝了该操作」。
- 多文件 fileChange 的 detail 只显示第一个文件，完整列表在 `metadata.files`；新增文件为 `write` detail。
- `turn_completed.usage` 的 token 数为本轮合计：取本轮内 `thread/tokenUsage/updated` 的 `total`（缺省读 `total_token_usage`）相对本轮起点的差值（起点 = 本轮首条更新的 total − last）；没有 total 时退回 last。上下文窗口字段仍取最近一次 last。
- 子进程意外退出后下一轮自动重启并 `thread/resume`。

ACP：
- models / modes 只有建会话后才可得；首次建会话前 `provider.listModels` 返回空，之后返回最近一次会话的缓存。
- 权限 actions 为 `{ id: optionId, label: name, behavior }`，可能含 allow_once / allow_always / reject_once / reject_always 多项，前端按 actions 渲染并回传 `selectedActionId`。
- `turn_failed.code`：`REFUSAL`、`PROCESS_EXITED`、`ACP_<错误码>`；进程崩溃后该 agent 不可再用（再 send 返回 `PROVIDER_UNAVAILABLE`），前端应提示新建会话。
- 工具 `name` 为 ACP kind（如 execute），完整标题在 `metadata.title`。
- `turn_completed.usage` 的 token 数只取本轮 `PromptResponse.usage`；本轮应答没带 usage 时不带 token 字段（不沿用上一轮的值），上下文窗口 / 费用字段仍为最新值。

## 6. 前端接缝（P4）

保留 Hermes 的渲染层：`ChatSessionRuntime` / `AgentUIMessage` / `ChatMessage` / `MessageTimeline` / `GooseComposer` / `PreviewRail`。替换三处：
1. **事件入口**：`stores/chat.ts` 新增 `reduceAgentEvent(runtime, envelope)` 与 `applyAgentEventAtom`，把 `AgentStreamEvent` 翻译成 `AgentUIMessage.parts`（assistant_message→text、reasoning→reasoning、tool_call→tool part、error→notice）。
2. **动作 hook**：新增 `hooks/use-agent-session.ts` 替换原 Hermes `useGateway()` 的调用方（已删除），方法：`createSession`、`sendPrompt`、`interrupt`、`closeSession`、`respondPermission`、`setModel`、`setMode`、`listProviders`、`listModels`。
3. **历史**：`detail.tsx` 从 `agent.timeline` 重建消息，替代 Hermes REST 历史。
4. **传输**：新增 `lib/sidecar-client.ts`，复用原 Hermes `gateway-client.ts`（已删除）的 JSON-RPC 与重连/退避逻辑以及 `sidecar-socket-path.ts` 的原生 WS / Rust 中继回退；地址与 token 来自 `get_sidecar_config`，订阅 `sidecar-status` 事件。
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

### 7.1 打包方案（P7）

- **node 运行时**：`scripts/fetch-node.mjs` 下载固定版本的官方 Node 24 LTS（Windows x64 zip，优先 npmmirror 镜像，失败回退 nodejs.org），用同源的 `SHASUMS256.txt` 校验后取出 `node.exe`，放到 `binaries/node-x86_64-pc-windows-msvc.exe`（`binaries/` 加入 .gitignore）；已存在且校验通过则跳过。`tauri.conf.json` 的 `bundle.externalBin` 配置 `binaries/node`，打包后位于主程序同目录的 `node.exe`，对应 3.1 的第 2 个候选。
- **sidecar 代码**：`scripts/build-sidecar.mjs` 用 esbuild 把 `packages/sidecar/src/main.ts` 打成单文件 `dist-sidecar/bundle.mjs`（`--format=esm --platform=node --target=node24`，banner 注入 `createRequire`，`bufferutil` / `utf-8-validate` 设为 external），`tauri.conf.json` 的 `bundle.resources` 把它映射为资源目录下的 `sidecar/bundle.mjs`，对应 3.1 的第 2 个入口候选。bundle 中不含任何 Anthropic / OpenAI 代码，Claude Code 与 Codex 均运行用户本机安装的 CLI。
- **构建命令**：`pnpm tauri:build` 的 `beforeBuildCommand` 依次执行 fetch-node、build-sidecar、web build。`pnpm tauri:dev` 仍以 `node --import tsx` 运行源码，但 externalBin 在 dev 时也必须存在，所以 dev 前也执行 fetch-node。
- **安装包**：NSIS（per-user 安装）；`installer/nsis/hooks.nsh` 卸载时询问是否删除数据目录（`%APPDATA%\local.agentdeck.desktop`）。
- **验收**：release 构建后直接运行 `target/release/agentdeck.exe`（旁边有 node.exe 与资源），确认 sidecar 以 bundle 方式启动（命令行为 `<资源目录>
ode.exe \?<资源目录>sidecarundle.mjs`，`\?` 前缀来自 Tauri resource_dir，node 可正常处理）、mock 会话可跑通、退出无残留（关闭主窗口只隐藏到托盘，真正退出走托盘「退出 AgentDeck」，sidecar 收到 stdin EOF 后以 code 0 退出）；NSIS 安装包能生成。在干净机器上的安装测试由用户执行。

## 8. 许可

- 主体派生自 Hermes-CN-Desktop：PolyForm Noncommercial 1.0.0，保留 `LICENSE` 与两条 `Required Notice`，**仅限非商业用途**。
- Agent 适配层移植自 paseo：Apache-2.0，见 `legal/paseo.Apache-2.0.txt`；被移植/修改的文件头注明 `Derived from paseo <原路径> (Apache-2.0); modified for AgentDeck`。
- 部分前端代码源自 Hermes Agent 上游（Nous Research，MIT），见 `legal/hermes-agent-upstream.MIT.txt`。
- HarmonyOS Sans 字体许可见 `legal/HarmonyOS_Sans_LICENSE.txt`。
- 随包分发的第三方组件（P7）：Node.js 运行时 → `legal/nodejs.LICENSE.txt`；sidecar bundle 内的 npm 包（以 `dist-sidecar/meta.json` 为准）→ `legal/sidecar-third-party.txt`；前端生产依赖 → `legal/web-third-party.txt`；汇总见 `NOTICE.md`。依赖或 Node 版本变化时需重新生成：先 `pnpm sidecar:build`，再 `pnpm legal:gen`（`scripts/gen-legal.mjs`，结果稳定可重复）；Node 版本变化还需重取 `legal/nodejs.LICENSE.txt`。
- 不包含也不分发 Anthropic / OpenAI 的代码或可执行文件：Claude provider 自行实现 Claude Code CLI 的 stream-json 协议（未使用 claude-agent-sdk），Codex 走本机 `codex app-server`。
