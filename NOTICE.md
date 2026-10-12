# NOTICE

AgentDeck 包含或派生自以下项目的代码。各部分的许可全文见仓库根目录 `LICENSE` 与 `legal/` 目录。

## Hermes-CN-Desktop（主体）

AgentDeck 的桌面外壳（Rust / Tauri）、React 前端、`packages/protocol` 与 `packages/shared-ui` 派生自 Hermes-CN-Desktop，遵循 **PolyForm Noncommercial License 1.0.0**，**仅限非商业用途**，商业使用需另行取得授权。许可全文见 [LICENSE](./LICENSE)。

按该许可要求，任何获得本软件任意部分副本的人都必须同时获得许可条款以及下列 `Required Notice` 原文：

```
Required Notice: Copyright (c) 2026 Qingdao Wanderminds Network Technology Co., Ltd. / 青岛万德缦思网络科技有限公司
Required Notice: Hermes Agent CN Desktop is licensed for noncommercial use under the PolyForm Noncommercial License 1.0.0. Commercial use requires separate authorization. Contact: lijiale@wanderminds.cn
```

最终用户许可协议见 `legal/EULA.zh-CN.txt`（安装包使用的 `legal/EULA.zh-CN.rtf` 由其生成）。

## paseo（Agent 适配层）

AgentDeck 的 Agent 适配层（`packages/sidecar` 中的 provider、会话管理、Windows 子进程处理等）将移植自 paseo，遵循 **Apache License 2.0**：

- Copyright (c) 2025-present Mohamed Boudra
- 许可全文：`legal/paseo.Apache-2.0.txt`
- 被移植或修改的文件会在文件头注明 `Derived from paseo <原路径> (Apache-2.0); modified for AgentDeck`。

## Hermes Agent（部分前端代码）

部分前端代码源自 Hermes Agent 上游项目，遵循 **MIT License**：

- Copyright (c) 2025 Nous Research
- 许可全文：`legal/hermes-agent-upstream.MIT.txt`

## 其他第三方资源

- HarmonyOS Sans 字体：许可见 `legal/HarmonyOS_Sans_LICENSE.txt`。
- agency-agents（MIT）：许可见 `legal/agency-agents.MIT.txt`。

## 随包分发的第三方组件

Windows 安装包除 AgentDeck 自身代码外，还包含下列第三方组件。安装包会把本文件、`LICENSE` 与下列许可文件一并放进安装目录。

### Node.js 运行时

- 文件：安装目录下的 `node.exe`（构建时由 `scripts/fetch-node.mjs` 从官方发行包 `node-v24.21.0-win-x64.zip` 取出，未作修改）。
- 许可：Node.js 以 MIT 许可发布，其自带的第三方依赖（V8、OpenSSL、libuv、ICU、npm 等）各有许可。
- 许可全文：`legal/nodejs.LICENSE.txt`（取自上述发行包中的 `LICENSE`，含其捆绑依赖的声明）。

### sidecar 依赖（`sidecar/bundle.mjs`）

sidecar 由 esbuild 打成单文件，以下 npm 包的代码被打进其中（以 `scripts/build-sidecar.mjs` 输出的 metafile 为准）：

| 包 | 版本 | 许可证 |
|---|---|---|
| @agentclientprotocol/sdk | 0.17.1 | Apache-2.0 |
| @anthropic-ai/claude-agent-sdk | 0.3.246 | Anthropic 专有条款（见下文） |
| isexe | 3.1.5 | BlueOak-1.0.0 |
| tree-kill | 1.2.2 | MIT |
| which | 5.0.0 | ISC |
| ws | 8.21.1 | MIT |
| zod | 3.25.76、4.6.6 | MIT |
| mime-types / mime-db（内嵌于 claude-agent-sdk 的 `sdk.mjs`） | — | MIT |

各包的版权行与许可全文见 `legal/sidecar-third-party.txt`。

### Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`）

sidecar bundle 中包含 `@anthropic-ai/claude-agent-sdk` 0.3.246 的 JavaScript 代码（`sdk.mjs`）。该 SDK **不是开源软件**，其使用受 Anthropic 条款约束。其包内 `LICENSE.md` 原文为：

```
© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance.
```

- AgentDeck **不随安装包分发** `claude` 可执行文件（SDK 的平台二进制包 `@anthropic-ai/claude-agent-sdk-*` 未打包），运行时使用用户本机已安装的 Claude Code。
- 使用 Claude 相关功能即表示用户需自行遵守上述 Anthropic 条款。

### 前端依赖（web bundle）

React 前端的生产依赖（React、TanStack Query、Jotai、Radix UI、xterm.js、KaTeX、Mermaid、Recharts 等，以及 `@agentdeck/protocol`、`@agentdeck/shared-ui` 的依赖）打包在主程序内。包清单、许可证类型与许可全文见 `legal/web-third-party.txt`（由 `pnpm licenses list --prod` 在 `@agentdeck/web`、`@agentdeck/protocol`、`@agentdeck/shared-ui` 范围生成，列出的是依赖树，可能多于实际打进 bundle 的代码）。
