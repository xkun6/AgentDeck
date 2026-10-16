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
| isexe | 3.1.5 | BlueOak-1.0.0 |
| smol-toml | 1.9.1 | BSD-3-Clause |
| tree-kill | 1.2.2 | MIT |
| tweetnacl | 1.0.3 | Unlicense |
| which | 5.0.0 | ISC |
| ws | 8.21.1 | MIT |
| zod | 4.6.6 | MIT |

各包的版权行与许可全文见 `legal/sidecar-third-party.txt`。

### Claude Code 与 Codex

AgentDeck 的 Claude Code 与 Codex 适配均直接调用**用户本机安装的 CLI**（`claude` 通过 stream-json stdio 协议，`codex` 通过 `codex app-server`）。本项目**不包含也不分发** Anthropic / OpenAI 的代码或可执行文件；使用相关功能时，用户需自行安装这些 CLI 并遵守其各自的许可与服务条款。

### 前端依赖（web bundle）

React 前端的生产依赖（React、TanStack Query、Jotai、Radix UI、xterm.js、KaTeX、Mermaid、qrcode 等，以及 `@agentdeck/protocol`、`@agentdeck/shared-ui` 的依赖）打包在主程序内。包清单、许可证类型与许可全文见 `legal/web-third-party.txt`（由 `pnpm licenses list --prod` 在 `@agentdeck/web`、`@agentdeck/protocol`、`@agentdeck/shared-ui` 范围生成，列出的是依赖树，可能多于实际打进 bundle 的代码）。
