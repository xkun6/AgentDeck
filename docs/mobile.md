# AgentDeck 安卓 App 规划

> 状态：规划已定（2026-10-14）；M0 技术验证脚手架已有，M1（sidecar 远程网关 + 桌面「手机连接」页）已在分支 `feat/android-m1` 实现，M2（手机 MVP：扫码配对 / 电脑列表 / 会话列表 / 时间线分页 / 审批 / 新建会话 / 设置）已在分支 `feat/android-m2` 实现，真机联调待办。协议与安全契约见 `docs/design.md` 4.31，改契约先改那里。

## 1. 定位

手机只是遥控器：Agent 仍运行在电脑上，由桌面 sidecar 驱动；手机经远程网关连到 sidecar，作为它的又一个前端。手机上不运行任何 Agent，也不保存会话数据（只缓存当前打开的时间线）。

**v1 做**：扫码配对电脑、会话列表、时间线（含流式）、发送 / 插话 / 取消 / 撤回、权限审批与 Agent 提问、新建会话（目录从已有会话的工作目录中选）、图片附件（拍照 / 相册，走 `AgentPromptInput` 的 base64 image）、状态行（步骤 / 额度 / 速度）、后台通知。

**不做**：在手机上跑 Agent、终端、git 操作（审阅 / worktree / 分支）、文件预览与编辑、relay 中转、FCM 推送、iOS。

## 2. 已拍板的决定

| 项 | 决定 | 理由 |
|---|---|---|
| 技术路线 | Tauri v2 Android，复用 `web/` 的 React 代码 | 单人维护，不养第二套前端；时间线 reducer、`MessageTimeline`、审批、`sidecar-client` 可直接复用。M0 验证不达标再转 Expo RN（参照 paseo `packages/app`） |
| 连接方式 | 局域网 + Tailscale 直连，端到端加密 | 不需要服务器；E2EE 免去证书问题。relay 以后再说 |
| 后台通知 | Android 前台服务保持连接 + 本地通知 | 国内 ROM 基本收不到 FCM，且 FCM 消息预览会明文经过第三方 |

## 3. 从 paseo 借鉴的部分（Apache-2.0，移植文件头注明出处）

| paseo | AgentDeck 用法 |
|---|---|
| `packages/relay/src/crypto.ts`、`encrypted-channel.ts`（tweetnacl box、`e2ee_hello` / `e2ee_ready`） | `packages/remote`：握手与加解密，sidecar 与手机共用；按 4.31 增加配对 / 认证 / challenge / 计数 nonce |
| `packages/protocol/src/connection-offer.ts`、`server/pairing-offer.ts` | `RemoteConnectionOffer` 与 `agentdeck://pair#...` 二维码 |
| `packages/app/src/utils/connection-selection.ts` | 多地址候选：v1 简化为并发尝试 offer 中的全部地址，取第一个认证成功的 |
| `docs/timeline-sync.md`（epoch + seq、tail 分页、缺口补齐） | `agent.timeline` 的 `beforeSeq` / `limit` 分页；`sidecar-client` 已有的 seq 去重与缺口补齐沿用 |
| `server/agent-attention-policy.ts` | `client.presence` + `client.attention`，电脑前有人时手机不响 |
| `packages/app/src/agent-stream/`（倒置列表、按帧提交） | 手机时间线性能优化的参照 |

## 4. 结构

```
packages/remote/            新增：纯 TS + tweetnacl，握手消息类型、帧编解码、nonce 计数（sidecar 与 web 共用）
packages/sidecar/src/remote/ 新增：远程网关（监听、握手认证、设备存储、白名单、attention 判定）
web/src/mobile/              新增：手机入口与页面（电脑列表 / 扫码配对 / 会话列表 / 会话详情 / 设置）
web/src/lib/remote/          新增：E2EE socket（实现 sidecar-client 的 socketFactory 接口）、配对与凭据存取
web/src/routes/remote*       新增：桌面「手机连接」设置页（开关、端口、地址、二维码、设备列表与吊销）
mobile/                      新增：Tauri Android 工程（独立 crate，不放进桌面 crate；M0 定具体位置）
  └─ 插件：barcode-scanner（扫码）、notification（本地通知）、store（凭据）、自写 Kotlin 前台服务插件
```

前端复用规则：
- 手机构建用独立 Vite 入口（如 `web/mobile.html` → `web/src/mobile/main.tsx`），不引入依赖 Tauri 桌面命令（git / terminal / preview / fs_list / ui_store / desktop_notify）的模块。
- `sidecar-client.ts` 剥离出与 Tauri 无关的核心（`resolveSidecarUrl` / `watchTauriSidecarStatus` 以注入方式提供），桌面与手机各自提供连接参数与 socket。
- 样式仍用 CSS Modules + `packages/shared-ui` token；手机布局单栏、底部导航，触控目标 ≥ 44px。

## 5. 阶段

| 阶段 | 内容 | 验证 |
|---|---|---|
| **M0 技术验证** | ① `mobile/` 跑通 Tauri Android 并加载 `web/src/mobile` 的最小页面；② 用临时方式（开发开关让 sidecar 的 `/rpc` 绑局域网，仅验证用、不合入）连上电脑 sidecar，打开会话、发消息、看流式输出；③ 在真机打开 3000+ 条时间线的会话，测滚动与流式渲染；④ 验证 App 切到后台、开着前台服务时，WebView 里的 WS 能否保持 10 分钟并持续收到事件；⑤ 输入法弹出时输入框与列表的布局 | 真机记录：滚动是否明显掉帧、内存、后台存活时长。④ 不通过时改为前台服务里用 Kotlin 原生维持连接（只收 attention），③ 不通过则评估转 Expo RN |
| **M1 sidecar 远程网关** | 按 4.31 实现：`packages/remote`、`sidecar/src/remote/`、设置项、`remote.*` RPC、远程方法白名单、`agent.timeline` 分页、`client.presence` / `client.attention`；桌面「手机连接」设置页；桌面前端补发 `client.presence` | 单测覆盖：握手成功 / challenge 不符 / 计数回退 / 文本帧 / 配对密钥过期与复用 / 吊销后断开 / 白名单 / 分页回合边界 / attention 判定；`pnpm typecheck`、`pnpm test:unit` |
| **M2 手机 MVP** | 扫码配对、电脑列表与切换、会话列表、时间线（分页 + 流式）、发送 / 插话 / 取消 / 撤回、权限审批与 Agent 提问、状态行、新建会话 | 真机连真实电脑走完整流程：配对 → 新建 Claude 会话 → 审批工具调用 → 回合完成 |
| **M3 后台与输入** | 前台服务 + 本地通知（点击跳转会话）、网络切换与锁屏恢复后的重连补齐、图片附件、电池优化白名单引导 | 锁屏 10 分钟内收到完成 / 审批通知；Wi-Fi 与移动网络（Tailscale）切换后会话不丢 |
| **M4 扩展（按需）** | 按回合 diff 查看（`snapshot.diff`）、调度 / 看板 / 协作组只读、用量统计；凭据改存 Android Keystore；APK 签名与 CI（需先配置 git remote） | — |

每个阶段沿用现有流程：先改 `design.md` 契约，再派子代理实现，验证全过才提交。

## 6. 风险

- **安全**：远程控制 Agent 等同于能在电脑上执行命令。网关默认关闭；只认扫码配对过的设备；手机丢失时在桌面吊销；远程客户端不能改设置、不能管理配对。
- **国产 ROM 杀后台**：前台服务仍可能被杀，需要引导用户关闭电池优化、允许自启动；通知送达不能保证 100%。
- **WebView 性能**：长时间线与流式渲染是转 RN 的主要触发条件，M0 先测。
- **Tauri 移动端**：插件生态比 Expo 薄，前台服务需要自写 Kotlin 插件。
- **凭据存储**：v1 用 tauri-plugin-store（应用私有目录），root 设备上可被读取；M4 改 Keystore。
