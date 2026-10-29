# AgentDeck 设计文档

> 状态：P0–P7 已完成（2026-10-12）。P5 裁剪 Hermes 页面与换品牌、P6 会话持久化与恢复、P7 NSIS 打包均已落地；release 版 `agentdeck.exe` 已实测 mock 会话、重开恢复、删除与退出无残留。Claude provider 已改为直连本机 claude CLI（stream-json），安装包不含 Anthropic / OpenAI 代码。干净机器安装测试待用户执行。本文件是 Rust 外壳、Node sidecar、React 前端三方之间的**契约来源**，改契约必须先改本文件。

## 1. 定位

AgentDeck 是一个多 Agent 编排桌面工具：
- **界面与框架**：派生自 Hermes-CN-Desktop（Tauri v2 + React + Vite + TanStack Query + Jotai + CSS Modules）。视觉已于 2026-10 重做，不再沿用 Hermes 外观：通高灰底侧栏（导航 + 按项目分组的会话，见 4.17）+ 主区标题行（页面标题经 `pageHeaderSlotAtom` 挂入，窗口按钮在右侧），无顶栏与状态栏；系统字体，字号 12 / 13 / 14 / 22；0.5px 细线、全部圆角（token `--h-radius-*`），阴影只用于浮层与输入框；亮 / 暗为主，Dracula / Catppuccin 映射到同一套 token（`packages/shared-ui/src/tokens/`）。
- **调用方式**：借鉴 paseo（Apache-2.0），自己不直接调模型 API，而是驱动用户本机已安装的编程 Agent：
  - Claude Code：直接拉起用户本机 `claude` CLI，走 stream-json stdio 协议（长会话），不依赖 claude-agent-sdk
  - Codex：`codex app-server` 子进程，stdio 上的换行分隔 JSON-RPC
  - 通用 ACP：`@agentclientprotocol/sdk` 的 `ClientSideConnection`（内置 DeepSeek Harness `dsh --profile acp`，另可在 `acp-agents.json` / 中转中自定义）
- **唯一例外**：可选的翻译功能（4.35）直连用户自行配置的 OpenAI 兼容 endpoint，默认不启用。
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
- 前端直连 sidecar 的 WS；webview 拦截 `ws://` 时走 Rust 中继 `ws_proxy.rs`（线协议不变）。中继的 WS 帧和消息上限放宽到 256 MiB，因为 tungstenite 默认 16 MiB 的帧上限会打断大的 `agent.timeline` 响应（断线重连循环）。
- 安卓 App（规划中，见 `docs/mobile.md`）经 sidecar 的远程网关接入（4.31）：独立端口、默认关闭、扫码配对、端到端加密，加密信道内跑的仍是第 4 节的 JSON-RPC。

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
- 其余所有日志写 stderr 和日志文件。Rust 持续读空 stdout/stderr，并写入 `<data>/logs/desktop.log`（3.6）。
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

### 3.6 Rust 外壳日志 `desktop.log`

**现状（事故前）**：Rust 侧用 `log` + `env_logger::init()`，输出到进程 stderr，且默认过滤级别只有 `error`；release 构建是 `windows_subsystem = "windows"`，进程没有控制台，stderr 无处可去。sidecar 的 stdout / stderr 经读线程转成 `log::info!` / `warn!`，因此同样既被默认级别过滤、又没有落点。结果：外壳没有任何日志文件，sidecar 的 stderr 与退出码全部丢失。

**落盘**：`<data>/logs/desktop.log`（data 目录见 3.5）。
- 日志初始化（`desktop_log::init`，`main` 最先调用）：仍用 `env_logger`（保留 `RUST_LOG`），默认过滤改为 `warn,agentdeck=info,agentdeck_core=info`，输出目标改为「写入异步队列 + 同步 tee 到 stderr（供开发态控制台）」。日志目录在 `setup` 里才能确定，此前的日志留在队列中，`desktop_log::attach(log_dir)` 后补写。
- **写文件不阻塞调用方**：所有日志经容量 16384 的有界队列交给独立写线程；队列满时丢弃新行并计数，写线程随后补一行「日志队列已满，丢弃 N 行」。sidecar stdout / stderr 的读线程只做 `try_send`，不会因磁盘慢而停止读管道，从而不会反压 sidecar。
- 记录内容：Rust 侧所有 `log` 记录（含 panic，经 panic hook 写成 error）；sidecar **stderr 的全部行**与 ready 之后 stdout 的行（直写日志队列，不受 `RUST_LOG` 过滤；单行超过 16 KB 截断并注明原长度，读线程对无换行的超长输出只保留前 16 KB，非 UTF-8 字节宽松解码，读线程不会因坏字节提前退出）；sidecar 进程退出时的退出码 / 信号（意外退出记 `warn`，主动停止记 `info`，Windows 同时给出十六进制如 `0xC0000409`）；监管重启事件（沿用 supervisor 现有日志）。应用退出时 `flush`（最多等 1 秒）。
- 轮转：写入前若会使文件超过 5 MB，则把 `desktop.log` 改名为 `desktop.log.1`（覆盖旧的）再新建，只保留一份；启动 attach 时对已超限的旧文件同样处理；改名失败（被占用）则继续追加，不丢日志。
- **脱敏**（写入前，规则同 4.26）：`adi_[0-9a-f]{16,}` → `adi_***`；`AGENTDECK_TOKEN` 后面紧跟 `=` / `:` 的值 → `***`；`token=` 查询参数中 ≥16 位的 token 串 → `***`；以及本进程生成过的 sidecar token 原文（`generate_token` 时登记，保留最近 16 个）。
- 诊断包（4.18）：`logs/desktop.log`、`logs/desktop.log.1`（存在才放，各取最后 5 MB）。读出后用同一脱敏函数再处理一遍。

## 4. 前端 ↔ sidecar 协议（JSON-RPC 2.0 over WebSocket）

- 地址：`ws://127.0.0.1:<port>/rpc?token=<token>`。token 不匹配直接以 HTTP 401 拒绝升级。
- `GET /health`（无需 token）→ `{ "ok": true, "version": "..." }`
- 每个 WS 文本帧是一个 JSON-RPC 2.0 对象。客户端发请求，服务端回响应；服务端主动推送用**通知**（无 id）。
- 错误码：`-32700` 解析错误、`-32600` 非法请求（含批量请求、二进制帧）、`-32601` 方法不存在、`-32602` 参数错误（`data.issues` 为 zod 校验详情）、`-32000` 业务错误（`data.code` 给出细分：`PROVIDER_NOT_FOUND`、`PROVIDER_UNAVAILABLE`、`AGENT_NOT_FOUND`、`AGENT_CLOSED`、`TURN_IN_PROGRESS`、`PERMISSION_NOT_FOUND`、`NOT_SUPPORTED`、`TASK_NOT_FOUND`、`RETRACT_UNAVAILABLE`、`RESPONSE_TOO_LARGE`、`TRANSLATION_FAILED`（4.35）、`INTERNAL_ERROR`）。未预期异常也走 `-32000` + `INTERNAL_ERROR`。`RESPONSE_TOO_LARGE` 只由远程网关（4.31）在响应明文超过 16 MiB 帧上限时代发（message 中文，含实际大小），本机 `/rpc` 不会产生。`PERMISSION_NOT_FOUND` 有两处来源：AgentManager 按快照 `pendingPermissions` 判断（快照异步更新），以及各 provider session 的 `respondToPermission` 找不到挂起请求（claude / codex / acp / mock 一律抛 `AgentRpcError("PERMISSION_NOT_FOUND")`）——桌面与手机几乎同时点按钮时，后到的请求会穿过前者进入 session 层，不能落成 `INTERNAL_ERROR`。前端审批卡片（权限卡与提问卡）遇到该码显示「已在其他设备处理」、禁用按钮并在约 1.5 秒后移除该卡片；其它错误经 `humanizeSidecarError` 汉化后显示，卡片保留可重试。

### 4.1 请求方法

| 方法 | 参数 | 返回 |
|---|---|---|
| `sidecar.info` | — | `{ version, pid }` |
| `provider.list` | — | `ProviderInfo[]` |
| `provider.listModels` | `{ provider, cwd? }` | `{ models: AgentModelDefinition[], modes: AgentMode[] }` |
| `agent.create` | `{ provider, cwd, model?, modeId?, thinkingOptionId?: string \| null, title?, translation? }` | `{ agent: AgentSnapshot }`（`translation` 见 4.35） |
| `agent.list` | — | `{ agents: AgentSnapshot[] }` |
| `agent.send` | `{ agentId, prompt: AgentPromptInput, clientMessageId? }` | `{ turnId }` |
| `agent.cancel` | `{ agentId }` | `{}` |
| `agent.retract` | `{ agentId }` | `{ prompt: AgentPromptInput, clientMessageId? }`（首次响应前撤回，见 4.16） |
| `agent.permission.respond` | `{ agentId, requestId, response: AgentPermissionResponse }` | `{}` |
| `agent.setModel` | `{ agentId, modelId: string \| null }` | `{ agent: AgentSnapshot }` |
| `agent.setMode` | `{ agentId, modeId }` | `{ agent: AgentSnapshot }` |
| `agent.setThinking` | `{ agentId, thinkingOptionId: string \| null }` | `{ agent: AgentSnapshot, notice?: string }`（见 4.10） |
| `agent.close` | `{ agentId }` | `{}` |
| `agent.reclaim` | `{ agentId }` | `{ agent: AgentSnapshot }`（结束 provider 进程、转为 dormant，见 4.34） |
| `agent.timeline` | `{ agentId, sinceSeq?, beforeSeq?, limit? }` | `{ epoch, entries: AgentStreamEnvelope[], hasOlder?: boolean }`（`beforeSeq` / `limit` 为向前分页，见 4.31） |
| `agent.subagents.list` | `{ agentId }` | `{ subagents: ProviderSubagentDescriptor[] }`（见 4.11） |
| `agent.subagents.timeline` | `{ agentId, subagentId, direction?, cursorSeq?, limit? }` | `{ rows, hasOlder, hasNewer }`（见 4.11） |
| `agent.commands` | `{ agentId }` | `{ commands: AgentSlashCommand[] }`（见 4.14） |
| `agent.mcp.status` | `{ agentId }` | `AgentMcpStatusResult`（见 4.14） |
| `agent.mcp.reconnect` | `{ agentId, serverName? }` | `AgentMcpStatusResult`（重连后的最新状态，见 4.14） |
| `agent.status` | `{ agentId }` | `{ sections: AgentStatusSection[] }`（AgentDeck 本地 `/status`，见 4.14） |
| `agent.tasks.list` | `{ agentId }` | `{ tasks: AgentBackgroundTask[] }`（见 4.15） |
| `agent.tasks.stop` | `{ agentId, taskId }` | `{}`（见 4.15） |
| `agent.tasks.output` | `{ agentId, taskId, maxBytes? }` | `{ text, truncated, size }`（见 4.15） |
| `translation.translate` | `{ direction, text }` | `{ text }`（见 4.35） |
| `translation.endpoint.get` / `translation.endpoint.set` | `{}` / `{ patch }` | `TranslationEndpoint`（远程禁止，见 4.35） |
| `agent.update` | `{ agentId, title?: string \| null, pinned?, archived?, interopTarget?, translation?, cacheKeepAlive? }` | `{ agent: AgentSnapshot }`（重命名 / 置顶 / 归档 / 互通 / 翻译 / 缓存保活开关，见 4.17、4.26、4.35、4.36） |
| `agent.search` | `{ query, limit?, agentIds? }` | `{ hits: AgentSearchHit[], truncated }`（全文搜索，见 4.19） |
| `usage.summary` | `{ sinceMs?, untilMs? }` | `UsageSummary`（跨会话用量统计，见 4.20） |
| `agent.steer` | `{ agentId, prompt: AgentPromptInput, clientMessageId? }` | `{}`（运行中插话，见 4.22） |
| `agent.fork` | `{ agentId, throughSeq?, title? }` | `{ agent: AgentSnapshot }`（会话分叉，见 4.23） |
| `settings.get` / `settings.set` | `{}` / `{ patch }` | `SidecarSettings`（sidecar 设置，见 4.24） |
| `snapshot.list` / `snapshot.diff` / `snapshot.restore` / `snapshot.storage` / `snapshot.prune` | 见 4.24 | 按回合 git 快照（影子仓库） |
| `schedule.list` / `schedule.upsert` / `schedule.delete` / `schedule.runNow` / `schedule.runs` / `schedule.setPaused` | 见 4.25 | 定时任务、心跳、目标循环 |
| `group.create` / `group.list` / `group.get` / `group.delete` | 见 4.27 | 并行协作组（扇出 + 汇总） |
| `board.get` / `board.updateSettings` / `board.upsertTask` / `board.deleteTask` / `board.moveTask` / `board.merge` | 见 4.28 | 看板式任务分派 |
| `remote.status` / `remote.pairing.create` / `remote.devices.revoke` | 见 4.31 | 远程网关（手机接入）；远程客户端不可调用 |

同一 agent 同一时刻只允许一个进行中的 turn；忙时 `agent.send` 返回 `-32000` + `TURN_IN_PROGRESS`。例外：进行中的是 CLI 自发轮次（`turn_started.origin === "background"`）时允许 send，见 4.12。

### 4.2 通知

| 方法 | 参数 |
|---|---|
| `agent.stream` | `AgentStreamEnvelope` = `{ agentId, seq, epoch, timestamp, event: AgentStreamEvent }` |
| `agent.state` | `{ agent: AgentSnapshot }`（创建、状态变化、模型/模式变化、关闭时推送） |
| `agent.subagents.update` | `ProviderSubagentUpdate`（见 4.11） |
| `agent.tasks.update` | `{ agentId, tasks: AgentBackgroundTask[] }`（后台任务整表，见 4.15） |
| `schedule.changed` | `{ schedules: Schedule[], paused }`（调度表 / 运行记录变化，见 4.25） |
| `schedule.notice` | `ScheduleNotice`（目标循环结束 / 定时任务失败，前端转系统通知，见 4.25） |
| `board.changed` | `{ projectPath, board: Board }`（看板整张替换，见 4.28） |
| `group.changed` | `{ group: AgentGroup }`（协作组新建 / 状态 / 成员变化，见 4.27） |
| `group.removed` | `{ groupId }`（协作组被删除，见 4.27） |
| `remote.changed` | `RemoteStatus`（网关启停、设备配对 / 吊销 / 连接 / 断开，见 4.31） |
| `client.attention` | `AttentionNotice`（只发给远程客户端，手机据此弹本地通知，见 4.31） |

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
  | { type: "elicitation"; serverName: string; mode: "form" | "url"; message: string;
      url?: string; elicitationId?: string; fields?: ElicitationField[] }              // MCP 表单 / 浏览器流程，见 4.32
  | { type: "unknown"; input: unknown; output: unknown };

export interface ElicitationField {   // 见 4.32
  key: string; title?: string; description?: string; required: boolean;
  type: "string" | "number" | "integer" | "boolean" | "select" | "multiselect";
  options?: { value: string; label: string }[]; format?: string;
  min?: number; max?: number; minLength?: number; maxLength?: number;
  default?: string | number | boolean | string[]; secret?: boolean;
}

export interface AgentQuestionOption { label: string; description?: string; preview?: string }
export interface AgentQuestion {
  question: string; header?: string; multiSelect: boolean; options: AgentQuestionOption[];
  isOther?: boolean;    // 是否允许「其他」自由输入，缺省 = 允许（Claude）；Codex request_user_input 显式给出，见 4.33
  isSecret?: boolean;   // 输入框遮罩
  freeText?: boolean;   // 纯文本题：没有选项，只有输入框
}

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

export interface AgentPermissionAction {
  id: string;                         // 约定 id：allow_session「本会话始终允许」、allow_project「永久允许」；其余由 provider 自定
  label: string; behavior: "allow" | "deny";
  persist?: "session" | "permanent";  // 「始终允许」类的持久化范围；前端据此用次要样式（ACP 的 optionId 不固定，不能只靠 id）
  description?: string;               // 补充说明（永久规则内容与写入位置等），前端放 tooltip 与按钮下方说明行
}
export interface AgentPermissionRequest {
  id: string; provider: AgentProviderId; name: string;
  kind: "tool" | "plan" | "question" | "mode" | "elicitation" | "other";
  title?: string; description?: string; input?: Record<string, unknown>;
  detail?: ToolCallDetail; actions?: AgentPermissionAction[];
  defaultDeny?: boolean;              // true 时前端不得把「允许」类按钮作为默认 / 主按钮（Claude default_to_no）
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
  backgroundActive?: boolean;   // 有运行中的 provider 子代理 / 后台任务（见 4.4；不持久化）
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
- `AgentSnapshot.backgroundActive?: boolean`：本会话有运行中的 provider 子代理（4.11，`status === "running"`）或后台任务（4.15，`status === "running"`）；由 sidecar 在子代理 / 后台任务表每次变化后重算，值变化时随 `agent.state` 下发；**不持久化**（会话关闭 / 休眠 / sidecar 重启后为 false 或缺省，读取 meta.json 时忽略）。它**不改变 `status` 的语义**：发送排队 / steer、调度、委派等忙碌判断仍只看 `status === "running"`，输入框保持可正常发送；前端显示会话状态时 `status === "running" || backgroundActive` 视为「进行中」。

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
- 同一 callId 的 tool_call 多次更新（典型为 `Agent` 子代理工具，每次推进都带累计 actions 摘要）时，内存时间线和 `agent.timeline` 只保留**首条（决定卡片位置）与最新一条**；`timeline.jsonl` 仍然只追加，读取时若发现中间更新，就在该 agent 的写入链上原子重写压缩（`timeline-compact.ts`）。背景：一次事故里会话 timeline.jsonl 达 35MB / 5180 行，其中 3451 行是 15 个 Agent 调用的中间更新，`agent.timeline` 单帧约 35MB。

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

**Codex 中转的 config.toml / auth.json**（仅 `extends: "codex"`，对标 cc-switch 的 Codex 配置；**不写入用户 `~/.codex` 下任何文件**，只做会话级覆盖）：
- `ProviderProfile` 增加 `codexConfig?: string`（config.toml 原文，保留注释与格式）与 `codexAuth?: Record<string, unknown>`（auth.json 的 JSON 对象），明文保存在 `providers.json`；其它 extends 填写时校验失败（「只有基于 Codex 的中转可以使用 config.toml / auth.json」）。空白字符串视为未填写。前端在 Codex 中转表单里提供「config.toml」「auth.json」两个输入框（位置同 Claude 的「设置 JSON」）；auth.json 实时校验须为 JSON 对象，config.toml 由 sidecar 校验（错误路径 `providers.<i>.codexConfig` 就地显示）。
- 校验（zod，加载 `providers.json` 与 `provider.config.set` 共用）：`codexConfig` 必须能被 TOML 解析（「config.toml 解析失败：…」）；设置了顶层 `model_provider` 时，必须在同一份 TOML 的 `[model_providers.<名>]` 中定义（「config.toml 的 model_provider「x」没有对应的 [model_providers.x]」，防止落到内置 provider 而带出用户登录）；`codexAuth` 必须是 JSON 对象，`OPENAI_API_KEY` 存在时必须是字符串。
- 合成 thread `config` 覆盖（`launch.ts` 的 `buildCodexLaunchOverride`，启动与 `provider.test` 共用同一解析）：
  1. 以解析后的 TOML 对象为底，删除其中的 `model_providers`（只保留下面的 `agentdeck-<id>` 一项，避免其它条目与用户同名 provider 合并）。
  2. 生效 provider 条目：TOML 中 `model_provider` 指向的条目（原名丢弃）作为底；表单填了 baseUrl 时 `base_url` 以表单为准（补 `/v1`）。存在 TOML 条目或表单 baseUrl 即为中转：条目键名统一为 `agentdeck-<id>`，`model_provider` 指向它，缺省补 `name: label`、`wire_api: "responses"`。都没有时不生成 provider（非中转，只覆盖模型等其它配置，沿用用户登录）。
  3. 密钥：`profile.env.OPENAI_API_KEY` > 表单 apiKey > `codexAuth.OPENAI_API_KEY`（空白视为没有），结果写入子进程环境 `OPENAI_API_KEY`。auth.json 的其它字段（如 ChatGPT 登录 `tokens`）不使用。
  4. **中转凭据隔离**：中转时条目一律 `requires_openai_auth = false`（不读用户 `~/.codex/auth.json` 的密钥与 ChatGPT 令牌）；有密钥且条目未自带 `env_key` 时写 `env_key = "OPENAI_API_KEY"`；条目自带的 `env_key` / `experimental_bearer_token` / `http_headers` 等保留。无密钥时不带鉴权头。
  - 合成结果再与会话互通的 `mcp_servers` 合并（同 4.26）；`approval_policy` / `sandbox_mode` / `model` 等以 thread 参数为准（显式传入的优先于 config 覆盖）。
- `provider.test`（codex）：地址 = 表单 baseUrl > 生效 TOML 条目的 `base_url` > `profile.env.OPENAI_BASE_URL` > 默认；密钥按上面第 3 步。
- 脱敏：`codexAuth` 中的 `OPENAI_API_KEY` 与 apiKey 同样一律脱敏；日志中不打印 config.toml 与 auth.json 全文。

### 4.8 编程 Agent 可执行文件路径（Rust 命令 + sidecar 共用）

「编程 Agent」设置页可为 Claude Code / Codex 手动指定可执行文件，Rust 检测与 sidecar 启动共用同一份配置。

- **配置文件**：`<数据目录>/coding-agent-paths.json`（数据目录见 3.5，即 sidecar 的 `AGENTDECK_DATA_DIR`），内容 `{ "claude"?: string, "codex"?: string }`；键缺省、`null` 或空字符串（去首尾空白后）= 自动查找。文件不存在或不是合法 JSON 对象时视为全部自动查找（允许 UTF-8 BOM）。
- **Rust 命令**（`src/commands/coding_agents.rs`，逻辑在 `src/coding_agents.rs`）：
  - `coding_agent_paths_get` → `{ claude?: string, codex?: string }`（未配置的键省略）。
  - `coding_agent_paths_set { paths: { claude?: string | null, codex?: string | null } }` → 规范化后的同结构：整份替换；非空值必须是绝对路径且文件存在（目录不算），否则返回中文错误（`AppError` 的 message，如「Codex 可执行文件不存在：…」）且不改动已有文件；写入为「临时文件 `coding-agent-paths.json.tmp` + rename」。
  - `coding_agents_check` 读取该文件：某 agent 配置了路径时**只探测该路径**（不再回退 PATH 与常见安装点）；路径不存在时 `installed=false`，`version` 字段为「配置的路径不存在：…」。`CodingAgentStatus` 增加 `configuredPath: string | null`（未配置为 null）。
- **sidecar 优先级**：配置文件 > 环境变量（`AGENTDECK_CLAUDE_PATH` / `AGENTDECK_CODEX_PATH`）> 自动查找。配置中的路径沿用环境变量那套解析（Claude：`.cmd` shim → 真实 exe 或 cli.js，并跑 `--version` 校验；Codex：`.js` 入口 / `.cmd` shim → 平台原生 exe 或 node + codex.js，其它直接执行）。配置路径无效（不存在、shim 解析不出、Claude `--version` 失败）时 provider 不可用，`unavailableReason` 为中文原因（「配置的 … 路径不存在：…；请在「编程 Agent」页修改路径或恢复自动查找」），`agent.create` 返回 `PROVIDER_UNAVAILABLE`，**不静默回退**。基于 claude / codex 的中转（未填 `command`）同样使用该配置；中转填了 `command` 时以 `command` 为准。读取工具 `packages/sidecar/src/utils/coding-agent-paths.ts`。
- **即时生效**：sidecar 每次解析可执行文件都同步重读配置文件（文件很小）。Codex 每次 `isAvailable` / 建会话都重新解析；Claude 的解析结果原本缓存 60 秒，缓存键改为「当前配置的 claude 路径」，配置变化即作废重解析。因此保存后无需重启 sidecar，下一次 `provider.list` / 新建会话即按新配置。已在运行的会话继续使用旧可执行文件直到关闭。前端保存成功后让 `coding_agents_check` 查询与 sidecar 的 provider.list / 模型目录查询失效并重新获取。
- **DeepSeek Harness 检测**：`coding_agents_check` 的第三项 `{ id: "dsh", label: "DeepSeek Harness" }`，只在有效 PATH 上找 `dsh` 并跑 `dsh --version`（与 sidecar 的 `acp:dsh` 解析一致：Windows 上 PATHEXT 顺序下先命中的项），配置目录 `DSH_HOME` 或 `~/.dsh`；dsh 没有登录概念（模型与 API Key 在 DeepSeek Harness 桌面端配置），`loginState` 恒为 `unknown`；不提供路径配置（`configuredPath` 恒为 null，不进 `coding-agent-paths.json`）。
- **无法运行**：`CodingAgentStatus.runError?: string`——找到了可执行文件但版本命令失败（非 0 退出或无法启动）时为原因（「版本命令退出码 …: <stderr>」），三个 agent 通用；前端此时卡片标「无法运行」（error 色）、显示「运行错误」一栏、隐藏版本与登录，不计入就绪数。典型场景：DeepSeek Harness 桌面端升级后旧的 `%APPDATA%\DeepSeek Harness\bin\dsh.exe` 仍在 PATH 上，但它指向的旧版本目录已删除。
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
- agent 不提供 `models` 时，取 configOptions 中 `category === "model"` 的 select 项（分组选项展开）作模型目录：`options[].value` / `name` / `description` → 模型 id / label / description，`currentValue` 为默认模型；setModel / 建会话 model 参数走 `session/set_config_option { configId, value }`（null 设回建会话时的模型）；`config_option_update` 中该项 `currentValue` 变化时发 `model_changed`。DeepSeek Harness 0.2 即如此（模型 id 形如 `["deepseek-official","deepseek-v4-flash"]`，不透明）。
- agent 既不提供 `models` 也没有 model 配置项、但有思考档位时，目录给一个占位模型 `{ id: "default", label: "默认（跟随 Agent 设置）", isDefault: true }` 承载档位；对该占位模型的 setModel / 建会话 model 参数视为「不指定」。
- setThinking → `session/set_config_option { sessionId, configId, value }`；null 时设回建会话时的 `currentValue`。成功后发 `thinking_option_changed`。agent 没有 thought_level 项 → `NOT_SUPPORTED`。
- `config_option_update` 中 thought_level 的 `currentValue` 与已知值不同时，同步发 `thinking_option_changed { thinkingOptionId: currentValue }`。
- 建会话时带 `thinkingOptionId` 则在 session/new 后立即设置（失败只记日志，同模型）。

**前端**：
- 输入框工具栏「Agent / 模型 / 模式」后追加「思考」chip：选项 = 当前模型（未选模型时为 `isDefault` 模型）的 `thinkingOptions`，首项「默认」= null（跟随 CLI 设置）；该模型没有 `thinkingOptions` 时隐藏。
- 新建会话：选择随 `agent.create` 传入，并与模型 / 模式一起记忆在 ui_store（`agentdeck.composer.agent-selection` 增加 `thinkingOptionId`）；切换模型 / Agent 后若当前档位不在新模型选项中，重置为默认。
- 会话中：调 `agent.setThinking`，运行中也可切换（其它 chip 运行中仍禁用），显示返回的 notice；快照经 `agent.state` 同步显示。

### 4.11 provider 子代理（Claude / Codex；ACP 不支持）

参照 paseo 的 provider subagents（`packages/server/src/server/agent/provider-subagents/store.ts`、`providers/claude/subagents/*`、`providers/claude/sidechain-tracker.ts`、`providers/codex-app-server-agent.ts`，以及 `packages/protocol/src/messages.ts` 的 `agent.provider_subagents.*`）。子代理**只存在于 sidecar 内存**，不落盘、不随会话恢复；父时间线里的 `sub_agent` 工具卡片照常持久化。存在 `running` 子代理时快照 `backgroundActive` 为 true（见 4.4）。

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
- `ProviderSubagentStore`（`agent/provider-subagent-store.ts`）：键 `parentAgentId\0subagentId`；每个子代理时间线最多保留 2000 行（超出丢最旧的，hasOlder 以实际保留为准）；**另有大小限制**（事故背景：多个子代理大量读取截图，base64 经 stream-json 流入 sidecar，会话 `timeline.jsonl` 达 31 MB，而此前只限行数不限单行大小）：
  - 单行（一条 `ProviderSubagentTimelineRow` 的 item）经 `limitTimelineItem`（`agent/timeline-limits.ts`，规则见 5.3「时间线大小限制」）处理：文本总预算 64 KB，超出截断；图片内容替换为占位文本「[图片 约 N KB，已省略]」。截断发生在写入 store 之前，因此广播给前端的 `agent.subagents.update` 与 `agent.subagents.timeline` 返回的都是截断后的内容。
  - 每个父会话的全部子代理时间线合计字节数（各行截断后 JSON 长度之和）上限 8 MB；超出时按时间（timestamp，同刻按 seq）从**最早的行**开始丢弃，跨该父会话的所有子代理时间线，直到回到上限内（至少保留刚写入的那一行）。丢弃后 `hasOlder` 以实际保留为准。
  - AgentManager 在事件尾链中拦截 `provider_subagent` 写入 store，并经监听器 `onSubagent` 推给 RpcServer 广播。
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
- `AgentTurnOrigin = "background" | "keepalive"`；`turn_started` 增加可选 `origin`，缺省 = 由 `agent.send` 发起，`"background"` = provider 在没有 startTurn 的情况下自行开始的轮次，`"keepalive"` = 缓存保活发起的回合（4.36，由 AgentManager 标注）。之后的 timeline / 权限 / usage 与普通回合相同，结束时同样只发一次 `turn_completed` / `turn_failed` / `turn_canceled`。
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
- 前端：每个 compactionId 对应一条居中分隔线样式的系统提示（消息 id `agent-compaction-<compactionId>`）：running「正在压缩上下文…」，completed 原地改为「上下文已自动压缩 / 上下文已手动压缩」（有 preTokens 时附「（压缩前 约 84.1k tokens）」），failed「上下文压缩失败」。提示插在当前回合尚无内容的助手消息之前；否则（回合中途压缩）该助手消息在此收尾，提示追加在末尾，其下另起一条助手消息（id `<原 id>-after-agent-compaction-<compactionId>`）承接本回合后续输出，提示随对话上滚而不是一直停在底部（回合结束时该段仍为空则移除）。completed 时清掉运行时 usage 的 `contextWindowUsedTokens`，输入框的上下文用量指示器随之隐藏，直到下一次 usage 到达。

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

Claude 用 `run_in_background` 跑的后台 Shell 命令（Bash / PowerShell 工具）在 CLI 里是 `local_bash` task。AgentDeck 只把**后台 Shell**登记成「后台任务」，供界面按会话列出、在右侧面板看命令与实时输出、单独停止；子代理 / workflow（`local_agent` / `local_workflow`）由 4.11 的子代理列表负责，不进后台任务。任务表只存在 sidecar 内存，不落盘、不随会话恢复（sidecar 重启后为空）。存在 `running` 后台任务时快照 `backgroundActive` 为 true（见 4.4）。

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
- 侧边栏按项目分组（「项目」区，取代原来的「进行中 / 置顶项目 / 最近对话」三段）：会话按 `agentInWorkspace` 同一口径（cwd，没有再看会话与工作区的关联；协作组整组取 `group.cwd`，子会话随父会话）归入已记住的项目；cwd 不是项目路径时按仓库归属——前端对每个已记住的项目调 `git_worktree_list`（仅在存在这类会话时查询），cwd 是某项目的非主 worktree（看板任务、委派、协作成员等，路径比较统一分隔符并忽略大小写）就归入该项目；仍找不到所属项目的会话（项目已删除、worktree 已移除、非仓库等）归入最后的「其他对话」。项目顺序：置顶项目在前，其余保持已记住项目列表（ui_store kv `agentdeck-cn-ui.workspaceProjects`）的顺序，会话活动不参与排序——新建对话、Agent 回复、打开会话都不会改变项目位置；新记住的项目放在最前，已记住的项目再次选用只刷新其 `updatedAt`（命令面板、工作空间页仍按它排序），不调整位置；按住项目行上下拖动可调整顺序（只能落在同为置顶 / 同为非置顶的项目之间，落在项目行上半 / 下半 = 排在其前 / 后），用 pointer 事件实现而非 HTML5 拖放（Windows 上 Tauri 接管文件拖放，HTML5 拖放事件进不了 webview），移动超过 4px 才算拖拽、拖完不触发折叠；打开已有会话只在其 cwd 尚未记住时登记为项目；没有会话的项目也显示（「暂无对话」）。项目内运行中的块（含子会话 / 协作组）排在前面，其余保持会话列表顺序；默认最多显示 8 块，其余收进「显示更多（N）」，当前打开的会话始终可见。项目行点击折叠 / 展开（折叠状态存 ui_store kv `agentdeck-cn-ui.sidebarCollapsedProjects`），折叠时有运行中的会话显示状态点；悬停出现「新建对话」，右键为项目菜单；区标题的「+」选择目录添加项目并在其中新建对话（仅桌面端）。
- 侧边栏顶部导航：「新建对话」始终显示；其下的快捷入口（对话历史、工作空间、终端、用量统计、自动化，`SIDEBAR_NAV_ENTRIES`）可在「设置 → 常规 → 侧栏快捷入口」逐个开关。关掉的入口路径存 ui_store kv `agentdeck.sidebar-hidden-entries`（字符串数组，缺省为空即全部显示；存「隐藏」而非「显示」，以后新增的入口默认可见）。只影响侧栏，命令面板与路由不变。
- 历史页：
  - 状态筛选旁增加视图切换「全部会话 / 已归档」，默认视图不含归档的会话。置顶的会话在最前，单列一个「置顶」分组。
  - 新增「选择」模式：每行复选框、「全选当前筛选结果」、底部批量操作栏（已选 N 个）：删除（确认弹窗写明数量；运行中的会话由 `agent.delete` 先关闭再删除）、归档 / 取消归档、置顶 / 取消置顶。批量操作在前端逐个调用 RPC，结束后汇总提示成功与失败数量。
  - 全文搜索见后续 4.19（第 2 批）。
- 旧的 ui_store `session_ui_state` 表（archived / pinned 列）与 `set_session_archived` / `read_archived_session_ids` 删除；置顶与归档只以 sidecar 快照为准。项目置顶仍沿用 ui_store kv。

### 4.18 Debug 面板与诊断包

**sidecar 日志轮转**：sidecar 启动打开 `sidecar.log` 前，若文件超过 10 MB，先把它重命名为 `sidecar.log.1`（覆盖旧的 `.1`），再新建。运行中不轮转。

**sidecar 致命错误与资源诊断**（`packages/sidecar/src/diagnostics.ts`；事故背景：sidecar 无征兆退出且 `sidecar.log` 里没有任何线索）：
- `uncaughtException`：用 `fs.appendFileSync` **同步**把错误、堆栈与当时的 `process.memoryUsage()`（rss / heapUsed / heapTotal / external / arrayBuffers）写入 `sidecar.log`（级别 `error`，独立于 logger 的文件句柄，logger 关闭后仍可写），再走原有优雅关闭（tree-kill 各 Agent 子进程）并以退出码 1 退出，另设 4 秒硬退出兜底。
- `unhandledRejection`：**保持现有行为（只记日志、不退出）**，但同样同步写入堆栈与内存，不因此引入新的崩溃。
- `process.on("exit")`：同步记一行「进程退出事件：code=<码> 原因=<原因>」。原因来自 `shutdown(reason)`（`stdin end` / `stdin close` / `stdin error` / `SIGINT` / `SIGTERM` / `父进程 <pid> 已退出` / `uncaughtException`），未经过 shutdown 的 `process.exit`（启动失败、配置错误等）记为「未经过 shutdown 流程」。被 `TerminateProcess` / 系统 OOM 杀死时 exit 事件不会触发，此时日志最后一条记录与内存采样就是线索。
- 运行标记：`<日志目录>/sidecar.running`（`{ pid, startedAt }`）启动时写入、`exit` 事件里同步删除；启动时发现残留即 warn「上次 sidecar（pid=…）未正常退出（被外部结束或进程级崩溃）」，用来区分被 `TerminateProcess` / OOM 硬杀（exit 事件不触发，标记残留）与进程自己退出（见 4.31「断线诊断」）。
- 内存采样：启动时记一条，之后每 5 分钟写一条 `info`「内存采样 rss=… heapUsed=… heapTotal=… external=… arrayBuffers=… heapLimit=…」，附带会话数与子代理时间线占用（行数 / 字节）；`heapUsed` 超过 `v8.getHeapStatistics().heap_size_limit` 的 80% 时额外写一条 `warn`。定时器 `unref`，不阻止退出。
- V8 的 `FATAL ERROR: Reached heap limit` 无法在 JS 里捕获（进程直接 abort，exit 事件也不触发），只能由 Rust 外壳记录 sidecar 的 stderr 与退出状态（见 3.6）。

**Rust 命令**：
- `log_tail { input: { maxBytes?: number } }` → `{ path: string, text: string, truncated: boolean, size: number }`：读取 `<日志目录>/sidecar.log` 尾部，`maxBytes` 默认 256 KB、上限 2 MB；从截断处跳到下一个换行再返回，按 UTF-8 宽松解码。文件不存在时 `text` 为空字符串、`size` 为 0，不报错。
- `debug_paths {}` → `{ dataDir, logDir, webviewDataDir? }`。
- `export_debug_bundle { input: { diagnostics: string, frontendEvents: string } }` → `{ ok, canceled, path?, bytes, error? }`：弹出保存对话框（默认文件名 `agentdeck-debug-<yyyyMMdd-HHmmss>.zip`），zip 内容：
  - `diagnostics.json`：前端收集的诊断信息（见下）；
  - `frontend-events.jsonl`：前端调试事件；
  - `logs/sidecar.log`、`logs/sidecar.log.1`（存在才放，各取最后 5 MB）；
  - `logs/desktop.log`、`logs/desktop.log.1`（Rust 外壳日志，见 3.6；存在才放，各取最后 5 MB，读出后按 3.6 的规则脱敏 token）；
  - `config/providers.json`：按 4.7 规则脱敏（apiKey 一律脱敏，`env` / `settings.env` 中长度 ≥ 6 的值脱敏）；`config/coding-agent-paths.json` 原样。
  - **绝不包含** `AGENTDECK_TOKEN`、WS 地址中的 token、ui.sqlite 与会话时间线。
- 前端传入的 `diagnostics` / `frontendEvents` 在前端已经过 `debug-redact.ts` 脱敏；Rust 再对 providers.json 单独脱敏。

**前端**：
- 全局采集（应用启动时安装一次）：`console.error` / `console.warn`、`window` 的 `error` / `unhandledrejection`、sidecar RPC 请求失败（方法名、错误码、message）、sidecar 连接断开 / 重连、`sidecar-status` 变化，写入 `debug-bus`（环形缓冲 500 条，写入前脱敏）。
- 调试页（「高级」下新增「调试」子页，并在命令面板加入「打开调试面板」）：
  - 运行状态：应用版本 / 提交 / 构建日期；sidecar 状态、版本、pid、端口（来自 `get_sidecar_config`，**不显示 token**）；「重启 sidecar」按钮。
  - 路径：`debug_paths` 的各目录，每项带「打开」。
  - Agent 可用性：`provider.list` 的可用状态与不可用原因，`coding_agents_check` 的版本与路径。两者合并为每个 Agent 一行：provider `claude` ↔ 检测项 `claude-code`、`codex` ↔ `codex`，版本与路径追加在 provider 行后；未对应到任何 provider 的检测项（如 sidecar 未连接时）才单独成行显示「已安装 / 未安装」。
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
  speedOutputTokens?: number; speedGenerationMs?: number; // 本回合合格响应的输出 token 与生成时长之和（4.30），取自 turn_completed.usage
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
  perf: { ttftP50Ms?: number; ttftP95Ms?: number; durationP50Ms?: number; durationP95Ms?: number; outputTokensPerSec?: number /* Σ speedOutputTokens ÷ Σ speedGenerationMs，口径同 4.30；没有数据时缺省 */ };
}
```
- 时间范围缺省为最近 30 天；按天分桶用 sidecar 进程本地时区。
- 前端新增「用量统计」页（侧栏入口 + 命令面板）：时间范围切换（7 天 / 30 天 / 90 天 / 全部）、总量卡片、按天堆叠柱状图（输入 / 缓存 / 输出）、按 Agent 与按模型的占比、高用量会话前 10（点击跳转，已删除的会话不可点）、性能指标（TTFT 与耗时 P50 / P95、输出速度——按 `perf.outputTokensPerSec` 显示，不再用回合总耗时估算；升级前的账本记录没有速度字段，不参与计算）。`backfilling` 时顶部提示「正在统计历史会话…」。
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
- 排队（纯前端，`stores/composer-queue.ts`，按会话存 localStorage）：自动出队由应用根部的 `useQueueAutoDrain` 监视所有会话，任一会话从运行变为空闲时发出其队首一条，不要求详情页正在显示该会话；用户中止 / 撤回的那一轮结束时不出队（下一轮开始即清除该标记）；首次看到就是空闲的会话（如重启后恢复的队列）不自动发出，用队列面板手动发送。「立即发送」与自动出队共用按会话的发送锁。

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
  remote: { enabled: boolean /* 默认 false */; port: number /* 默认 47631，1024–65535，见 4.31 */ };
  idleReclaim: { enabled: boolean /* 默认 true */; idleMinutes: number /* 默认 15，整数 1–1440，见 4.34 */ };
  translation: { userLanguage: string; agentLanguage: string; translateReasoning: boolean; translateInput: boolean; enabledByDefault: boolean } /* 见 4.35 */;
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

**实现补充（落地时确定）**：
- 协议：`AgentSnapshot.origin?: "user" | "delegate" | "group" | "schedule" | "judge" | "kanban"`（缺省 = user，4.26 共用）；`agent.create` 内部支持 origin（调度器新建会话写 `schedule`，评判会话写 `judge`），RPC 参数不开放。`schedule.upsert` 入参为 `ScheduleDraft`（无 id 新建；`runs` / `iterations` / `state` / `doneMarker`（默认 `GOAL_DONE`）/ `stopOnFailure`（默认 true）/ `onBusy`（默认 skip）可省略）。目标会话不存在 → `AGENT_NOT_FOUND`；`schedule.delete` / `runNow` 的 id 不存在、`schedule.runs` 的 `limit` 不在 1–1000 → `-32602`。
- 计时：单个定时器睡到最近一次触发，最长 30 秒（兼顾系统时间回拨 / 休眠，回拨时重算下次触发）。触发时刻已过去超过 90 秒（休眠唤醒、时间前跳）记一条 `missed`，不补跑；`everyMinutes` 的基准是应用启动 / 保存 / 上次触发的时刻；`at` 已过期时 upsert 拒绝启用（`-32602`），启动时遇到过期的 `at` 记 `missed` 并停用。
- 内部发送标记：`AgentManager.sendPrompt(agentId, prompt, clientMessageId?, { internal: true })` 表示调度器发出，不算用户介入；非内部的 `agent.send` / `agent.steer` / `agent.cancel` 会触发 `AgentManagerListener.onUserAction(agentId, kind)`，目标循环据此转为 `stopped`。
- `schedule.runNow`：cron 不受全局暂停影响（用户显式操作），心跳同；不等待发送完成（`onBusy: wait` 最长 30 分钟），结果见运行记录。goal 的 `runNow` = 继续循环（与 upsert `enabled: true, state: "running"` 等价）。
- 目标循环：`enabled` 与 `state === "running"` 恒同步（进入 done / stopped / exhausted / failed 时 `enabled` 置 false；界面的启用开关 = 继续 / 停止）；`iterations` 表示已完成但未达成目标的回合数；从 stopped 继续时 `iterations > 0` 发「继续推进目标…」，`iterations === 0` 与终态（done / exhausted / failed）重新开始时重置为 0 并重发首条提示。同一会话最多一个进行中的目标循环；启动时会话正在运行 → `TURN_IN_PROGRESS`。CLI 自发轮次（`origin: "background"`）不计入。`turn_canceled` → stopped；`turn_failed` 且 `stopOnFailure: false` 时按未完成继续。重启 sidecar 后进行中的目标循环转为 `stopped`（无法确认循环是否仍在进行），用户可在界面继续。全局暂停时的目标发送记 `skipped_paused` 并转 `stopped`。
- judge：评判会话（`origin: "judge"`，cwd 取被评会话）完成一次判定后由调度器删除（`agent.delete`）；评判失败 / 超时（10 分钟）/ 回复无法解析一律按「未完成」处理（首个非空行以 `DONE` 开头才算完成）。配置了 judge 时不再检查末行 doneMarker。前端侧栏、历史页（两个视图）与命令面板过滤 `origin === "judge"`（`lib/session-list.ts` 的 `isHiddenAgent`）。
- 心跳：每次回合结束（包括心跳自己触发的回合）开始新的空闲期，所以持续空闲时每隔 `idleMinutes` 触发一次，直到 `maxRuns`；应用启动时空闲起点取启动时刻（不补跑）；用户活动（任何回合开始）重置计时。达到 `maxRuns` 后 `enabled: false`，重新启用时 `runs` 归零。
- 会话被删除（`agent.removed`）：指向它的 heartbeat / goal / agent 目标 cron 立即 `enabled: false`（goal `state: "failed"`），记 `failed`（message「目标会话已删除」）并发失败通知；启动时发现目标已不存在同样处理。
- 通知：新增通知 `schedule.notice { scheduleId, name, kind: "done" | "exhausted" | "failed", message, agentId? }`（不复用 `schedule.changed`）。sidecar 在目标循环完成 / 达到 `maxIterations` / 失败、以及定时任务发送失败 / 目标丢失时广播，前端（`lib/notifications.ts` 的 `notifyFromSchedule`）按现有通知设置（总闸与「任务完成」开关）调用 `desktopNotify`。`schedule.changed` 在调度表或运行记录每次变化时广播；前端每次（重）连成功后拉一次 `schedule.list`。
- 下次触发时间：选择**前端用 croner 计算**（cron 表达式显示下次触发时间，弹窗预览未来 5 次；`everyMinutes` 的基准点在 sidecar 内存里，列表只显示「每 N 分钟」；`at` 显示触发时间），`schedule.list` 不返回 `nextRunAt`。
- 存储：`schedules.json` 损坏（非法 JSON）记日志并备份为 `schedules.json.bad` 后视为空；单条无法解析的调度项跳过；`schedule-runs.jsonl` 超过 5000 行时启动时裁剪为最近 2000 行。未设置 `AGENTDECK_DATA_DIR` 时只在内存保存。全局暂停存在 `schedules.json` 的 `paused`（不依赖 `settings.*`）。
- 前端入口：全局弹窗由 `scheduleDialogAtom` 驱动（`ScheduleDialogHost` 挂在应用根部），自动化页与会话右键菜单共用；右键「设置目标循环… / 设置心跳…」在该会话已有同类任务时直接编辑它。

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
| `list_agents` | `{ includeArchived?: boolean, callableOnly?: boolean }` | 会话列表（id、标题、provider、cwd、状态、模型、parentAgentId、`interopTarget`、`callable`、`updatedAt`）；标题未命名时为首条消息摘要，可能与界面上截断显示的不同，定位会话以 id 为准；`callable` = 调用方可对其 `send_to_agent` / `cancel_agent`（非自己，且为子孙或 `interopTarget`）；`callableOnly: true` 只返回 `callable` 的会话；`updatedAt` 为 ISO 时间 |
| `read_agent` | `{ agentId, lastMessages?: number /* 默认 10，上限 50 */ }` | 最近的用户 / 助手消息文本（工具调用一行摘要），总长上限 40k 字 |
| `delegate` | `{ provider, prompt, cwd?, model?, modeId?, title?, worktree?: boolean, wait?: boolean, timeoutSec?: number }` | `{ agentId, status, reply? }`：新建子会话（`parentAgentId` = 调用方，`origin: "delegate"`），cwd 缺省为调用方 cwd；`worktree: true` 时按 4.27 的规则建 worktree 作为 cwd（分支 `agentdeck/delegate-<agentId 前 8 位>`）；`wait`（默认 true）时等到该回合结束返回最后一条助手消息（上限 40k 字），超时（默认 600 秒，上限 3600；调用方开启缓存保活时上限 3000，见 4.36）返回 `status: "running"` |
| `send_to_agent` | `{ agentId, message, wait?: boolean, timeoutSec?: number }` | 同上；目标忙 → 工具错误「目标会话正在运行」 |
| `wait_agent` | `{ agentId, timeoutSec?: number }` | 等到目标当前回合结束，返回最后一条助手消息 |
| `cancel_agent` | `{ agentId }` | 中断目标会话当前回合 |

**安全约束**：
- 不能对自己调用 `send_to_agent` / `wait_agent`；委派深度（parent 链长度）上限 3，单个会话同时运行的子会话上限 8，超出返回工具错误。
- `delegate` 的 `modeId` 若为危险模式（`AgentMode.dangerous`）一律拒绝；缺省用 provider 默认模式。子会话的权限请求照常出现在 AgentDeck 界面由用户审批。
- `send_to_agent` 只允许发给调用方的子孙会话，或用户明确标记为「允许被其它会话调用」的会话（快照字段 `interopTarget?: boolean`，经 `agent.update` 设置）；否则返回工具错误。
- 工具调用的结果只包含文本，不包含 token、apiKey 等。

**服务说明（instructions）**：initialize 应答带 `instructions`（`INTEROP_INSTRUCTIONS`）：用户提到的会话 ID、或要求联系 / 询问 / 发消息给另一个会话时，指的是 AgentDeck 会话，用本服务的工具处理，不要把会话 ID 当作 Claude / Codex 的本地会话记录去搜索或读取 jsonl 等文件。Claude Code 把 MCP 工具延迟加载（只列名字），但会把服务说明放进系统提示词，因此用户只说「把 X 发给会话 <ID>」时，Agent 也会经 ToolSearch 取用 `send_to_agent` / `read_agent`，不用在提示词里写工具名（claude 2.1.x 实测）。

**快照**：`AgentSnapshot` 增加 `parentAgentId?: string`、`origin?: "user" | "delegate" | "group" | "schedule" | "judge" | "kanban"`、`groupId?: string`、`interopTarget?: boolean`。

**前端**：侧边栏子会话缩进显示在父会话下（可折叠）；详情页顶部显示「由 <父会话> 委派」链接；时间线里 agentdeck MCP 工具的工具卡片渲染为委派卡片（目标会话标题、状态、跳转）。设置「高级」中「会话互通」开关。会话右键菜单「允许被其它会话调用」开关与「复制会话 ID」（便于用户把准确的目标 id 告诉 Agent）。

**实测结论（claude 2.1.296、codex-cli 0.162.1，探针见 `tmp/mcp-probe.mjs`、`run-claude.mjs`、`run-codex.mjs`、`e2e.mjs`）**：
- Claude `--mcp-config '<内联 JSON>'`（`type: "http"` + `headers`，shell:false 传参）：**可用**。stream-json 模式下 `system init` 的 `mcp_servers` 里 `agentdeck` 为 `connected`（source `dynamic`），工具名 `mcp__agentdeck__<tool>`，调用结果正常返回。CLI 握手顺序为 `POST server/discover`（探测，返回 method-not-found 即可）→ `initialize` → `notifications/initialized` → `GET /mcp`（想开 SSE 通道，无状态端点返回 405 即可）→ `tools/list` → `tools/call`，均带 Authorization 头；与官方 SDK 的无状态 + `enableJsonResponse` 服务端兼容。用户 settings 允许时不弹权限；默认模式下每次工具调用走现有审批流。
- Codex `thread/start` 的 `config.mcp_servers.agentdeck`：`{ url, http_headers: { Authorization } }` 与 `{ url, bearer_token_env_var }` **两种都可用**（`mcpServerStatus/list` 为 `connected`，错误 token → `failed`），采用前者（不依赖子进程环境变量）。两个坑：① **URL 主机必须写 `localhost`**：本机系统代理开启时，codex 对 `127.0.0.1` 字面量的 MCP 请求会被送去代理（`HTTP 502`，连接根本没到 sidecar），`localhost` 直连正常，因此 Codex 注入时把 `127.0.0.1` 换成 `localhost`；② **`approvalPolicy: never`（full-access 模式）下 codex 直接拒绝需要审批的 MCP 工具调用**（`MCP tool call requires approval, but approval policy is never`），加 `default_tools_approval_mode: "approve"` 后可用。on-request 模式（read-only / auto）不加该项，工具调用走 codex 自身的 `mcpServer/elicitation/request`，在 AgentDeck 里表现为一条 `mcp:agentdeck` 工具审批，由用户批准。另加 `tool_timeout_sec: 3700`（默认 60 秒会打断 delegate / wait 的长等待）。时间线里 Codex 的工具名为 `agentdeck.<tool>`（Claude 为 `mcp__agentdeck__<tool>`），输出为 `{ content: [{ type: "text", text }] }`。

**实现补充（落地时确定）**：
- 模块：`server/interop-service.ts`（token ↔ agentId、端点）、`server/mcp-interop.ts`（`POST /mcp` 与工具）、`providers/shared/interop.ts`（三类 provider 的注入形态）、`git/worktree.ts`（共用 worktree 工具）。鉴权顺序：路径 `/mcp` → 互通关闭 404 → token 缺失 / 错误 401 → 非 POST 405。token 形如 `adi_<48 位 hex>`，sidecar 日志写入前统一把 `adi_[0-9a-f]{16,}` 替换为 `adi_***`（因此诊断包里的 `sidecar.log` 与 MCP 状态错误文本都不含 token）。
- 注入点：`AgentSessionConfig.interop` / `resumeSession` 的 `AgentResumeConfig.interop`（`{ url, token }`），由 AgentManager 在创建、恢复、分叉（含 Claude 懒启动的 pendingFork 恢复）时填入；token 每会话稳定、仅内存，sidecar 重启后重新生成并随恢复重新注入。互通关闭或端口未知时不注入。创建会话改为先生成 agentId 再建 provider 会话（`CreateAgentParams.id` 供委派预先建 worktree 分支）。
- `delegate`：`cwd` 相对路径按调用方 cwd 解析，目录必须存在；`worktree: true` 时 worktree 放 `<AGENTDECK_DATA_DIR>/worktrees/delegate-<agentId 前 8 位>`（要求设置了数据目录），失败 / 创建会话失败时回滚；`modeId` 除 `AgentMode.dangerous` 外，id 含 `bypass` / `full-access` / `dangerous` / `yolo` 或目录里查无此模式也拒绝；结果 JSON 为 `{ agentId, status: "completed" | "failed" | "canceled" | "running", reply?, error?, note?, worktree? }`，`reply` 超过 40k 字截断；`timeoutSec` 超过上限按上限处理。
- `wait_agent` 额外拒绝等待自己的上级会话（会互相等待）；`cancel_agent` 与 `send_to_agent` 同样只允许子孙或 `interopTarget` 会话；`read_agent` 不限制目标。
- `agent.update` 增加 `interopTarget?: boolean`（与 title / pinned / archived 至少给一个）。meta.json 持久化 `parentAgentId` / `origin` / `groupId` / `interopTarget`，加载时校验类型。
- 前端：委派卡片按工具名（`mcp__agentdeck__` 或 `agentdeck.` 前缀的 delegate / send_to_agent / wait_agent / cancel_agent / read_agent）识别，信息在 reducer 中从 `detail.unknown` 的入参与输出解析；侧栏子会话按 `parentAgentId` 嵌套（父会话缺失或成环时退化为顶层，整组在任一成员运行时排在所属项目的前面）；「会话互通」设置页路径 `/interop`。

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

**实现补充（落地时确定）**：
- 模块：`packages/sidecar/src/groups/`（`group-service.ts` 服务与汇总提示、`schema.ts` zod、`store.ts` 存储）；`AgentManager` 新增 `CreateAgentParams.groupId` 与 `setGroupId(agentId, null | id)`（落盘并推 `agent.state`）。`GroupService` 在 `main.ts` 于 `AgentManager.restore()` 之后启动，`RpcServer` 选项 `groups`（缺省时 `group.*` 返回 `NOT_SUPPORTED`）。
- 协议：`AgentGroup` / `AgentGroupMember` / `GroupCreateParams` 见 `agent-api.ts`；除 `group.changed { group }` 外新增通知 `group.removed { groupId }`（协作组被删除，前端据此从 store 移除、协作视图回首页）；`group.delete` 返回 `{ warnings?: string[] }`（removeWorktrees 时个别 worktree 清理失败的中文说明，协作组本身照常删除）。
- `group.create`：校验顺序为 zod（成员数 2–6、`worktree` 取值、`chair.mode`，失败 `-32602`）→ provider 存在且可用（`PROVIDER_NOT_FOUND` / `PROVIDER_UNAVAILABLE`，此时尚未建任何东西）→ per-member 要求 cwd 在 git 仓库内且设置了数据目录（否则 `-32602`「…要求工作目录位于 git 仓库内…」/ `NOT_SUPPORTED`）。groupId 取 uuid 前 8 位；worktree 路径 `<dataDir>/worktrees/<groupId>/<n>`、分支 `agentdeck/<groupId>/<n>`（n 从 1 起）。worktree 逐个建，任一失败回滚已建者并返回 `INTERNAL_ERROR`；成员会话并发创建，任一失败则删除已建会话与 worktree，沿用该错误码（非业务错误按 `INTERNAL_ERROR`）。成员 / 汇总会话标题为「<组标题> · 成员 n」/「<组标题> · 汇总」，组标题缺省取 prompt 前 30 字。prompt 以内部发送标记 `{ internal: true }` 并发发出；个别成员发送失败记为该成员失败，不使 `group.create` 失败。
- 回合结束判定：只看成员 / 汇总会话收到的 `turn_completed` / `turn_failed` / `turn_canceled`（CLI 自发轮次 `origin: "background"` 不算），成员只取首个结局；`canceled` 与 `failed` 对汇总判断等同「已结束」，汇总提示里分别注明「回合失败：<错误>」/「回合被中断」。汇总提示结构：模板首句 →「# 原任务」→「# 各成员结果」，每个成员一节（标题含序号 / provider / 模型，助手回答、per-member 时附 worktree 路径 / 分支与 `diffStat`，回答与 diffStat 各上限 20000 字，超出截断并注明）。汇总会话 cwd 为组原 cwd，使用默认模式与默认思考强度。
- 状态：`running` → `chairing`（全部成员有结局时，先落盘再建汇总会话）→ `done`（汇总回合 `completed`）/ `failed`（汇总回合失败 / 中断、建汇总会话或发送失败、汇总会话被删除）；无 chair 时全部成员结局即 `done`；成员被全部删除时直接 `done`。
- 删除：`group.delete` 解除成员与汇总会话的 `groupId`（落盘），`removeWorktrees` 时先中断运行中的成员再 `removeWorktree`（删分支）；`agent.removed` 时该会话从组中移除（组保留，仅余成员全部结束时仍会触发汇总）；汇总会话被删则清除 `chair.agentId`，`chairing` 的组转 `failed`。
- 重启恢复（`GroupService.start`，在会话恢复之后）：先剔除已不存在的成员 / 汇总会话；`running` 的组按各成员时间线的最后结局恢复，**没有结束回合的成员（重启时回合被打断，会话已是 dormant）记为失败**，全部有结局后继续推进（建汇总会话或完成）；`chairing` 的组：汇总会话尚未建出（`chair.agentId` 缺失）→ 重新建；汇总会话存在且时间线已有结束回合 → 按结局 `done` / `failed`；存在但没有结束回合 → 保持 `chairing` 等待它（用户在会话里手动续跑，其回合结束时据此收尾）。
- 存储：`groups/<id>.json` 原子写入；加载时非法 JSON / 结构不合法的文件记日志后跳过（不改名）；未设置数据目录时只在内存。
- 前端：`stores/groups.ts`（`bindGroupsToStore`：每次（重）连成功拉 `group.list`，之后 `group.changed` / `group.removed` 增量更新）；新建入口为首页「新任务」区右上角的「并行协作」按钮（`components/group/group-dialog.tsx`，每个成员复用 `AgentSessionPicker` 且各自拉取模型目录；是否 git 仓库复用 `useWorktrees(cwd).isRepo`，非仓库时「独立 worktree」禁用并提示）；协作视图路由 `/groups/:groupId`（`routes/group-view.tsx`，成员列复用 `MessageTimeline` 的 `compact` 密度，「查看 diff」复用预览栏的 `ReviewTab`，汇总区取 chair 会话最后一条助手消息经 `MessageText` 渲染）；侧栏用 `lib/session-list.ts` 的 `groupSessionRoots` 把同组根会话（连同其 4.26 子会话树）归入组节点，整组按 `group.cwd` 归入项目，组内任一会话在运行则整组排在项目内前面，组节点折叠状态与子会话折叠共用同一集合（键 `group:<id>`）。历史页不改。

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

**实现补充（落地时确定）**：
- 模块：`kanban/store.ts`（`boards/<sha1(规范化路径) 前 16 位>.json` 原子写入，坏文件 / 结构非法备份为 `.bad` 后视为空，单条非法任务跳过；未设数据目录只在内存）、`kanban/board-service.ts`（派发 / 判定 / 合并）；`main.ts` 在会话恢复之后 `start()`，关闭时先于 AgentManager 停止。
- 路径规范化（sidecar `normalizeProjectPath` 与前端 `lib/board-path.ts` 的 `boardPathKey` 等价）：去首尾空白、`\` 统一为 `/`、去尾部 `/`；盘符 / UNC 路径（Windows）一律转小写。看板内 `projectPath` 保留首次创建时的写法（去尾部分隔符），`board.changed` 带它；前端按规范化 key 索引。
- RPC 返回：`board.get / updateSettings / moveTask` → `{ board }`；`upsertTask` → `{ board, task }`；`deleteTask` → `{ board, warning? }`（`removeWorktree` 清理失败不阻止删除，原因放 warning）；`merge` → `{ ok, conflicts?, board, warning? }`。`board.updateSettings` 的 `settings` 是补丁（只覆盖给出的字段）；`board.upsertTask` 入参 `BoardTaskDraft`（`id` / `title` 1–200 / `description` ≤ 20000 / `assignee`（null 清除）/ `dependsOn` / `maxAttempts` 1–10），状态只能经 `moveTask` 改变。依赖不存在、依赖自己、成环均为 `-32602`；任务不存在为 `TASK_NOT_FOUND`。`maxConcurrent` 1–16。看板默认值：`worktreePerTask` 取决于 projectPath 是否在 git 仓库内，`autoDispatch: false`，`maxConcurrent: 2`，`defaultAssignee: { provider: "claude" }`；不存在的看板 `board.get` 只返回默认值，不落盘（第一次修改才创建）。
- 派发：同一看板的所有操作串行（按看板的互斥队列）。自动派发在每次看板变化后检查（任务增删改 / 移动 / 设置变化 / 回合结束 / 会话删除 / sidecar 启动），只数 running 状态的并发；依赖指向已不存在的任务视为已满足。worktree 目录 `<dataDir>/worktrees/task-<id>`、分支 `agentdeck/task-<id>`；未设数据目录或项目不在 git 仓库内时忽略 worktree 设置直接用 projectPath。任务已有 worktree（目录还在）时复用；任务的原会话仍存在且空闲时（review / blocked 再拖回 running）复用原会话重发提示，否则新建会话（`origin: "kanban"`，标题为任务标题）。`attempts` 每次进入 running 归零。**派发失败**（provider 不可用、建 worktree 失败等）不抛错：任务转 `blocked`，`blockedReason` 为「派发失败：…」，新建的 worktree 回滚。
- 回合结束：只看 `turn_started.origin !== "background"` 的回合，末行（忽略末尾空行）去空白后精确等于 `TASK_DONE` 或以 `TASK_BLOCKED:` 开头；`turn_canceled`（用户在会话里中断）→ review（交人工判断）；任务不在 running（如已被拖走）的回合结束事件一律忽略，所以移出 running 时先改状态再中断。`maxAttempts` 到达时 `blockedReason` 为「执行失败（已尝试 N 次）：<错误>」。
- `board.merge`：仅 review 且有 worktree 的任务可合并；先检查项目工作区**已跟踪文件**有无未提交改动（`status --porcelain --untracked-files=no`，有则拒绝并报「项目工作区有未提交改动…」，未跟踪文件交给 git 自己的冲突检测）；合并前若任务 worktree 里还有未提交改动，先自动 `git add -A && git commit`（Agent 通常不提交；本机无 git 身份时用 `AgentDeck <agentdeck@localhost>` 兜底重试）；然后 `git merge --no-ff --no-edit <分支>`，失败且有未合并文件 → `merge --abort` 返回 `{ ok: false, conflicts }`，无冲突文件的失败（如无 git 身份无法建合并提交）→ 中止后抛错。成功后任务 done；`removeWorktree` 时删 worktree 与分支并清掉 `task.worktree`，清理失败放 warning。
- 会话被删除（`onRemoved`）：该会话的任务解除 `agentId`，running → todo（开启自动派发时会立即重新派发）。sidecar 重启（`start()`）：running 任务的会话不存在 → todo；会话在重启后一律 dormant，时间线末尾有未结束回合 → blocked（「sidecar 重启时任务回合尚未结束…」）；否则按最后一个已结束回合补判（规则同上，失败回合会计一次 attempts 并按需重发）；没有任何已结束回合同样 blocked。
- 前端：`web/src/components/board/`（`board-view` 看板与原生 HTML5 拖拽——项目没有拖拽依赖，不新增；`task-drawer` 详情抽屉；`board-settings-dialog`；`assignee-picker` 复用 `AgentSessionPicker`，选择状态由调用方持有、不写新建会话的记忆，思考强度不属于指派）。落点规则：落在列上 = 追加到列尾，落在卡片上半 / 下半 = 排在其前 / 后，`order` 取邻居中点（`lib/board-display.ts` 的 `orderForDrop`）；运行中任务拖出 running 前先确认。看板 store `stores/boards.ts` 按规范化路径索引，`board.changed` 整张替换，进入看板与每次（重）连成功后 `board.get` 一次。抽屉里「查看 diff」复用 `ReviewTab`，`workspaceRoot` 指向任务 worktree（无 worktree 时指向项目目录）。项目详情页新增「概览 / 看板」标签。

### 4.29 输入框上方状态行：子代理 · 后台任务 · 步骤 · 额度 · 速度

- 输入框上方原本上下两行的「子代理」（4.11）与「后台任务」（4.15）芯片合并为**同一行**，从左到右：子代理、后台任务；之后依次新增「步骤」「额度」（4.30）「速度」芯片。各芯片没有内容时隐藏，整行都没有内容时不占高度。窄宽度时芯片不换行，文字省略。
- 「步骤」= Agent 自己维护的待办清单：取当前会话时间线中**最近一条** `todo` 项（Claude TodoWrite 与 TaskCreate / TaskUpdate / TaskList、Codex plan、ACP plan 均归一为 `todo`，见 4.3 / 5.1 / 5.3）。
  - 芯片文字「步骤 已完成数/总数」（全部完成时显示「步骤 N/N ✓」样式的完成态，颜色用 token 中的成功色）；回合进行中且有未完成项时，第一条未完成项视为「进行中」。
  - 点击展开弹层（与子代理 / 后台任务弹层同一套样式与开合行为）：按顺序列出每一步，状态图标区分已完成 / 进行中 / 未开始，已完成项文字弱化；列表过长时弹层内滚动。
  - 没有任何 `todo` 项时不显示；新会话或分叉（4.23）后以新会话自身时间线为准。
- 「步骤」纯前端实现，不改协议。
- 「速度」芯片显示输出速度「N tok/s」（取快照 `lastUsage.outputTokensPerSecond`，≥1 取整、不足 1 保留 1 位小数，与 cc-switch 一致）：回合进行中显示实时值，空闲时显示上一回合的最终值（文字弱化，悬停提示「上一回合平均输出速度」）；没有值时隐藏。

### 4.30 额度（用量限制）显示

**协议**：
```ts
interface AgentRateLimitWindow {
  id: string;                 // "five_hour" | "seven_day" | "primary" | "secondary" | 其它原样
  label: string;              // 中文，如「5 小时」「7 天」「每周」
  usedPercent: number;        // 0–100
  resetsAt?: number;          // ms
}
interface AgentRateLimits {
  windows: AgentRateLimitWindow[];
  status?: "allowed" | "warning" | "rejected";
  updatedAt: number;          // ms
}
```
- 新事件 `{ type: "rate_limits_updated"; rateLimits: AgentRateLimits }`（`AgentStreamEvent`，照常分配 seq 并落盘）；AgentManager 收到后写入快照新字段 `AgentSnapshot.rateLimits?: AgentRateLimits`（随 meta 持久化）并推 `agent.state`。不计入 usage。
- Claude：stream-json 的 `rate_limit_event`（`rate_limit_info`）：有 `unifiedWindows` 时取其中每个窗口（`five_hour`→「5 小时」、`seven_day`→「7 天」、其它窗口原名），`usedPercent = utilization × 100`，`resetsAt` 秒转毫秒；没有 `unifiedWindows` 时用顶层 `rateLimitType` + `utilization` + `resetsAt` 构成单个窗口。`status`：`allowed`→allowed、`allowed_warning`→warning、`rejected`→rejected。子代理 sidechain 中的同类事件同样处理（额度是账户级）。
- Codex：会话进程初始化后调用一次 `account/rateLimits/read`，之后处理通知 `account/rateLimits/updated`；`primary` / `secondary` 窗口按 `windowDurationMins` 命名（300→「5 小时」、10080→「每周」、其它按分钟 / 小时 / 天格式化），`usedPercent` 原样，`resetsAt` 为 **Unix 时间戳（秒）**（schema `RateLimitWindow.resetsAt: number | null` 无注释，按 Codex 上游约定与现有 `buildCodexRateLimitSection` / `formatResetsIn` 处理一致；兜底：> 1e12 视为已是毫秒），乘 1000 转毫秒；`account/rateLimits/updated` 是**稀疏滚动更新**（null 窗口不清除已知值），所以与上一份按窗口 id 合并，`limitId` 与已知主限额不同的更新忽略；会话订阅前读到的额度在订阅时补发（`createSession` 返回前尚无订阅者）；`rateLimitReachedType` 非空时 `status: "rejected"`，任一窗口 ≥ 80% 时 `warning`，否则 `allowed`。读取失败只记 debug。
- ACP：不提供。

**前端**：额度**不放进上下文窗口弹层**，显示在 4.29 状态行「步骤」之后的「额度」芯片：
- 芯片文字为各窗口的简写与已用比例，如「额度 5h 3% · 7d 96%」（窗口简写：5 小时→5h、7 天 / 每周→7d / 周，其它取 label）；任一窗口 ≥ 80% 用警告色，`status: "rejected"` 用危险色并显示「额度已用尽」。
- 点击展开弹层（同状态行其它弹层样式）：每个窗口一行——标签、细进度条、「已用 N%」、「HH:mm 重置」（不在今天则「M月D日 HH:mm 重置」），底部「更新于 HH:mm」。颜色全部取 token。
- 快照没有 `rateLimits` 时隐藏。额度为账户级：每个会话显示自己快照中最近收到的值。

**输出速度（tok/s）**：
- `AgentUsage` 增加 `outputTokensPerSecond?: number`：**纯生成速度**，口径对齐 cc-switch（`src/components/usage/format.ts` 的 `isSpeedEligible` / `getAggregateTokensPerSecond`）。按**单次模型响应**记账：一次响应的生成时长 = 从首个输出（任意类型：思考块、文字、工具参数）到达，到该响应结束；首 token 等待、工具执行、审批等待都不计入。只有**输出 ≥ 100 token 且生成时长 ≥ 100 ms** 的响应才算「合格」（排除工具调用这类短响应与中转站缓冲后一次性吐出的突发）；本回合速度 = Σ合格响应的输出 token ÷ Σ合格响应的生成时长（不是逐条平均），没有合格响应时不给值。三个 provider 共用 `providers/shared/output-speed.ts` 的 `OutputSpeedTracker`：`markOutput()` 开段（段内重复调用无效）、`markIdle()` 闭段（同一响应可被审批等切成多段，时长累加），`endResponse(outputTokens)` 结束一次响应并按门槛决定是否计入合格累计；`observe(event)` 在各自的事件出口（`emit`）收到 `permission_requested` 时自动闭段。回合中的实时值 = 合格累计 + 进行中的响应（它已达门槛时才计入）。开段 / 闭段 / 结束响应的事件各 provider 不同，见下。随 `usage_updated`（回合中，最多每秒一次）与 `turn_completed.usage`（最终值）下发，快照 `lastUsage` 浅合并后保留到下一回合更新为止；不计入 `totalUsage`。`turn_completed.usage` 另带 `speedOutputTokens` / `speedGenerationMs`（本回合合格响应的输出 token 与生成时长之和，毫秒取整；没有合格响应时缺省），由 `OutputSpeedTracker.finalUsage()` 与最终速度一并给出，供 4.20 账本记录与用量页 Σ/Σ 汇总；同样不计入 `totalUsage`。前端时间线每个回合的统计行直接显示该回合 `turn_completed.usage.outputTokensPerSecond`（写入消息元数据 `metadata.usage.outputTokensPerSecond`），没有则不显示速度，不再用回合总耗时估算。所有 tok/s 显示（速度芯片、时间线、用量页）统一 ≥1 取整、不足 1 保留 1 位小数。与 cc-switch 的剩余差异：测量点是 CLI 输出管道而非网络层 SSE；只统计主线程，不含子代理与 CLI 旁路请求。
- Claude：主线程（不含子代理 sidechain）的流式事件驱动计时：`message_start`、`content_block_start` 与任何 `content_block_delta`（文字 / 思考 / 签名 / 工具参数等全部类型）开段（以 `message_start` 为起点，与 cc-switch 的首个非元数据 SSE 事件一致），`message_stop` 以该消息的 `message_delta.usage.output_tokens`（消息内累计，含隐藏思考与工具参数）结束响应，并下发一次只带 `outputTokensPerSecond` 的 `usage_updated`（节流每秒最多一次）。result 时若仍有未结束的响应（如中断）先以当前累计结束它，再给最终速度，不使用 result 自带的 `usage.outputTokens`。依赖 CLI 始终带 `--include-partial-messages`。
- Codex：assistant_message / reasoning 时间线项、`item/started` 的 reasoning / agentMessage 项以及各类输出 delta 通知（agentMessage / reasoning 摘要 / 正文 delta）开段；`thread/tokenUsage/updated`（每次采样结束发一次）结束一次响应，该响应的输出 token = 本回合输出 token（与 5.3 的本轮合计同口径）相对上次结束时的增量；回合结束时把剩余增量作为最后一次响应结束。只在回合结束才有用量时整回合按一次响应算。
- ACP：agent_message_chunk / agent_thought_chunk 开段；新的 `tool_call` 通知到达闭段；协议只有回合级用量，整回合按一次响应算：回合结束时以 `PromptResponse.usage` 的输出 token 结束响应并给最终值（没有 usage 则不给）。

### 4.31 远程网关（安卓 App 接入）

> 状态：sidecar 侧与桌面设置页已实现（M1）；手机端见 `docs/mobile.md`（M2 起）。实现位置：`packages/remote`（帧 / offer / 客户端握手，sidecar 与手机共用）、`packages/sidecar/src/remote/`（store / pairing / addresses / gateway / service / attention）。握手与加密参照 paseo `packages/relay/src/{crypto,encrypted-channel}.ts`（tweetnacl box），在其基础上增加一次性配对密钥、设备凭据、服务端挑战与递增计数 nonce（防重放）。

**原则**：原有 `127.0.0.1` 的 `/rpc`、`/mcp` 不变、不对外；手机走另起的远程监听，默认关闭。v1 只支持局域网与 Tailscale 直连，不做 relay 中转、不做 FCM 推送。

**设置**（4.24 的 `SidecarSettings` 增加，经 `settings.get` / `settings.set` 读写）：
```ts
remote: {
  enabled: boolean /* 默认 false */;
  port: number /* 默认 47631，1024–65535 */;
}
```
- `enabled` 由 false 变 true 时在 `0.0.0.0:<port>` 起独立 HTTP 服务，只接受 `GET /remote` 的 WS 升级，其余路径 404，不提供 `/health`；变 false 时关闭监听并断开所有远程连接；`port` 变化时在新端口重启。端口被占用（或无权限）时不影响 sidecar 本身，`remote.status.error` 给出中文原因，`listening: false`；之后再 `settings.set`（换端口或重新启用）会重试。
- `settings.set` 在网关启停完成后才返回，因此紧随其后的 `remote.status` 反映最终结果。与网关无关的设置变化不会重启网关。
- 未设置数据目录（`AGENTDECK_DATA_DIR`）时不能启用：设置仍可写入（只在内存），但网关不启动，`remote.status.error` 提示。
- 首次监听时 Windows 防火墙会对 node.exe 弹窗，前端设置页提示用户允许「专用网络」。
- **网络类别检测**（真机测试发现：有线网卡被 Windows 标为「公用」时，即使在弹窗里允许了专用网络，手机仍被防火墙挡住）：Rust 命令 `network_categories` → `Array<{ address: string; interfaceAlias: string; category: "public" | "private" | "domain" | "unknown" }>`。Windows 上用 PowerShell 的 `Get-NetIPAddress -AddressFamily IPv4` 与 `Get-NetConnectionProfile` 按 `InterfaceAlias` 关联（无需管理员权限，`CREATE_NO_WINDOW`，超时 5 秒，失败返回空数组）；其它平台返回空数组。「手机连接」页对 `remote.status.addresses` 中所在网卡为 `public` 的地址标红并提示：「该网络被 Windows 标为『公用』，防火墙会阻止手机连接。请在 设置 → 网络和 Internet → 该网络 中改为『专用网络』」。

**存储**（`<AGENTDECK_DATA_DIR>/remote/`，原子写入；未设置数据目录时远程网关不可启用）：
- `daemon-keypair.json`：`{ publicKey, secretKey }`（`nacl.box.keyPair()`，base64），首次启用时生成，之后不变（换钥匙 = 所有设备需重新配对）。
- `devices.json`：`RemoteDevice[]`，凭据只存哈希。吊销不删除条目而是写入 `revokedAt`（墓碑），使之后用原凭据认证能回 `revoked`；`RemoteStatus.devices` 不含已吊销设备。`lastSeenAt` 在认证成功与连接断开时更新。
```ts
interface RemoteDevice { deviceId: string; name: string; pairedAt: number; lastSeenAt?: number; secretSha256: string /* 不出 sidecar */; revokedAt?: number }
```

**配对二维码**：`remote.pairing.create {}` → `{ offerUrl, expiresAt }`，`offerUrl = "agentdeck://pair#" + base64url(JSON(offer))`：
```ts
interface RemoteConnectionOffer {
  v: 1;
  name: string;                       // 电脑主机名，手机里作为默认名称
  daemonPublicKey: string;            // base64
  addresses: Array<{ host: string; port: number; kind: "lan" | "tailscale" }>;
  pairingSecret: string;              // 32 字节随机 base64url，一次性
  expiresAt: number;                  // ms，签发后 5 分钟
}
```
- `addresses` 取 `os.networkInterfaces()` 中非内部的 IPv4：`100.64.0.0/10` 记为 `tailscale`，其余私网段（10/8、172.16/12、192.168/16）记为 `lan`，其它地址不列出。
- 同一时刻只有一个有效 pairingSecret，新签发即作废旧的；使用一次或过期即失效。二维码由桌面前端渲染，sidecar 只给字符串。
- 配对失败的 `reason`：当前这把密钥已超过 `expiresAt` → `expired`；密钥已被使用、被新签发作废或从未签发 → `invalid`。sidecar 只保存 pairingSecret 的哈希。
- 没有任何可用地址（`addresses` 为空）时 `remote.pairing.create` 返回 `NOT_SUPPORTED`（二维码无法连接）。

**握手**（每个 WS 连接）：
1. 客户端明文文本帧：`{ "type": "e2ee_hello", "v": 1, "clientKey": <每次连接新生成的 nacl.box 公钥 base64> }`。
2. 服务端明文文本帧：`{ "type": "e2ee_ready", "v": 1, "challenge": <32 字节随机 base64> }`。双方 `shared = nacl.box.before(对方公钥, 己方私钥)`（服务端用 daemon 长期私钥）。
3. 此后**只允许二进制帧**，每帧 = `nonce(24) || nacl.box.after(明文 UTF-8, nonce, shared)`。nonce 第 0 字节为方向（`0x01` 客户端→服务端、`0x02` 服务端→客户端），第 16–23 字节为该方向从 1 开始的大端 64 位计数，其余为 0；接收方要求计数严格递增，否则立即断开。解密失败、出现文本帧、单帧明文超过 16 MiB 一律断开。**下行**明文超过 16 MiB 时（如 `agent.timeline` 一页过大）网关不再静默丢弃：写 `warn`（device、字节数、JSON-RPC method / id），带 `id` 的响应改发同 id 的 `{ code: -32000, data: { code: "RESPONSE_TOO_LARGE" } }` 错误（message 中文），手机端那条请求立即失败而不是等 120 秒超时；无 `id` 的通知只记日志，连接不受影响。
4. 客户端第一条加密消息必须是以下之一（10 秒内未完成认证则断开）：
   - 配对：`{ "type": "pair", "pairingSecret", "challenge", "deviceName" }` → 成功回 `{ "type": "paired", "deviceId", "deviceSecret" }`（`deviceSecret` 32 字节随机 base64，只在此时出现一次）。
   - 认证：`{ "type": "auth", "deviceId", "deviceSecret", "challenge" }` → 成功回 `{ "type": "authed", "name" }`。
   - `challenge` 必须等于本连接第 2 步下发的值（防止重放旧连接录下的帧）；失败回 `{ "type": "auth_failed", "reason": "expired" | "invalid" | "revoked" }` 后断开。`challenge` 不符、凭据错误、设备不存在、第一条消息格式非法都按 `invalid` 计；已吊销设备凭据正确时回 `revoked`（凭据错误仍是 `invalid`，不泄露设备状态）。
   - 连续 5 次认证失败的来源 IP 冷却 60 秒：冷却期内该 IP 的升级请求直接以 HTTP 429 拒绝；认证成功清零计数。10 秒认证超时、协议违规不计入失败次数。
   - 违规断开统一用 WS close code 1008（文本帧、解密失败、计数回退、认证超时等）。另有两项资源保护：未完成认证的连接最多 32 个（超出 HTTP 503），网关每 30 秒对每个连接做 WS ping，**连续 2 次没收到 pong** 才终止连接（单次丢失不算，手机主线程繁忙时可能晚回；收到 pong 计数清零），终止时写一条 `warn`（device 前 8 位、ip、存活秒数、距上次 pong 毫秒）。
5. 认证后，每条加密消息是一个 JSON-RPC 2.0 对象，语义与 `/rpc` 完全一致（同样收到全部广播通知），外加只发给远程客户端的 `client.attention`。

**远程客户端的限制**：以下方法对远程客户端一律返回 `-32601`（方法不存在）：`remote.*`、`settings.set`（防止手机改网关设置或管理配对）、`provider.config.get` / `provider.config.set`（自定义 provider 配置含明文 `apiKey` / `env` 里的密钥，不得交给手机）。其余方法照常；持有已配对设备等同于信任其能驱动 Agent 执行命令，因此 `agent.*`、`snapshot.*`、`schedule.*` 等不再细分。已逐项审查 4.1 方法表，除上述外没有方法返回密钥、token 或本机敏感配置：`settings.get` 只含快照 / 互通 / 网关开关，`provider.list` 只含 id / 可用性 / 启动命令，`provider.test` 只接受调用方自带的 profile 且不回显密钥，`agent.status` 仅含账户邮箱 / 订阅类型等非凭据信息。`remote.devices.revoke` 立即断开该设备的所有连接。

**内部结构**：`RpcServer` 把客户端抽象为 `RpcClientConnection { kind: "local" | "remote"; deviceId?; send(text); close() }`，本机 `/rpc` 的 WS 与认证后的远程连接走同一套 `attachConnection`（调度、校验、广播完全一致）；加解密只在网关的 `RemoteConnection` 里。`remote.changed` 只广播给 `kind: "local"` 的连接，`client.attention` 只发给 `kind: "remote"` 的连接。日志层对 `deviceSecret` / `pairingSecret` 取值与 `agentdeck://pair#…` 链接统一脱敏。

**RPC（只限本机 `/rpc`）**：
```ts
interface RemoteStatus {
  enabled: boolean; port: number; listening: boolean; error?: string;
  addresses: RemoteConnectionOffer["addresses"];
  devices: Array<Omit<RemoteDevice, "secretSha256"> & { connected: boolean }>;
}
```
- `remote.status {}` → `RemoteStatus`；`remote.pairing.create {}` → `{ offerUrl, expiresAt }`（网关未监听时 `NOT_SUPPORTED`）；`remote.devices.revoke { deviceId }` → `{}`。
- 通知 `remote.changed`（载荷 `RemoteStatus`）：启停、配对成功、吊销、设备连接 / 断开时广播给本机客户端。

**时间线向前分页**（`agent.timeline` 扩展，兼容旧调用）：
- 只给 `sinceSeq` 或什么都不给：行为不变（不带 `hasOlder`）。
- 给 `limit`（1–2000）时为向前分页：从 `beforeSeq`（缺省为末尾之后）往前取至少 `limit` 条，再继续往前扩到最近的**回合起点**（`user_message`；某回合没有 `user_message` 时取其 `turn_started`），使页首尽量是完整回合；为凑完整回合的回溯有**硬上限**：整页条数不超过 `limit` 的 2 倍，且累计序列化字节不超过 4 MiB（`TIMELINE_PAGE_MAX_BYTES`，远小于网关 16 MiB 的单帧上限；基础的最近 `limit` 条也受字节上限约束，但至少返回最近一条以保证分页能前进）。超出上限时从回合中间截断（页首不是回合起点），`hasOlder` 仍为 true，客户端照常用 `beforeSeq` 继续向前翻；返回 `hasOlder` 表示更早还有条目。`sinceSeq` 与 `beforeSeq` / `limit` 同时给出为 `-32602`。
- `beforeSeq`（≥ 1）必须与 `limit` 一起给；单独给 `beforeSeq`、`limit` 越界（非 1–2000 的整数）同样是 `-32602`。回合起点按时间线上的 `user_message`（非插话）判定，其后紧跟的同回合 `turn_started` 不再单独算起点；CLI 自发轮次等没有 `user_message` 的回合以 `turn_started` 为起点。一个回合比 `limit` 长但不超过上限时整回合返回；更长则按上述上限从回合中间截断，被截开的回合在前端由相邻两页合并显示（同一回合的助手消息 id 相同，older 页的内容并到已有消息之前）。
- 手机打开会话取 `{ limit: 300 }`，向上滚动到顶取 `{ beforeSeq: 当前最早 seq, limit: 300 }`；断线重连仍用 `sinceSeq` 补齐。

**审批卡片与快照补齐**（桌面 / 手机共用，`web/src/stores/chat.ts` 的 `syncPendingApprovals`）：
- 待审批卡片（`runtime.pendingApprovals`）原本只来自时间线里的 `permission_requested`；手机首屏只拉最近一页时间线，`permission_requested` 被分页截断时，会话列表（读快照）显示待审批、进入会话却没有卡片。
- 因此用快照（`agent.state` / `agent.list` 的 `AgentSnapshot.pendingPermissions`）校准：快照有、运行时没有、且不在「已处理」名单的，按 `permission_requested` 的格式补进去；快照已不存在的（快照 `lastSeq` ≥ 已归约事件序号，即快照不比事件旧）移除，快照更旧时只补不删。「已处理」名单（`resolvedApprovalIds`，最近 50 条）由 `permission_resolved` 与本地回应（`removeApprovalAtom`）写入，防止过期快照把刚处理的审批补回来。触发点：收到 `agent.state` / `agent.list`、`loadTimeline` 完成后；`dormant` / `closed` 会话不处理。
- **超大审批内容截断**（`packages/sidecar/src/agent/permission-limits.ts`，AgentManager 在处理 provider 事件时应用）：远程网关对下行帧有 16 MiB 上限，超限的 `agent.stream` 通知会被丢弃（`gateway.ts`），一条带超大 `input` / `detail`（大文件 Write、超长命令等）的 `permission_requested` 因此可能永远发不到手机。为保证审批事件本身一定能下发：`permission_requested` 的 `input` / `detail` / `title` / `description` 里任意深度的字符串，单字段超过 256 KB（`PERMISSION_FIELD_MAX_BYTES`，UTF-8 字节，不截开多字节字符）时截到上限并追加「…已截断 N 字节」（N 为被去掉的字节数）；整条请求所有字符串合计另有 2 MiB 预算（`PERMISSION_TOTAL_MAX_BYTES`，用尽后每个字段至少保留 1 KB），防止大量中等字段累加。截断发生在写入快照 / 广播 / 落盘（时间线）之前，因此本机 `/rpc` 与远程客户端看到的一样（不只影响远程）；provider 自己持有的原始 input 不受影响。**`updatedInput` 的流向**：UI 应答 allow 时可带 `updatedInput`（目前只有提问卡会带，形如 `{ ...request.input, answers }`，而 `request.input` 是截断后的）；AgentManager 记下被截断的 input 顶层字段（发出值 + 原始值，只保留仍挂起的请求），应答时若 `updatedInput` 里这些字段仍等于当初发出的截断值（用户没改），就换回原始值再交给 provider，因此不会把「…已截断」当成真实输入回传；用户确实改过的字段保持其值。provider 随后发出的 `permission_resolved` 里若带有超大的 `updatedInput`，同样先截断再广播 / 落盘。
- **Mock 审批场景**（`AGENTDECK_ENABLE_MOCK=1` 时的 mock provider，prompt 含对应关键字触发，供桌面 / 真机验证审批 UI）：`/approve` 单条工具审批（原有）；`/question` 发 `kind: "question"`（`AskUserQuestion`，`detail` 与 Claude 映射后一致：两题，「用哪个日期库？」单选且每个选项带 `preview`、「启用哪些功能？」多选，界面会再追加「其他」），actions 为 submit / skip；`/plan` 发 `kind: "plan"`（`ExitPlanMode`，`detail.text` 为含标题、列表、引用、代码块的 Markdown 计划），actions 为 approve / keep_planning；`/multi` 同时挂起 2 条工具审批（`运行命令（1/2）`、`（2/2）`），用于验证「还有 N 条待处理」。应答后 mock 把收到的内容作为助手回复回显：提问为「Mock 收到的回答：」+ 每题一行 `问题 → 答案`（跳过为「Mock 收到：跳过了问题（…）」），计划为「计划已批准」或「继续规划，意见：…」，`/multi` 逐条列出允许 / 拒绝及理由。`/approve` 拒绝时理由出现在工具卡片的错误里。
- **Mock 表单 / 始终允许 / 文本提问场景**（4.31 / 4.32 / 4.33 的界面验证入口，同样靠 prompt 关键字触发）：
  - `/elicit`：`kind: "elicitation"` 的 form 模式（`mock-forms`），字段依次为 string 必填（`name`，最短 2）、select 单选（`level`，3 项，默认「中」，界面渲染为单选组）、boolean（`enabled`，默认 true）、number 带范围（`ratio`，0 到 10）、multiselect（`tags`，最多选 2 项）；actions 为 `submit` / `decline` / `cancel`。应答后回显「Mock 收到的表单内容：」+ 每字段一行 `key → JSON 值`；拒绝回显「Mock 收到：拒绝」，取消（deny + `interrupt`）回显取消并中断回合。`permission_resolved` 不带表单内容。
  - `/elicit-url`：url 模式（`mock-oauth`，链接 `https://example.com/mock-auth`），actions 为 `done`「已完成」/ `decline` / `cancel`，完成后回显「Mock 收到：浏览器流程已完成」。
  - `/always`：一条 `shell` 工具审批（`git status`），actions 为 `allow`「允许一次」/ `deny` / `allow_session`「本会话始终允许」（`persist: "session"`）/ `allow_project`「永久允许」（`persist: "permanent"`），回显「Mock 收到的动作：<selectedActionId>（<标签>，允许 / 拒绝）」。`/always-deny` 同上但带 `defaultDeny: true`，用于验证「拒绝」排在首位的版式。
  - `/textq`：`kind: "question"`，三题：纯文本题（`freeText`，「项目叫什么？」）、遮罩纯文本题（`isSecret`，「API Key 是什么？」）、不允许「其他」的单选（`isOther: false`，「选哪个环境？」）；回显格式同 `/question`，但遮罩题只回显「（已收到，N 个字符）」，不回显内容。
  - 注意 `/elicit-url` 含 `/elicit`、`/always-deny` 含 `/always`，mock 按带后缀的优先匹配。
- 同一会话有多条待审批时按到达顺序逐条显示（`pendingApprovals[0]`，卡片 key 为 requestId，处理完自动显示下一条），卡片上显示「还有 N 条待处理」（N = 其余条数，≥1 时）。

**断线诊断**（事故背景：真机「总在重连」，但网关与手机都没有留下断线原因）：
- **网关关闭日志**（`sidecar.log`，info）：每条远程 WS 关闭时统一写一行
  `远程连接关闭 device=<deviceId 前 8 位，未认证为 -> ip=<ip> 存活=<s>s code=<code> reason=<reason> by=<local|peer> path=<path> 距上次pong=<ms>ms buffered=<n>`。
  `by=local` 表示本端先关闭 / 终止，`path` 说明走的哪条路径：`auth-timeout`（10 秒未认证）、`auth-failed`、`bad-hello`（握手格式 / 公钥非法）、`binary-in-hello`（首帧是二进制）、`bad-frame`（握手后的文本帧、解密失败、计数回退、认证期间多余帧）、`internal-error`、`pong-timeout`（连续 2 次 ping 无 pong）、`buffer-overflow`（发送缓冲超 64 MiB）、`revoked`（吊销设备）、`gateway-stop`（网关停止 / 端口变更）、`shutdown`（RpcServer 关闭）；`by=peer` 时 `path=peer-close`（对端先关闭或网络层断开）。`距上次pong` 以连接建立时刻为起点。`rpc-server` 的「远程客户端已连接 / 已断开」日志同样带 `device=<前 8 位>`。
- **sidecar 运行标记** `<AGENTDECK_LOG_DIR>/sidecar.running`（未配置日志目录时不写）：启动时写入 `{ pid, startedAt }`；进程自己退出（含 fatal 与 `process.exit`，即触发 `exit` 事件的所有退出，见 4.18）时同步删除。启动时若发现残留，`warn`「上次 sidecar（pid=…，启动于 …）未正常退出（被外部结束或进程级崩溃）」后覆盖。退出码本身由 4.18 的「进程退出事件」日志与 Rust 的 `desktop.log`（3.6）记录，不重复。
- **手机连接事件缓冲**（`web/src/lib/connection-log.ts`，只在手机入口注入，桌面不写）：环形缓冲最多 100 条，持久化到 `localStorage`（键 `agentdeck.mobile.connection-log`，事件后 1 秒合并写一次，页面隐藏时立即写）。每条记录：ISO 时间 `at`、`event`、触发路径 `trigger`、`gapMs`、关闭的 `code` / `reason` / `wasClean`、`aliveMs`（本连接存活）、`idleMs`（距最后入站帧）、`online` / `netType` / `effectiveType`（`navigator.onLine` 与 Network Information，有则记）、`foreground`（`isBackground` 回调）。`event` 取值：`open`、`close`、`error`、`force-reconnect`、`probe-start`、`probe-ok`、`probe-timeout`、`schedule-reconnect`、`connect-timeout`、`manual-close`、`wake-ignored`（CONNECTING 时忽略非强制唤醒）、`sync-fail`（重连后某个会话按 `sinceSeq` 补齐失败，只记录并继续其它会话，随后照常刷新 `agent.list`），以及 E2eeSocket 的 `attempt-ok` / `attempt-fail`（每个地址的结果与耗时）、`protocol-error`（赢家连接的协议错误）。`trigger` 取值：`gap-watchdog`（附 `gapMs`）、`hint`、`online`、`visibility`、`network-change`、`system-resume`、`probe`、`manual` 等。
- **设置页「连接诊断」**（手机端设置页，通知 / 后台运行小节之后）：显示最近 20 条（时间 + 事件 + 触发路径 + code，最新在上），「复制全部」把缓冲区全部条目的 JSON 写入剪贴板（`navigator.clipboard` 失败则展示可全选的文本框兜底），「清空」同时清掉持久化。

**通知（attention）**：
- sidecar 在以下事件发生时向**所有已认证的远程连接**发 `client.attention`，不做任何「用户是否在电脑前」的判断：主时间线 `turn_completed` / `turn_failed`（CLI 自发轮次 = `turn_started.origin` 为 `background` 的回合，与 `origin` 为 `judge` 的会话除外）、`permission_requested`、`schedule.notice`。另外在 `permission_resolved`（审批在桌面 / 另一台手机处理、被取消或超时）时发一条 `kind: "resolved"` 的**撤回信号**（同样不发 judge 会话与已删除会话），不弹通知，只用来取消手机上对应的系统通知与应用内提示条。
- 是否提醒完全由手机端决定（见下文手机端处理与 `docs/mobile.md`）。
- 改动背景：v1 原设计用 `client.presence` 上报桌面窗口可见性，「桌面可见则不发」。真机测试发现 WebView2 在最小化、隐藏到托盘后 `document.visibilityState` 仍为 `visible`，手机永远收不到通知；且「人在不在电脑前」本身难以可靠判断。按用户决定（2026-10-14）删除 `client.presence` 与在线判定，改为手机端三档设置。
- 摘要文本（`body`）：完成 = 「本轮已完成」；失败 = 「本轮失败：」+ 错误信息；审批 = 「Agent 请求审批：」+ 请求标题（`question` / `plan` / `mode` / `elicitation` 类用固定句式，elicitation 见 4.32）；调度 = `schedule.notice.message`。全部压成单行并截断到 120 字，只引用标题 / 错误 / 工具名，不含工具输入输出原文。`title` 取会话标题（缺省取首条消息预览，再缺省「未命名会话」）或调度名。
```ts
interface AttentionNotice {
  id: string;                                   // 去重用
  kind: "finished" | "failed" | "permission" | "schedule" | "resolved";
  agentId?: string;
  requestId?: string;                           // permission / resolved：审批请求 id
  permissionKind?: "tool" | "plan" | "question" | "mode" | "elicitation" | "other"; // permission：审批类型（= AgentPermissionRequest.kind）
  title: string;                                // 会话标题或调度名
  body: string;                                 // 中文摘要，≤ 120 字（不含工具输出原文）；resolved 固定为「审批已处理」
  timestamp: number;
}
```
- **撤回（resolved）**：沿用同一个通知方法 `client.attention`，`kind: "resolved"` 带 `agentId` + `requestId`。手机收到后：（1）调用原生 `cancel_attention` 取消系统通知——系统通知 id 对审批类按 `agentId:requestId` 计算（`notificationIdFor`），permission 通知与撤回信号（各有自己的 `AttentionNotice.id`）因此指向同一条；完成 / 失败 / 调度仍按 `AttentionNotice.id`；（2）若应用内提示条正显示同一条审批（`kind: "permission"` 且 agentId / requestId 相同）则关掉。撤回不受「通知」档位与前后台影响；撤回先于异步发出的通知到达时，该通知不再发出。
- **提示文案按 `permissionKind`**：提示条与会话列表角标——`question` 显示「待回答」，`plan` 显示「待确认计划」，`elicitation` 显示「待填写」，其余（`tool` / `mode` / `other` 或缺省）显示「待审批」。会话列表读快照 `pendingPermissions[0].kind`。
- 手机收到后按手机端设置「通知」（存手机本地，默认「总是通知」）处理：
  | 设置 | App 在后台 | App 在前台 |
  |---|---|---|
  | 总是通知（`always`，默认） | Android 本地通知，点击跳转到对应会话 | 停在该会话 → 忽略；其它页面 → 应用内提示条 |
  | 仅在前台时（`foreground`） | 不通知 | 同上 |
  | 从不通知（`never`） | 不通知 | 不提示 |
- 桌面端现有通知逻辑不变。

**桌面前端（设置页「手机连接」，路径 `/remote`，侧栏「设置」下）**：
- 内容：启用开关与端口（1024–65535）、`remote.status.error`、可用地址列表（局域网 / Tailscale 标签）、「生成配对二维码」（调用 `remote.pairing.create`，用 `qrcode` 把 `offerUrl` 渲染成 SVG，白底黑码不随主题变色，显示 5 分钟倒计时，过期后「重新生成」；有新设备配对成功或网关停止监听时自动收起）、已配对设备（名称、配对时间、最近在线、在线 / 离线、吊销需二次确认）。启用后提示 Windows 防火墙需对 node.exe 允许「专用网络」。
- 实时刷新：`sidecar-client` 的 `onRemoteChanged` 订阅 `remote.changed`，`useSidecarBridge` 把载荷直接写入 `remote.status` 的查询缓存；页面还会在改设置 / 吊销后主动失效重取。
- 调试面板的脱敏规则覆盖 `agentdeck://pair#…` 链接与 `deviceSecret` / `pairingSecret` 字段。

### 4.32 MCP elicitation（表单 / 浏览器流程）

MCP 服务可以通过 Agent 向用户索取结构化输入（form 模式）或要求在浏览器里完成一步操作（url 模式，如 OAuth）。Claude 与 Codex 各有一条通道，AgentDeck 统一成 `kind: "elicitation"` 的审批；ACP 本期不做（SDK 0.17.1 没有对应 handler）。协议证据来自本机 CLI 反查（Claude Code 2.1.299 的 zod schema、Codex 0.162.1 的 `generate-ts` / JSON Schema）。

**协议（`packages/protocol/src/agent-api.ts`）**：
- `AgentPermissionRequest.kind` 增加 `"elicitation"`；`detail` 为 `{ type: "elicitation", serverName, mode: "form" | "url", message, url?, elicitationId?, fields?: ElicitationField[] }`（`ToolCallDetail` 的新成员，只出现在审批请求里）。
- `ElicitationField`：`key`、`title?`、`description?`、`required`、`type: "string" | "number" | "integer" | "boolean" | "select" | "multiselect"`、`options?: { value, label }[]`、`format?`、`min?` / `max?`（number / integer 的 minimum / maximum；multiselect 的 minItems / maxItems）、`minLength?` / `maxLength?`、`default?`、`secret?`。
- `actions`：form 为 `submit`「提交」/ `decline`「拒绝」/ `cancel`「取消」，url 的第一项换成 `done`「已完成」。`input` 为 `{ serverName, mode, message, url?, elicitationId? }`（不含 schema）。
- **应答**（`agent.permission.respond` 的 `AgentPermissionResponse`）：提交 = `{ behavior: "allow", selectedActionId: "submit", updatedInput: { content: {...} } }`；url 的已完成 = `{ behavior: "allow", selectedActionId: "done" }`（不带 content）；拒绝 = `{ behavior: "deny", selectedActionId: "decline" }`；取消 = `{ behavior: "deny", selectedActionId: "cancel", interrupt: true }`。provider 映射：allow → `accept`，deny → `decline`，deny + `interrupt` → `cancel`，且 `cancel` 之后 provider 额外中断本回合（MCP 的 cancel 只让该次调用失败，「取消会中断回合」由 AgentDeck 保证；sidecar 先写出 cancel 应答，下一轮事件循环再发 interrupt）。
- **隐私**：provider 发出的 `permission_resolved` 不带 `updatedInput.content`（表单里可能有密码，该事件会广播并落盘）；`secret` 字段在界面里遮罩显示。

**JSON Schema → fields**（`providers/shared/elicitation-schema.ts` 的 `normalizeElicitationSchema(schema, propertyOrder?)`，Claude 与 Codex 共用）：
- 字段顺序：优先 `property_order`（Claude 给出的 properties 键顺序），其次 `properties` 的键序；`required` 数组决定 `required`；最多 50 个字段、每个字段最多 200 个选项。
- 支持 MCP 2025-11-25 `ElicitRequestFormParams` 的全部原始类型：string（title / description / minLength / maxLength / format email|uri|date|date-time / default）、number / integer（minimum / maximum / default）、boolean（default）、单选（`enum`，可带旧版 `enumNames`；`oneOf: [{const, title}]`）→ `select`、多选（`type: "array"`，`items.enum` 或 `items.anyOf: [{const, title}]`，minItems / maxItems / default）→ `multiselect`；非法的 `default`（不在选项里）丢弃。
- `secret`：`format: "password"`、`writeOnly: true` 或键名含 password / passwd / secret / api_key / token。
- 不认识的类型 / 缺少类型 / 非对象的字段定义 / 选项形状不对的多选：降级为 `string`，并在 `description` 末尾注明（如「（不支持的类型：object，已按文本输入处理）」）。`type` 可为数组（取第一个非 null）。

**Claude**（`claude-cli-session.ts` / `claude-agent.ts`）：
- CLI → 我方 `control_request`，`request.subtype === "elicitation"`：`mcp_server_name`、`message`、`mode?`（缺省按 form）、`url?`、`elicitation_id?`、`requested_schema?`、`property_order?`、`title?` / `display_name?` / `description?`。`ClaudeCliSession` 分流到新的 `onElicitation` 回调（`ClaudeCliOptions.onElicitation`，与 `canUseTool` 同样的 AbortSignal：`control_cancel_request` 与进程退出都会触发）；没有回调或回调抛错时应答 `cancel`。
- 应答：`control_response { subtype: "success", request_id, response: { action: "accept" | "decline" | "cancel", content? } }`——**不拼 `toolUseID`**，decline / cancel 不带 `content`。（原先对非 `can_use_tool` 的控制请求一律回 error，CLI 会把 error 当成 cancel，所有 MCP 表单请求都被取消了。）不需要在 `initialize` 里声明能力。
- provider：`handleElicitation` 变成 `kind: "elicitation"`、`name: mcp:<server>` 的 permission request（title 优先用 CLI 的 `title`，否则「<server> 需要你填写表单 / 在浏览器中完成操作」）；仅在有进行中的回合（或可接管的自发轮次）时处理，否则直接 `cancel`；回合取消 / 会话关闭 / CLI 撤回时挂起的请求回 `cancel` 并发 `permission_resolved`。
- url 模式完成：CLI 往 stdout 发 `{"type":"system","subtype":"elicitation_complete","mcp_server_name","elicitation_id"}`（`system` 在 `OUTPUT_MESSAGE_TYPES` 里，不会被吞）；provider 按 `elicitation_id` 找到挂起的 url 请求，发 `permission_resolved`（`allow` + `selectedActionId: "done"`）并向 CLI 回 `accept`。

**Codex**（`codex-agent.ts` 的 `handleElicitation`）：
- `mcpServer/elicitation/request` 的 params：`threadId`、`turnId`、`serverName` 加 `mode`（`form`：`message` + `requestedSchema`；`url`：`message` + `url` + `elicitationId`）。`openai/*`（`openai/form`、`openaiForm`、`openai/userVerification`）AgentDeck 不声明扩展、不会收到；收到就直接 `decline`，不产生审批。缺 `mode` 时有 `url` 按 url、否则按 form。
- 应答 `{ action, content, _meta }` 三个字段必须齐：accept（form）= `content: <表单内容>`，accept（url）= `content: null`，decline / cancel = `content: null`；`_meta` 一律 `null`。
- **没有任何字段的 form**（如 Codex 对 MCP 工具调用的审批，见 4.26）仍是原来的 `kind: "tool"`「允许 / 拒绝」审批（accept 回 `content: {}`），不变成表单卡片。
- Codex 没有 url 流程的完成通知；url 请求靠用户点「已完成」，或回合结束 / `serverRequest/resolved` 时清理（与其它审批相同）。

**前端**（`web/src/components/chat/elicitation-card.tsx`，在 `approval-dialog.tsx` 的分发里接入）：
- form：按 `fields` 渲染——文本、数字（`inputMode` 数字键盘）、开关（复选框）、单选（选项 ≤4 个用单选组，更多用下拉）、多选（复选框组；设了 `max` 的字段，已选满后未选中的选项禁用、已选的仍可取消，字段标题旁提示「最多选 N 项」）、`secret` 用密码框（`autocomplete="off"`）；`format` 为 email / uri / date 时用对应的 input 类型。基本校验：必填、字符数范围、数值范围（含 integer）、多选数量；点「提交」才显示错误，未通过不发送；选填且为空的字段不放进 `content`，数字以 number 提交。按钮「提交」「拒绝」「取消」（取消的 tooltip 提示会中断本回合）。
- url：显示说明与链接地址，按钮「在浏览器中打开」走 `openExternalUrl`（桌面经 Tauri 打开系统浏览器；手机端经注册的原生打开器调用 `native.open_url`，失败也不退回 `window.open`——Android WebView 会在本页内导航把 App 界面替换掉；手机入口另全局拦截外部 `a[href]` 点击与 `window.open`，见 `lib/external-links.ts`、`mobile/external-links.ts`）；只允许 http / https / mailto / obsidian，其它协议提示并禁用。按钮「已完成」「拒绝」「取消」。
- 样式用 CSS Modules + tokens，窄屏 / 触屏下输入框与选项行 ≥44px、按钮换行铺开。
- 标签与通知：`web/src/lib/permission-label.ts` 里 `elicitation` →「待填写」/「等待填写」；`client.attention` 摘要（4.31）form =「Agent 需要你填写表单：<serverName>」，url =「Agent 需要你在浏览器中完成操作：<serverName>」，只引用服务名，不含表单内容。
- 超大内容：`permission-limits`（4.31）对 `detail` 里的字符串同样生效（`message` / 字段说明 / 选项文本超限会截断，字段与选项个数已被归一化函数限制在 50 / 200）。

### 4.33 Codex request_user_input（提问）

Codex 的 `request_user_input` 工具向用户提问时，app-server 发 server→client 请求 `item/tool/requestUserInput`（实验 API，证据：codex-cli 0.162.1 的 `generate-ts --experimental`）。此前 AgentDeck 没注册这个方法，传输层回 `-32601`；现在注册并映射成与 Claude AskUserQuestion 相同的 `kind: "question"` 审批，复用提问卡片（4.13）。**只接住请求，不打开 `default_mode_request_user_input` 实验特性，也不传 `collaborationMode`**（是否会收到请求由用户的 Codex 配置决定）。

- params：`{ threadId, turnId, itemId, isBlocking, autoResolutionMs, questions: [{ id, header, question, isOther, isSecret, options: [{label, description}] | null }] }`。
- 映射（`codex-agent.ts` 的 `handleUserInput`）：`kind: "question"`、`name: "request_user_input"`、title「Codex 有问题需要你回答」、`detail: { type: "question", questions }`、actions 与 Claude 相同（`submit`「提交回答」/ `skip`「跳过」）。每题：`header` → `header`，`question` → `question`，`options` → `options`（label / description），`multiSelect` 恒为 false，`isOther` 原样透传，`isSecret` 为 true 时带 `isSecret`，`options: null` → `freeText: true` 且 `options: []`。
- 协议新增（`AgentQuestion`，均可选）：`isOther?`（缺省 = 允许「其他」，Claude 的题目不带该字段，行为不变；Codex 为 false 时界面不显示「其他」）、`isSecret?`（遮罩「其他」输入与纯文本输入）、`freeText?`（纯文本题：不渲染选项，只有一个必填输入框；`options` 为空数组时也按纯文本题处理）。
- 应答：`{ answers: { [questionId]: { answers: string[] } } }`。答案键沿用提问卡片的约定（题目文本 → 字符串）；provider 在挂起记录里保留「题目文本 → id」的映射（题目文本重复时第二个起加 ` (2)` 区分），回填时只包含已作答的题。
- **跳过 / 拒绝**：schema 里 `ToolRequestUserInputResponse` 只有 `answers`，没有拒绝语义，因此跳过（deny）、回合结束、`serverRequest/resolved` 撤销、会话关闭一律回空的 `{ answers: {} }`，而不是 JSON-RPC 错误（Codex 对错误同样按无回答处理，但会额外记录失败；空答案让工具得到干净的空结果）。这一点依赖 Codex 实际对空答案的处理，见报告里的真机验证项。
- **隐私**：provider 发出的 `permission_resolved` 不带 `updatedInput`（回答可能含密钥，该事件会广播并落盘）。
- 清理：`serverRequest/resolved` 通知已映射成 `permission_resolved`（所有 server→client 审批共用，包括 elicitation 与本请求）。
- Mock 场景 `/textq`（纯文本题 + secret 题，见 4.31「Mock 审批场景」）可在没有 Codex 的情况下验证界面。

### 4.34 空闲会话回收（结束 CLI / app-server 进程）

已加载的会话各自常驻一个 provider 进程（Claude Code CLI、每会话一个 Codex app-server、ACP 子进程）。回收 = 走 `closeAgent(agent, "dormant")`：provider `session.close()` tree-kill 进程树，快照转为 `dormant`（界面「未加载」），时间线、persistence 句柄保留；下次 `agent.send` 按 4.5 自动恢复（`--resume` / `thread/resume` / ACP `session/load`）。与 `agent.close` 的区别只在最终状态（`dormant` 而非 `closed`）。

**手动**：RPC `agent.reclaim { agentId }` → `{ agent: AgentSnapshot }`。
- 会话未加载（`session === null` 且不在恢复中，即已是 dormant / closed）→ 不做事，直接返回当前快照。
- 有进行中的回合（`status` 为 `running` / `starting`、`activeTurnId` 非空、发送 / 恢复进行中）→ `TURN_IN_PROGRESS`。
- `resumable === false` → `NOT_SUPPORTED`（message「该会话不支持恢复，回收后将无法继续对话」）。
- 有运行中的子代理 / 后台任务（`backgroundActive`）允许回收（它们随进程结束），由前端先确认。
- 会话右键菜单「回收后台进程」：仅已加载的会话（status 为 `idle` / `error` / `running` / `starting`）显示；`running` / `starting` 或 `resumable === false` 时禁用；`backgroundActive` 时先弹确认（「该会话有运行中的子代理或后台任务，回收会将其结束」）；失败用应用内提示框反馈。

**自动**：`SidecarSettings.idleReclaim = { enabled: boolean /* 默认 true */; idleMinutes: number /* 默认 15，整数 1–1440 */ }`（4.24 的设置文件，`settings.set` 校验同其它字段）。AgentManager 每 60 秒扫一次（定时器 `unref`，`shutdown` 时清除；设置变化在下一次扫描生效），满足以下**全部**条件的会话回收：
- 已加载：`session !== null`，且不在关闭 / 恢复 / 发送中，未被删除；
- `status` 为 `idle` 或 `error`，`activeTurnId` 为空，`pendingPermissions` 为空，`backgroundActive` 不为 true；
- `resumable === true`；未置顶（`pinned !== true`，置顶会话只能手动回收）；
- 不是「开启缓存保活且有直接子会话仍在工作」（4.36）；
- 距最近一次活动 ≥ `idleMinutes`。「活动」= 会话创建 / 恢复完成、`agent.send` 受理、任一 `agent.stream` 事件发出（只在内存记录，不持久化；sidecar 重启后会话本就是 dormant）。

**并发**：关闭进行中再 `agent.send`，先等关闭完成再按 dormant 恢复（`ensureSession` 等待 `agent.closing`），不返回 `AGENT_CLOSED`。回收写日志「回收空闲 agent <id>（手动 / 空闲 N 分钟）」。

**前端设置**：「常规」页增加两行：「空闲自动回收」开关，「空闲时长（分钟）」数字输入（1–1440，失焦 / 回车保存）。未连接 sidecar 时显示与其它 sidecar 设置一致的提示。

### 4.35 翻译（用户语言 ↔ Agent 语言）

用户用自己的语言对话，Agent 在上下文里只看到 Agent 语言。翻译核心移植自 paseo-translate（`llm-client` / 系统提示词 / prompt 片段规则 / JSONL 缓存），**是本项目唯一直连模型 API 的地方**：可选功能、默认不启用、只调用用户自己配置的 OpenAI 兼容 endpoint，与驱动编程 Agent 无关。

**endpoint 配置**：`<AGENTDECK_DATA_DIR>/translation-endpoint.json`（原子写入，含明文密钥，与 `providers.json` 同级别）。
```ts
interface TranslationEndpoint {
  baseUrl: string;   // 如 https://api.deepseek.com/v1；请求 `${baseUrl}/chat/completions` 或 `${baseUrl}/responses`
  apiKey: string;    // 空串 = 不带 Authorization
  model: string;
  protocol: "chat-completions" | "responses"; // 默认 "chat-completions"
  reasoningEffort: "default" | "none" | "minimal" | "low" | "medium" | "high"; // 默认 "default" = 不发该参数
  timeoutMs: number; // 单次请求超时，默认 30000，整数 1000–600000
}
```
- RPC `translation.endpoint.get {}` → `TranslationEndpoint`；`translation.endpoint.set { patch: Partial<TranslationEndpoint> }` → `TranslationEndpoint`（zod strict 校验，非法 → `-32602`）。两者都在远程客户端禁止列表里（同 `provider.config.*`，4.31）。
- `baseUrl` 或 `model` 为空视为「未配置」。

**语言与开关**：`SidecarSettings.translation`（4.24 的设置文件，`settings.get/set` 读写、`settings.changed` 广播）：
```ts
translation: {
  userLanguage: string;        // 默认 "简体中文"，1–64 字
  agentLanguage: string;       // 默认 "English"，1–64 字
  translateReasoning: boolean; // 思考块也翻译显示，默认 false（思考往往很长，翻译成本翻倍）
  translateInput: boolean;     // 翻译用户输入（消息与审批回答），默认 true；false 时原样发送，只翻译回复显示
  enabledByDefault: boolean;   // 新建会话默认开启翻译，默认 false
}
```

**会话开关**：`AgentSnapshot.translation?: boolean`（缺省 = false，随 meta 持久化）。`agent.create` 可带 `translation?: boolean` 显式指定（新任务输入框的开关）；省略时，用户新建的会话（origin 缺省 / `"user"`）取 `settings.translation.enabledByDefault`，委派 / 协作组 / 看板 / 调度新建的会话不开启；分叉（4.23）继承原会话；之后经 `agent.update { agentId, translation }` 切换（同 4.17 只改元数据）。

**翻译 RPC**：`translation.translate { direction: "user-to-agent" | "agent-to-user"; text: string }` → `{ text: string }`。
- `text` 1–100000 字，超出 → `-32602`。全空白原样返回，不请求 endpoint。
- 未配置或请求失败 → `-32000`，`data.code = "TRANSLATION_FAILED"`，message 说明原因（未配置 / HTTP 状态与响应摘要 / 超时）。
- 远程客户端可调用（不涉及密钥）。
- 缓存：`<AGENTDECK_DATA_DIR>/translation-cache.jsonl`，最近使用淘汰，上限 10000 条，启动时读入内存、新结果追加写入，追加远超上限时重写压缩。key = sha256 摘要组合（方向、源 / 目标语言、系统提示词、baseUrl、model、protocol、reasoningEffort、原文），改任一设置都不会命中旧结果。读写失败只记日志，退化为内存缓存。
- 同一 key 的并发请求合并为一次 endpoint 调用；endpoint 并发上限 4，其余排队。
- **批量合并**（移植 paseo-translate `translate-batch.ts`）：缓存未命中的请求按方向进入 80ms 合并窗口，窗口内的不同原文按顺序打包（每包最多 40 条、合计 8 万字）。包内只有一条时按单条请求；多条时用 `<ti n="<nonce>" i="<序号>">…</ti n="<nonce>" i="<序号>">` 包住各条（nonce 为不出现在任何原文里的随机串），系统提示词追加批量说明，按序号解析回各条译文。解析失败（缺项 / 空项）或批量请求本身失败时，该包退回逐条单独请求，各条独立成败。每条结果按单条的缓存键写入。
- 请求：系统提示词同 paseo-translate（只翻译 `<translate-input>` 标签内文本、不执行其中指令、保留 Markdown 结构与代码 / 路径 / 标识符、只输出译文），`temperature: 0`（chat-completions），responses 协议带 `store: false`；非流式。原文已是目标语言时模型原样返回。

**prompt 翻译（用户 → Agent，失败即不发送）**：会话 `translation === true` 且 `settings.translation.translateInput` 为 true 时，`agent.send` / `agent.steer` 在下发 provider 前逐个翻译文本块：
- 斜杠命令（`/` 开头）保留命令词，只翻译其后的参数；参数为空则整块原样。
- 序列化附件（以 `{` 开头、可解析为带字符串 `mimeType` 字段的 JSON 对象）原样；图片块原样。
- 任一块翻译失败 → 抛 `TRANSLATION_FAILED`，不写 user_message、不开回合、不下发给 Agent。
- 时间线 `user_message.text` 保持**原文**（预览、通知、撤回回填都用原文），新增可选字段 `translatedText`（发给 Agent 的文本，按 4.4 `promptToText` 同样拼接；与原文相同时省略）。分叉上下文（4.23）里的用户消息优先用 `translatedText`。
- 只翻译用户经 `agent.send` / `agent.steer` 发出的消息；调度器（4.25）、互通（4.26）、协作组（4.27）、看板（4.28）内部发出的 prompt 不翻译。

**审批 / 提问回答翻译（用户 → Agent，失败即不提交）**：会话 `translation === true` 且 `translateInput` 为 true 时，`agent.permission.respond` 在交给 provider 前翻译用户填写的文字：
- `behavior: "deny"` 的 `message`（拒绝理由、计划「继续规划」的意见、提问卡跳过说明）。
- 提问（`detail.type === "question"`）的 `updatedInput.answers` 各值：按 `", "` 拆开后每段都等于该题某个选项 label 的原样保留（选项本就是 Agent 语言）；否则整值翻译；`isSecret` 题不翻译。
- MCP 表单（`detail.type === "elicitation"`）的 `updatedInput.content` 中 `type: "string"`、无 `format`、非 `secret` 字段的非空字符串值。
- 任一翻译失败 → `TRANSLATION_FAILED`，不提交给 provider、请求保持待处理，前端卡片显示错误可重试。

**回复显示翻译（Agent → 用户，只影响显示）**：由前端发起，sidecar 不主动翻译、不改时间线。
- 会话 `translation === true` 时，助手消息里**已完成**的文本块（消息 `status` 不是 `streaming`，或该块后面已有其它块）**进入可见区域后**（IntersectionObserver，上下预留 200px；环境不支持时视为可见）调用 `translation.translate`（`agent-to-user`），打开长会话不会一次翻译全部历史；`source: "command"` 的文本块不翻。`translateReasoning` 为 true 时，已结束的思考块在**展开时**才请求翻译。
- 待处理的提问卡：题目、题头、选项 label 与说明显示译文（悬停显示原文），提交的 answers 仍用原文 label；计划审批的计划正文显示译文并可切换原文。
- 译文就绪后替换显示（Markdown），块下方给「显示原文 / 显示译文」切换；译文与原文相同时不显示切换；翻译中显示原文加「翻译中…」；失败显示原文加错误提示与「重试」。消息的「复制」按钮仍复制原文。
- 用户消息与插话气泡显示原文，`translatedText` 存在时下方给「查看发送的译文」折叠项。
- 前端按 `方向 + 原文` 在内存里缓存结果，同一页面不重复请求；重开会话由 sidecar 磁盘缓存命中，不重复计费。
- 贴底跟随：译文替换原文、「翻译中…」消失等会让内容变矮，浏览器把 `scrollTop` 夹回底部或由滚动锚定上调；时间线只在 `scrollTop` 减小**且**距底超过 8px 时才视为用户上滑而停止跟随，内容变矮后仍贴底的不算。

**前端**：
- 设置页「翻译」（路径 `/translation`）：endpoint 各字段（apiKey 用密码框）、「测试」按钮（用 `translation.translate` 翻译一句示例文本并显示结果或错误）、用户语言 / Agent 语言、翻译我的输入、翻译思考、新会话默认开启。
- 会话详情输入框工具栏加「翻译」图标开关（`agent.update`），开启时高亮。新任务输入框同样有该开关：初始状态跟随「新会话默认开启」，用户点过后创建会话时以 `agent.create { translation }` 显式传入，未点过则省略、由 sidecar 取默认值。手机端：新建会话页有「翻译」开 / 关选项（规则同新任务输入框）、会话详情顶栏有「翻译」开关（`agent.update`，失败在页面错误条显示）；endpoint 与语言设置只在电脑端（`settings.set`、`translation.endpoint.*` 对远程禁止）。
- 全文搜索（4.19）检索的是时间线原文：用户消息为用户语言，助手消息为 Agent 语言。

### 4.36 缓存保活（仅 Claude）

Claude Code 的提示缓存从最后一次请求**开始**计时，TTL 内没有新请求即过期（订阅套餐额度内主会话 1 小时；用量积分 / API key / 云厂商 5 分钟），过期后下一次请求把整段上下文重新写入缓存。主会话等子代理 / 后台任务（构建类任务常跑数小时）时不发请求。缓存保活 = 在**当前会话**里发一条内部消息开一个短回合：请求读取整段前缀，刷新 TTL。

**开关**：`AgentSnapshot.cacheKeepAlive?: boolean`（缺省 false，随 meta 持久化，加载时校验类型），经 `agent.update { agentId, cacheKeepAlive }` 设置（同 4.17 只改元数据）。只对 Claude 类 provider（`AgentClient.kind === "claude"`，含 extends claude 的自定义中转）可开：其它 provider 或 provider 已不存在时设为 true → `NOT_SUPPORTED`（「该 Agent 不支持缓存保活」）；设为 false 总是允许。不注入 TTL 相关环境变量，依赖订阅套餐内主会话默认的 1 小时 TTL（5 分钟 TTL 下 50 分钟一次的保活不起作用）。

**触发**：`CacheKeepAlive`（`agent/cache-keepalive.ts`，订阅 AgentManager）每 60 秒扫一次（定时器 `unref`，`stop` 时清除），对满足以下**全部**条件的会话发一次保活：
- `cacheKeepAlive === true`，且 provider 为 Claude 类；
- 已加载且空闲：`status === "idle"`，`activeTurnId` 为空，`pendingPermissions` 为空（dormant / closed / error 不发；发送中由 `TURN_IN_PROGRESS` 挡掉）；
- 在等待：`backgroundActive === true`（4.11 / 4.15），或有直接子会话（`parentAgentId` 为它，4.26）处于 `running` / `starting`、`activeTurnId` 非空或 `backgroundActive`。**置顶**（`pinned === true`）的会话不要求在等待：进程未被回收期间一直保活，长任务全部结束后用户回来时缓存仍在。有后台活动的会话本就不会被自动回收（4.34）；开启保活且在等子会话的会话同样不自动回收；
- 距该会话最近一次主线程请求 ≥ 50 分钟。「请求」取 sidecar 收到该会话 `turn_started` / `usage_updated`（主线程每个 `message_start` 一次，4.3）的时间，只在内存记录；sidecar 启动后该会话还没有过请求则不保活（不知道缓存是否还在）；
- 上一次保活发送失败（`sendPrompt` 抛错）后同样等满 50 分钟再试；同一会话同时只有一次发送在进行。

**保活消息**：`AgentManager.sendPrompt(agentId, prompt, undefined, { internal: true, keepAlive: true })`：内部消息，不翻译、不算用户介入（4.25 目标循环不因此停止），照常写 `user_message`、开回合、计入用量与 `updatedAt`。文本固定：「【AgentDeck 缓存保活】这是自动发送的消息，用于在等待期间保持提示缓存，不是新任务。请只回复「ok」，不要调用任何工具，也不要检查或汇报后台任务。」
- 该回合的 `turn_started` 由 AgentManager 标 `origin: "keepalive"`（4.12）。远程提醒（4.31）与桌面通知不对它提醒「本轮已完成 / 失败」；调度器（4.25）、协作组（4.27）、看板（4.28）与 CLI 自发轮次一样不把它当作所等待回合的结果。前端照常显示这条用户消息与回复。

**互通阻塞等待**：调用方 `cacheKeepAlive === true` 时，`delegate` / `send_to_agent` / `wait_agent` 的单次等待上限为 3000 秒（其它会话仍为 3600），超时照常返回 `status: "running"` 与「可用 wait_agent 继续等待」；Agent 再次调用即产生一次新请求，阻塞等待期间也能刷新缓存。

**前端**：会话右键菜单（与「⋯」菜单共用）对 Claude 类会话显示「缓存保活」，开启时图标为勾选；失败用应用内提示框反馈。

### 4.37 Computer Use（仅 Windows；sidecar 代理 cua-driver）

借鉴 LiveAgent（MIT）：桌面操作能力来自 trycua/cua 的 `cua-driver`（`cua-driver mcp` 是标准 stdio MCP server，Windows 上在 MCP 进程内直接运行，不需要守护进程）。AgentDeck 不把它直接注入给 CLI——那样宿主看不到入参 / 出参，也挡不住危险模式下的自动执行；而是由 **sidecar 作为 MCP client 拉起驱动**，在 `POST /mcp/cua` 上把工具原样转发给 CLI，转发时做防自指检查与审批。

**平台**：只支持 win32。其它平台 `computerUse.status` 返回 `supported: false`，不注入，设置页显示「仅支持 Windows」。

**设置**：`SidecarSettings.computerUse: { enabled: boolean /* 默认 false */; allowSelfTargeting: boolean /* 默认 false */; approval: "allow" | "ask" | "deny" /* 默认 "ask" */; callTimeoutSec: 30 | 60 | 120 | 300 /* 默认 120 */ }`，经 `settings.set` 修改（与 4.26 的「会话互通」开关无关）；`approval` / `callTimeoutSec` 改动对之后的每次调用立即生效，不必重启会话。

**驱动定位**（每次 `computerUse.status` / 拉起驱动时重新查找，安装后不必重启 sidecar）：PATH 上的 `cua-driver.exe` → `%LOCALAPPDATA%\Programs\Cua\cua-driver\bin\cua-driver.exe`（官方安装脚本的落点）→ `%USERPROFILE%\.cua-driver\packages\current\cua-driver.exe`。找到后跑 `cua-driver manifest`（15 秒超时）：版本取 `binary_version`，MCP 启动方式取 `mcp_invocation.{command,args}`，缺失时回退 `<路径> mcp`。

**RPC**：
- `computerUse.status` → `ComputerUseStatus { supported, installed, path?, version?, error?, running }`（`running` = 驱动进程是否在运行；未安装不是错误，`error` 只放探测失败原因）。
- `computerUse.installCommand` → `ComputerUseInstallCommand { program, args, display, sourceUrl }`：**只描述不执行**。PATH 上有 `pwsh.exe` 用它，否则 `powershell.exe`；参数 `-NoProfile -Command "irm https://cua.ai/driver/install.ps1 | iex"`；`display` 为可直接粘进终端的完整命令行，`sourceUrl` 为脚本地址。
- `computerUse.install` → `ComputerUseInstallResult { ok, exitCode, output }`：执行与 `installCommand` 相同的命令（`shell:false`、`windowsHide`、stdin 关闭）；stdout / stderr 每行经通知 `computerUse.installProgress { stream: "stdout" | "stderr", line }` 发给本机客户端；15 分钟超时结束整棵进程树；同时只允许一个安装（忙时直接返回 `ok: false`，`output` 为「已有安装任务在进行」）；`output` 为输出末尾最多 4000 字。上游脚本默认注册开机自启计划任务（RunLevel=Highest），会弹 UAC，属预期。远程客户端调用返回 -32601（4.31）。

**注入**（`computerUse.enabled` 且 win32 时，会话进程每次拉起 / 恢复 / 分叉都注入；开关变化对之后拉起的会话生效，关闭后端点立即返回 404 并结束驱动进程）：MCP server 名 `agentdeck_cua`，工具名 Claude 为 `mcp__agentdeck_cua__<tool>`、Codex 为 `agentdeck_cua.<tool>`；鉴权复用 4.26 的会话 token（`Authorization: Bearer <token>`，不论互通开关是否开启都会签发）。
- Claude：与 `agentdeck` 合在同一个 `--mcp-config` 内联 JSON 的 `mcpServers.agentdeck_cua`（`type: "http"`）。
- Codex：`config.mcp_servers.agentdeck_cua = { url（主机写 localhost）, http_headers, tool_timeout_sec: 3700, default_tools_approval_mode: "approve" }`，**所有模式**都让 Codex 放行，审批统一由 sidecar 做（否则 full-access 模式下 Codex 会直接拒绝需要审批的 MCP 调用）。
- ACP：不注入。

**审批策略**（`computerUse.approval`，设置页「工具审批策略」）：
- `ask`（询问，默认）：按下面两条分流，每次调用都要审批。
- `allow`（允许）：不经人工审批。代理不发 sidecar 审批；Claude CLI 发来的 Computer Use 工具审批（`permission_requested` 且 name 以 `mcp__agentdeck_cua__` 开头）由 AgentManager 直接以 allow 回给 provider，不下发、不进快照。防自指照常生效。
- `deny`（拒绝）：代理对每次 `tools/call` 直接返回工具错误「Computer Use 已设为拒绝所有调用（设置 → Computer Use → 工具审批策略）」；Claude CLI 发来的 Computer Use 工具审批由 AgentManager 直接以同样理由 deny。`tools/list` 照常返回（CLI 在会话开始时缓存工具列表，模型调用时得到明确的拒绝原因）。
- 策略在请求到达时读取；已挂起的审批不受之后的策略修改影响。

**审批分流（策略为 `ask` 时）**：
- **由 CLI 审批**：Claude 会话当前生效模式（显式选了模式就用它，否则用 initialize 报告的用户默认模式）为 `default` / `acceptEdits` / `plan` 时，CLI 照常发 `can_use_tool`，由用户审批；为 `auto` 时由 Claude 的分类器模型审批。CLI 发来的 Computer Use 工具审批**不提供「始终允许」**（忽略 permission_suggestions）。
- **由 sidecar 审批**：其它情况（Claude 的 `bypassPermissions` / `dontAsk` / 模式未知；Codex 全部模式；会话不支持判断）。代理在转发前经 `AgentManager.requestHostPermission` 在该会话发出 `permission_requested`：id `cu-<uuid>`、kind `tool`、name `agentdeck_cua.<tool>`、title「允许 Computer Use：<tool>？」、input 为调用参数、actions 只有 `allow`「允许一次」/ `deny`「拒绝」。用户经 `agent.permission.respond` 应答时由 AgentManager 直接完成，不经 provider。拒绝 → 工具错误「用户拒绝了这次 Computer Use 操作」（附理由）；回合结束、会话关闭时视为拒绝（快照的 `pendingPermissions` 随回合 / 会话一并清空，不另发事件）；MCP 请求被中断（CLI 取消调用）时视为拒绝并补发 `permission_resolved`。
- 判断接口：`AgentSession.cliApprovesMcpTools?(): boolean`（未实现视为 false，即由 sidecar 审批）。

**防自指**（`allowSelfTargeting` 为 true 时整体关闭）：让模型操作 AgentDeck 自己的窗口，可以点掉审批弹窗、改设置或关闭应用。自身进程 = `AGENTDECK_PARENT_PID`（Tauri 主进程，窗口归它）+ sidecar 自身 pid；自身窗口 = 驱动 `list_windows`（不过滤，缓存 400 毫秒，入参检查与桌面坐标检查共用）中 pid 属于自身进程的窗口（Windows 上 `window_id` 即 HWND）；驱动未返回窗口列表时，凡涉及 `window_id` 或桌面坐标的调用一律拒绝。
1. **入参寻址**：递归扫描整个参数（深度上限 12，超限一律拒绝）；`pid` / `process_id` / `processId` / `owner_pid` / `ownerPid` 命中自身进程，或 `window_id` / `windowId` 命中自身窗口 → 拒绝。
2. **无目标键盘输入**：工具名为 `type_text` / `press_key` / `hotkey`，或参数里有字符串 `key` / 字符串数组 `keys`，且参数里**没有任何** pid / window_id → 一律拒绝（sidecar 无法判断前台窗口；Windows 驱动带 pid 时经 PostMessage 投递、不需要前台，能力不丢）。
3. **桌面坐标**：参数里没有 pid / window_id 且 `target.kind` 不是 `window` 时，所有坐标对（键名形如 `<前缀>x<后缀>` 与 `<前缀>y<后缀>` 且都是数字：`x/y`、`from_x/from_y`、`to_x/to_y`、`x1/y1` …）按桌面物理像素判断：驱动 `list_windows`（不过滤，缓存 400 毫秒）中任一在屏且未最小化的自身窗口矩形包含该点 → 拒绝，**不看层叠顺序**（驱动自带一个全屏置顶、点击穿透的光标浮层 `Cua.AgentCursorOverlay`，按 `z_index` 取最上层窗口永远取到它，实测会漏拦）；被其它窗口盖住的宿主区域因此也不能按桌面坐标操作，模型可改用带 pid / window_id 的窗口寻址。最近一次 `get_desktop_state` 结果带 `screenshot_original_width`（截图被缩放）时，按缩放比还原后的坐标再判一次。
4. **出参**：文本块里的 JSON 片段与 `structuredContent` 递归剔除 pid 为自身进程的数组元素。
5. 由 sidecar 审批时，审批通过后再检查一次（等待期间窗口可能移动）。

残留面（已知并接受）：整屏截图里仍能看到 AgentDeck，但看到不等于能操作；CLI 自身的 shell 等工具不受此约束。

**驱动进程**：整个 sidecar 共享一个驱动子进程（`spawnProcess`：`shell:false`、`windowsHide`），首次 `tools/list` / `tools/call` 时懒启动，工具列表缓存到进程退出；进程退出后下次调用重新拉起；关闭开关或 sidecar 退出时 tree-kill。单次转发调用超时取 `callTimeoutSec`（只计驱动执行，不含等待审批；`tools/list` 固定 120 秒）；stderr 写入 sidecar 日志。模块：`computer-use/driver.ts`（定位、manifest、安装）、`computer-use/self-guard.ts`（防自指，纯函数）、`computer-use/proxy.ts`（驱动连接与 `/mcp/cua` 端点）。

**前端**：设置「Agent」组新增「Computer Use」（`/computer-use`），页面内按组展示（版式参考 LiveAgent 的「管理设置」，用本项目设置页的行卡与分段控件）：
- **驱动**：驱动状态（已安装 / 未安装、版本、路径、「重新检测」）、「启用 Computer Use」开关（未安装时禁用）。
- **安全与审批**：「工具审批策略」分段控件 允许 / 询问 / 拒绝（对应 `approval`，说明随所选档位变化）；「允许操作 AgentDeck 自身」开关。
- **运行时配置**：「单次调用超时」分段控件 30s / 60s / 120s / 300s。
- **能力概览**：静态六项（窗口枚举与切换、屏幕截图、鼠标移动与点击、键盘按键与输入、原生系统菜单控制、系统浏览器联动）；底部一行提示「操作直接作用于本机且不可撤销，常规任务建议保持「询问」」+ 外链 trycua/cua（`https://github.com/trycua/cua`，经 `openExternalUrl` 打开）。
- 未安装时「安装驱动」→ 确认对话框：标题「安装驱动」、副标题「安装驱动 → 启用。完成当前步骤后继续下一步。」、说明「将从 <sourceUrl> 下载并执行官方安装脚本，请确认命令内容（也可复制到终端手动运行）：」、命令全文 + 复制按钮、「确认运行」；运行中对话框显示滚动日志（最多 200 行），结束后显示成功 / 失败（退出码）并重新检测。
- 时间线：`agentdeck_cua` 的工具卡片标题显示为「Computer Use · <tool>」。

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

- **Claude**（`providers/claude/claude-cli-session.ts`，协议类型自写于 `stream-json-types.ts`）：一个会话一个长生命周期 `claude` 子进程，参数 `--print --verbose --output-format stream-json --input-format stream-json --include-partial-messages --permission-prompt-tool stdio --setting-sources user,project,local [--permission-mode <m>] --allow-dangerously-skip-permissions [--model m] [--resume <id>]`；每轮向 stdin 写一条带 `uuid` 的 `user` 消息，以 `result.user_message_uuid` 识别中断后过期的 result。控制请求（我方 → CLI）：`initialize`（应答含 `models`、`current_permission_mode`、`commands`）、`interrupt`（外包 3 秒超时）、`set_model`、`set_permission_mode`、`mcp_status`、`mcp_reconnect { serverName }`（60 秒超时，见 4.14）、`stop_task { task_id }`（见 4.15），默认 30 秒超时；initialize 带 `forwardSubagentText` 与 `perTaskStopAffordance`（见 4.11 / 4.15）；CLI → 我方：`can_use_tool` → `permission_requested`，应答 `{behavior:"allow", updatedInput, updatedPermissions?, toolUseID}` 或 `{behavior:"deny", message}`（`updatedPermissions` 见 5.3「始终允许」），`elicitation`（MCP 表单 / url，见 4.32）→ `permission_requested`（kind `elicitation`），应答 `{action, content?}`；`control_cancel_request` 撤回挂起的权限 / elicitation 请求；`keep_alive` 忽略；`system` 的 status 只用 requesting（4.12）与 compacting / 压缩结果，`elicitation_complete`（4.32），`compact_boundary` 见 4.13，`commands_changed` 整体替换斜杠命令缓存（4.14），其余子类型忽略。子进程意外退出 → `turn_failed`，下一轮自动以 `--resume` 重启。
  可执行文件定位顺序：「编程 Agent」页配置的路径（见 4.8；配置了就只用它，无效即不可用、不回退）→ 环境变量 `AGENTDECK_CLAUDE_PATH` → PATH 上的 `claude.exe` → 解析 npm `claude.cmd` shim 得到真实 exe → 报不可用；PATH 中位于 `node_modules` 内的目录一律跳过（`tauri:dev` 会把仓库 `node_modules/.bin` 加进 PATH）。**必须直接执行真实 exe（`shell:false`），不能经 .cmd**。
- **Codex**：`codex app-server` 子进程；`initialize`（`clientInfo` + `capabilities.experimentalApi: true`）→ `initialized` 通知 → `thread/start { model?, cwd, approvalPolicy, sandbox }` → `turn/start { threadId, input:[{type:"text",text,text_elements:[]}] }`；处理通知 `item/agentMessage/delta`、`item/reasoning/summaryTextDelta`、`item/started`、`item/completed`、`turn/started`、`turn/completed`、`thread/tokenUsage/updated`；审批请求 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval` 应答 `{ decision }`（`accept` / `acceptForSession` / `acceptWithExecpolicyAmendment` / `applyNetworkPolicyAmendment` / `decline` / `cancel`，见 5.3）、`mcpServer/elicitation/request`（4.32）、`item/tool/requestUserInput`（4.33）；中断 `turn/interrupt { threadId, turnId }`（需先拿到 turn/started 的原生 turnId）；`model/list` 拉模型。
  模式预设：`read-only`（on-request + read-only）、`auto`（on-request + workspace-write，默认）、`full-access`（never + danger-full-access）。
  可执行文件定位：「编程 Agent」页配置的路径（见 4.8，规则同上）→ `AGENTDECK_CODEX_PATH` → PATH 上的 `codex.exe` → 解析 PATH 或 `%APPDATA%
pm` 下的 npm `codex.cmd` 得到全局安装的真实 exe → 报不可用；同样跳过 `node_modules` 内的 PATH 目录，只运行用户本机全局安装的 codex。
- **ACP**：`spawn(command)` + NDJSON 流 → `ClientSideConnection`；`initialize { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile:false, writeTextFile:false }, terminal:false } }`；`newSession { cwd, mcpServers: [] }`；`prompt` 的 Promise resolve 即 turn 结束；`sessionUpdate`：`agent_message_chunk`→assistant_message、`agent_thought_chunk`→reasoning、`tool_call`/`tool_call_update`→tool_call（按 toolCallId 合并）、`plan`→todo；`requestPermission`：options 映射为 actions，按 selectedActionId 或 allow_once/allow_always、reject_once/reject_always 选；中断 `cancel { sessionId }`；模型 `unstable_setSessionModel`（agent 不给 `models` 而用 `category: "model"` 配置项时走 `session/set_config_option`，见 4.10），失败忽略。
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

**时间线大小限制**（`agent/timeline-limits.ts` 的 `limitTimelineItem`，主时间线与子代理时间线共用）：
- **文本预算**：一个时间线项里所有字符串合计最多约 64 K 字符（`TIMELINE_ITEM_TEXT_BUDGET = 65536`，按 JS 字符数计，不是字节）。遍历整个项（`detail`、`error`、`metadata` 等任意深度，深度上限 8），每个字符串最多保留「剩余预算」（但至少 1024 字符，保证后面的字段不至于全空）；超出部分截断，并在末尾追加 `…[已截断 N 字符]`。
- **图片**：任何 `type` 为 `image`（含 MCP 的 image 内容块）或带 `source.type === "base64"` 的对象，整体替换为 `{ "type": "text", "text": "[图片 约 N KB，已省略]" }`（N 按其 base64 数据长度 ×3/4 估算）；`data:image/…;base64,…` 形式的字符串替换为同样的占位文本。
- 未超限的项原样返回（同一引用，不复制）。
- **主时间线**：Claude provider 的 `toolResultText` 本来就只取 `tool_result.content` 里的文本块（图片块被丢弃），但结构化的 `tool_use_result` 会作为候选输出：未知（多为 MCP）工具的 `tool_use_result` 若含图片（如浏览器截图工具），解析不出结构化 detail 时会退回 `unknown` detail，**base64 会整段进入 `detail.output`、被广播并写入 `timeline.jsonl`**；Bash / Read 等的超大文本输出同样无上限。因此 AgentManager 在 `processEvent` 里对**所有 provider 的 `tool_call` 项**统一应用 `limitTimelineItem`（先于合并、快照、广播、落盘，所以内存、前端、`timeline.jsonl` 三处一致）。`user_message` / `assistant_message` / `reasoning` 不处理（来自用户或模型本身的文本，不是工具产物）。已落盘的旧会话不改写。
- **对前端的影响**：前端从不渲染 `unknown` detail 里的图片，只把 `detail.input` / `detail.output` 序列化成文本并截到 20000 字符（`web/src/lib/agent-tool-detail.ts`），因此显示上几乎无差别；变化只有：① 超过 64 K 字符的工具输出末尾多一行「…[已截断 N 字符]」（前端自己的 20000 字符截断通常先生效）；② `unknown` 输出里的图片块显示为「[图片 约 N KB，已省略]」文本块而不是一长串 base64；③ 会话导出（`session-export`）里同一工具卡片的输出同样是截断后的内容。
- **工具卡片图片**：前端从工具输出文本里识别图片引用（Markdown 图片、裸 data URL / http(s) URL / 带图片扩展名的路径，`web/src/lib/message-images.ts`）显示在卡片下方。`unknown` detail 的卡片正文是「输入 + 输出」拼接文本，**只从原始 `detail.output` 识别**（工具 part 上的 `imageSource`），不扫输入——否则 `risky_eval` 一类工具代码里的 `load('tag.png')` 会被当成图片。识别结果只保留有确定位置的来源（`isAnchoredImageSource`：`data:image/`、`http(s):`、`blob:`、本机绝对路径 / `file:`）；没有基准目录的相对路径（`./images/a.png`、`tag.png`、Grep / Bash 输出里的 `icons/32x32.png`）一律不显示，因为 webview 会把它解析到应用自身地址上必然 404。本机绝对路径经 Rust `read_file_data_url` 读成 data URL；远程图片依赖 CSP `img-src` 放行 `http: https:`（桌面与 mobile 的 `tauri.conf.json` 一致）。
- **与 paseo 对照**：paseo 的 `limitAgentTimelineItemContent`（`TOOL_CALL_CONTENT_MAX_LENGTH = 64 * 1024`）在工具调用事件持久化、流式推送、历史回放前截断 shell 输出、失败 shell 的错误内容与 plain_text；图片由 Claude provider 从 tool_result 中取出，按 `materializeProviderImage` 物化为 assistant markdown 图片，不再以 base64 进时间线。AgentDeck 保留 64 K 的阈值，但覆盖范围更宽（任意 detail 的任意字符串字段，因为 `unknown` detail 的 output 是任意结构），图片不物化、直接占位（前端没有对应的图片消息通道）。

Claude：
- 权限 actions：普通工具 `allow`「允许一次」/ `deny`「拒绝」；计划（kind `plan`，detail `{type:"plan"}`）`approve`「批准计划」/ `keep_planning`「继续规划」；批准计划后自动切回 `default` 模式。
- **始终允许**（`providers/claude/permission-suggestions.ts`）：`can_use_tool` 请求可带 `permission_suggestions`（PermissionUpdate 数组）、`suppress_always_allow_rule`、`default_to_no`、`blocked_path`（证据：claude.exe 2.1.299 的 zod schema）。仅 kind `tool` 且不是 `AskUserQuestion`、且 `suppress_always_allow_rule` 不为 true、且解析出至少一条可用建议时，在 `allow` / `deny` 之后追加：
  - `allow_session`「本会话始终允许」（`persist: "session"`）：把建议里所有更新的 `destination` 改写成 `"session"` 后作为 `updatedPermissions` 回传（只在 CLI 内存里生效，不写盘）；
  - `allow_project`「永久允许」（`persist: "permanent"`）：`addRules` / `addDirectories` 的 `destination` 改写成 `"localSettings"`（写 `<cwd>/.claude/settings.local.json`，不进版本库），`setMode` 保持 `"session"` 且 `bypassPermissions` 一律排除；没有任何规则 / 目录类建议（只有 setMode）时不提供该档；
  - 只采纳 `addRules`（`behavior: "allow"`）、`setMode`、`addDirectories`；`replaceRules` / `removeRules` / deny 规则不属于「允许」语义，丢弃。每档的 `description` 写出规则内容与落点，如「写入项目的 .claude/settings.local.json：Bash(git status)」「仅本会话有效，不写入文件：切换为「自动接受编辑」模式」。
  - 原始建议只保存在 provider 的待处理记录里（不进协议）；应答的 `selectedActionId` 是上述两个 id 时回传改写后的 `updatedPermissions`，其它 id（含 `allow`）不带。
  - 回传的更新含 `setMode` 时 CLI 的模式已变：provider 同步本地 mode 并发 `mode_changed`（不再向 CLI 发 `set_permission_mode`），界面显示的模式与 CLI 一致。
  - `default_to_no` 为 true → `AgentPermissionRequest.defaultDeny = true`；`blocked_path` 追加到说明（「受限路径：…」）。
- detail 分布：Bash / PowerShell→shell（无 exitCode）、Read→read、Write→write、Edit / MultiEdit→edit、Grep / Glob / WebSearch→search、WebFetch→fetch、Task / Agent→sub_agent（见 4.11）、Skill→plain_text、MCP 等→unknown；TodoWrite 与 TaskCreate / TaskUpdate / TaskList 不发 `tool_call`，只发 `todo`（见下两条）。
- Claude 的待办工具有两套（Claude Code 2.1.299 实测）：旧的 `TodoWrite`（input `todos[{content,status,activeForm}]`，整表覆盖，每次发一条 `todo`）只在 `CLAUDE_CODE_ENABLE_TASKS=false` 时启用；新的 `TaskCreate` / `TaskGet` / `TaskUpdate` / `TaskList` 默认启用，但仅当模型在内置名单内（Claude 3.x、Opus 4.0–4.7、Sonnet 4.0–4.6、Haiku 4.5）或设了 `CLAUDE_CODE_ENABLE_TODO_TOOLS=true` 时才会提供（Claude 5 系列不在名单内，AgentDeck 不注入该环境变量，所以 5 系列不出待办）。它们是延迟加载工具，模型要先调 `ToolSearch`（`select:TaskCreate,TaskUpdate,TaskList`）取回 schema，这一步是普通工具卡片。
- 新 Task 工具的协议（实测，id 是字符串形式的自增数字，从 "1" 起）：
  - `TaskCreate` input `{subject, description, activeForm?}`；`tool_result.content` 为文本 `Task #1 created successfully: <subject>`，同一条 user 消息的 `tool_use_result` 为 `{task:{id:"1",subject}}`。
  - `TaskUpdate` input `{taskId, status?, subject?, ...}`，status 取 `pending` / `in_progress` / `completed` / `deleted`；文本结果 `Updated task #1 status`，`tool_use_result` 为 `{success,taskId,updatedFields,statusChange:{from,to}}`。
  - `TaskList` input `{}`；文本结果每行 `#1 [completed] <subject>`，`tool_use_result` 为 `{tasks:[{id,subject,status,blockedBy}]}`。
  - 一条 user 消息带多个 `tool_result` 时没有可对应的 `tool_use_result`，此时 TaskCreate / TaskList 退回解析文本。
- Task 工具映射（`providers/claude/task-todos.ts`）：每个会话维护一张任务表（id → subject / status，保持创建顺序），在 `tool_result` 到达（非 `is_error`）时才应用：`TaskCreate` 加入一项（id 取结构化结果 `task.id`，其次文本 `Task #<id>`，都没有则按「当前最大数字 id + 1」临时编号，后续 TaskList 整表同步时纠正）；`TaskUpdate` 按 `taskId` 改 status / subject，`deleted` 移除，未知 id 忽略；`TaskList` 以结构化 `tasks`（其次文本行）整表替换（不含 `deleted`）。每次表变化发一条 `{type:"todo", items}`：`text`=subject，`completed`=(status==="completed")，`in_progress` 与 `pending` 同为未完成（与 TodoWrite 一致，「进行中」由前端取第一条未完成项）。子代理（带 `parent_tool_use_id`）内的 Task 工具调用走子代理时间线，不改主表；`--resume` 后任务表从空开始，以之后的事件为准。`TaskGet` 仍按普通工具卡片显示。这些工具的 `can_use_tool` 权限请求流程不变（只是不发 `tool_call` 卡片）。
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
- 审批 actions（`providers/codex/approval-actions.ts`，每个 action 的 id 对应一个 decision 值，应答按 `selectedActionId` 取回；未带 `selectedActionId` 时按 behavior / `interrupt` 回 `accept` / `decline` / `cancel`）：
  - 命令审批 `item/commandExecution/requestApproval`：params 带 `availableDecisions`（实验 API，AgentDeck 已声明 `experimentalApi`）时**只呈现其中列出的决定**；没有时给 `accept` / `acceptForSession` / `decline` / `cancel`，且带 `proposedExecpolicyAmendment` 时再补一项永久允许。
  - 映射：`accept`「允许」（有任何「始终」变体时标签改为「允许一次」）、`decline`「拒绝」、`cancel`「拒绝并中断本轮」（Codex 文档：拒绝且立即中断回合）、`acceptForSession` → `allow_session`「本会话始终允许」、`{acceptWithExecpolicyAmendment:{execpolicy_amendment}}` → `allow_project`「永久允许」（description「以后允许以 `<前缀>` 开头的命令（写入 Codex 执行策略）」）、`{applyNetworkPolicyAmendment:{network_policy_amendment:{host,action}}}` → `network_allow:<host>`「始终允许访问 host」/ `network_deny:<host>`「始终禁止访问 host」（后者 behavior 为 deny）。展示顺序固定：允许一次、拒绝、各种始终允许、拒绝并中断。
  - 文件改动 `item/fileChange/requestApproval`：`accept` / `acceptForSession` / `decline` / `cancel`（decision 枚举与命令审批的前缀一致，没有 execpolicy / 网络策略）。
  - 旧版 `execCommandApproval` / `applyPatchApproval`（ReviewDecision）：`approved` / `approved_for_session`（`allow_session`）/ `denied`（带理由）/ `abort`。
  - 拒绝时 `interrupt:true`（或点「拒绝并中断本轮」）使本轮以 `turn_canceled` 结束；被拒绝的命令 tool_call 为 failed，error「用户拒绝了该操作」。
- 多文件 fileChange 的 detail 只显示第一个文件，完整列表在 `metadata.files`；新增文件为 `write` detail。
- `turn_completed.usage` 的 token 数为本轮合计：取本轮内 `thread/tokenUsage/updated` 的 `total`（缺省读 `total_token_usage`）相对本轮起点的差值（起点 = 本轮首条更新的 total − last）；没有 total 时退回 last。上下文窗口字段仍取最近一次 last。
- 子进程意外退出后下一轮自动重启并 `thread/resume`。

ACP：
- models / modes 只有建会话后才可得；首次建会话前 `provider.listModels` 返回空，之后返回最近一次会话的缓存。
- 权限 actions 为 `{ id: optionId, label: name, behavior }`，可能含 allow_once / allow_always / reject_once / reject_always 多项，前端按 actions 渲染并回传 `selectedActionId`。`allow_always` / `reject_always` 的标签统一为「始终允许」/「始终拒绝」（agent 的原名放进 `description`「生效范围由 Agent 决定（原选项：…）」），`allow_always` 标记 `persist: "permanent"`（ACP 协议不区分本会话 / 永久，按更谨慎的处理，前端用次要样式）；`allow_once` / `reject_once` 沿用 agent 给的名字。本期不做 ACP elicitation（SDK 0.17.1 没有 handler）。
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
   - **拒绝 / 继续规划附理由**：`PermissionCard` 在按钮行末尾有「理由」入口（`kind: "plan"` 时叫「意见」），默认折叠；点开出一个单行输入（自动聚焦，手机端等软键盘升起后 `scrollIntoView` 到可视区），在输入框回车（输入法选词中的回车除外）等同点第一个拒绝类按钮，或直接点任一拒绝类按钮提交；理由去首尾空白后非空才作为 `AgentPermissionResponse` deny 的 `message` 回传，允许类按钮忽略理由，不展开时与原来完全一致（不增加常规操作步骤）。提问卡（`QuestionCard`）不提供。各 provider 对 `message` 的处理：Claude 作为 `deny.message` 回给 CLI（计划的「继续规划」同样，缺省文案仍是「用户希望继续完善计划，暂不执行」）；Codex 旧版协议（`legacy-exec` / `legacy-patch`）放进 `denied.rejection`，v2 的 `decision: "decline"` 协议本身没有理由字段，理由被丢弃（仅出现在 AgentDeck 的 `permission_resolved` 事件里）；ACP 的 `RequestPermissionOutcome` 只有 `optionId`，同样无法传递理由；mock 会在回复里回显收到的理由。
   - **计划用 Markdown 渲染**：`detail.type === "plan"` 的正文复用时间线助手文本的 `MessageText`（Streamdown），容器最高 320px、超出滚动。
   - **MCP 表单卡片**：`kind: "elicitation"` 且 `detail.type === "elicitation"` 时 `ApprovalDialog` 分发给 `ElicitationCard`（4.32），不走通用的允许 / 拒绝按钮。
   - **多按钮与「始终允许」**：`actions` 按序渲染，窄屏（≤640px 或触屏）自动换行铺开，按钮触控区 ≥44px；带 `persist` 的动作（`allow_session` / `allow_project` / ACP `allow_always` 等）用虚线描边的次要样式，且有 `description` 的动作其说明在按钮下方另起一行列出（同时是按钮 tooltip，手机没有 hover），不增加确认弹窗。`defaultDeny` 为 true 时拒绝类按钮排到最前并作为主按钮（加粗描边），允许类用中性描边，不自动聚焦任何允许按钮。
   - **标签按类型区分**（`web/src/lib/permission-label.ts`）：提示条、手机会话列表角标（取快照 `pendingPermissions[0].kind`，无则取运行时首条审批）、桌面面板卡片（「N 待审批」）：`question` →「待回答」，`plan` →「待确认计划」，其余「待审批」；看板关联会话角标同理为「等待回答 / 等待确认计划 / 等待审批」。
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
- **安装包**：NSIS（per-user 安装）；卸载是否删除数据目录（`%APPDATA%\local.agentdeck.desktop` 与 `%LOCALAPPDATA%\local.agentdeck.desktop`）只由 Tauri 卸载确认页自带的「删除应用数据」复选框决定：未勾选即保留，覆盖安装 / 更新时不删；不另加卸载弹窗。
- **验收**：release 构建后直接运行 `target/release/agentdeck.exe`（旁边有 node.exe 与资源），确认 sidecar 以 bundle 方式启动（命令行为 `<资源目录>
ode.exe \?<资源目录>sidecarundle.mjs`，`\?` 前缀来自 Tauri resource_dir，node 可正常处理）、mock 会话可跑通、退出无残留（关闭主窗口只隐藏到托盘，真正退出走托盘「退出 AgentDeck」，sidecar 收到 stdin EOF 后以 code 0 退出）；NSIS 安装包能生成。在干净机器上的安装测试由用户执行。

## 8. 许可

- 主体派生自 Hermes-CN-Desktop：PolyForm Noncommercial 1.0.0，保留 `LICENSE` 与两条 `Required Notice`，**仅限非商业用途**。
- Agent 适配层移植自 paseo：Apache-2.0，见 `legal/paseo.Apache-2.0.txt`；被移植/修改的文件头注明 `Derived from paseo <原路径> (Apache-2.0); modified for AgentDeck`。
- 翻译核心（4.35）移植自 paseo-translate（theTd/paseo-translate，经许可使用）：被移植/修改的文件头注明 `Derived from paseo-translate <原路径>; modified for AgentDeck`。
- 部分前端代码源自 Hermes Agent 上游（Nous Research，MIT），见 `legal/hermes-agent-upstream.MIT.txt`。
- 随包分发的第三方组件（P7）：Node.js 运行时 → `legal/nodejs.LICENSE.txt`；sidecar bundle 内的 npm 包（以 `dist-sidecar/meta.json` 为准）→ `legal/sidecar-third-party.txt`；前端生产依赖 → `legal/web-third-party.txt`；汇总见 `NOTICE.md`。依赖或 Node 版本变化时需重新生成：先 `pnpm sidecar:build`，再 `pnpm legal:gen`（`scripts/gen-legal.mjs`，结果稳定可重复）；Node 版本变化还需重取 `legal/nodejs.LICENSE.txt`。
- 不包含也不分发 Anthropic / OpenAI 的代码或可执行文件：Claude provider 自行实现 Claude Code CLI 的 stream-json 协议（未使用 claude-agent-sdk），Codex 走本机 `codex app-server`。
