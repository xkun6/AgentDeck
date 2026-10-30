# AgentDeck

AgentDeck 是一个多 Agent 编排桌面工具：在一个窗口里创建、并行驱动和审批本机已安装的编程 Agent（Claude Code、Codex、DeepSeek Harness 以及自定义的 ACP Agent）。它自己不直接调用模型 API，而是通过子进程/SDK 驱动这些 CLI。

> 当前版本是 `v0.3.22`。项目处于早期阶段，接口与界面都可能调整。

## 架构

Tauri v2（Rust 外壳）拉起并监管一个 Node sidecar，React 前端通过 WebSocket JSON-RPC 直连 sidecar，sidecar 再驱动各个 Agent。完整设计与契约见 [docs/design.md](./docs/design.md)。

## 开发

```bash
pnpm install
pnpm tauri:dev            # 开发模式启动桌面端
pnpm typecheck            # license / version / grid 检查 + 各 workspace 类型检查
pnpm test:unit            # 各 workspace 单元测试
cargo check --all-targets
cargo test
```

## 许可

本项目派生自 Hermes-CN-Desktop，遵循 PolyForm Noncommercial 1.0.0，**仅限非商业用途**，详见 [LICENSE](./LICENSE)。第三方来源与许可声明见 [NOTICE.md](./NOTICE.md) 与 `legal/` 目录。
