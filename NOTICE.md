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
