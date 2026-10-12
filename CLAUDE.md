# AgentDeck 工作指引

## 项目概述

AgentDeck 是多 Agent 编排桌面工具：Tauri v2 + React 前端（派生自 Hermes-CN-Desktop），由 Node sidecar 驱动用户本机已安装的编程 Agent（Claude Code / Codex / ACP agents），调用方式借鉴 paseo。**自己不直接调用模型 API。**

架构、Rust↔sidecar 启动契约、前端↔sidecar JSON-RPC 协议、阶段计划都在 `docs/design.md`，**它是契约的唯一来源，改契约先改它**。

## 项目结构

```
AgentDeck/
├── src/                 Rust Tauri 外壳（crate lib 名 agentdeck_core）
│   ├── process/sidecar.rs   拉起与监管 Node sidecar（Job Object / ready 握手）
│   └── commands/            git / terminal / preview / ui_store / notify / coding_agents …
├── packages/
│   ├── sidecar/         Node sidecar（TypeScript）：JSON-RPC over WS、AgentManager、providers
│   ├── protocol/        共享类型（agent-api.ts 为前端与 sidecar 的协议类型）
│   └── shared-ui/       设计 token 与基础组件
├── web/                 React 前端（Vite + TanStack Query + Jotai + CSS Modules）
└── docs/design.md       设计与契约
```

## 常用命令

```bash
pnpm install
pnpm typecheck        # license / version / grid 检查 + 各 workspace tsc
pnpm test:unit        # 各 workspace vitest
cargo check --all-targets
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
pnpm tauri:dev        # 开发：Rust 以 `node --import tsx` 拉起 packages/sidecar/src/main.ts
```

## 约定

- 回复、注释说明、提交信息一律简体中文（代码标识符、路径、命令除外）。
- 临时文件放项目根 `tmp/`（已 gitignore）。
- 前端样式用 CSS Modules，颜色/圆角/字号用 `packages/shared-ui/src/tokens/` 的变量，不硬编码。
- 前端不要在 `web/src/lib/transport.ts` 之外手写 fetch；与 sidecar 通信只走 `lib/sidecar-client.ts` 与 `hooks/use-agent-session.ts`。
- sidecar 内所有子进程 spawn 设 `windowsHide: true`；能解析到真实 exe 就 `shell:false`；内联 JSON 参数绝不经过 cmd.exe；关闭会话要 tree-kill。
- Rust 测试：单元测试内嵌 `#[cfg(test)]`；env 相关测试加 `#[serial_test::serial]`；文件系统测试用 `tempfile`；HTTP 用 `wiremock`。
- 从 paseo 移植或改写的文件，文件头注明 `Derived from paseo <原路径> (Apache-2.0); modified for AgentDeck`。

## 许可

派生自 Hermes-CN-Desktop（PolyForm Noncommercial 1.0.0），仅限非商业用途，必须保留 `LICENSE` 中的 `Required Notice`。第三方声明见 `NOTICE.md` 与 `legal/`。
