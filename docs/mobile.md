# AgentDeck 安卓 App 规划

> 状态：规划已定（2026-10-14）；M0 技术验证脚手架已有，M1（sidecar 远程网关 + 桌面「手机连接」页）已在分支 `feat/android-m1` 实现，M2（手机 MVP：扫码配对 / 电脑列表 / 会话列表 / 时间线分页 / 审批 / 新建会话 / 设置）已在分支 `feat/android-m2` 实现，M3（后台保持连接 / 本地通知 / 回前台快速恢复 / 图片附件 / 后台运行引导）已在分支 `feat/android-m3` 实现（见第 7 节），真机联调待办。协议与安全契约见 `docs/design.md` 4.31，改契约先改那里。

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
| `server/agent-attention-policy.ts` | `client.attention`（原设计的 `client.presence` 在线判定已删除，是否提醒由手机端三档设置决定） |
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
| **M1 sidecar 远程网关** | 按 4.31 实现：`packages/remote`、`sidecar/src/remote/`、设置项、`remote.*` RPC、远程方法白名单、`agent.timeline` 分页、`client.attention`；桌面「手机连接」设置页 | 单测覆盖：握手成功 / challenge 不符 / 计数回退 / 文本帧 / 配对密钥过期与复用 / 吊销后断开 / 白名单 / 分页回合边界 / attention 发送；`pnpm typecheck`、`pnpm test:unit` |
| **M2 手机 MVP** | 扫码配对、电脑列表与切换、会话列表、时间线（分页 + 流式）、发送 / 插话 / 取消 / 撤回、权限审批与 Agent 提问、状态行、新建会话 | 真机连真实电脑走完整流程：配对 → 新建 Claude 会话 → 审批工具调用 → 回合完成 |
| **M3 后台与输入（已实现）** | 前台服务 + 本地通知（点击跳转会话）、网络切换与锁屏恢复后的重连补齐、图片附件、电池优化白名单引导 | 锁屏 10 分钟内收到完成 / 审批通知；Wi-Fi 与移动网络（Tailscale）切换后会话不丢 |
| **M4 扩展（按需）** | 按回合 diff 查看（`snapshot.diff`）、调度 / 看板 / 协作组只读、用量统计；凭据改存 Android Keystore；APK 签名与 CI（需先配置 git remote） | — |

每个阶段沿用现有流程：先改 `design.md` 契约，再派子代理实现，验证全过才提交。

## 6. 风险

- **安全**：远程控制 Agent 等同于能在电脑上执行命令。网关默认关闭；只认扫码配对过的设备；手机丢失时在桌面吊销；远程客户端不能改设置、不能管理配对。
- **国产 ROM 杀后台**：前台服务仍可能被杀，需要引导用户关闭电池优化、允许自启动；通知送达不能保证 100%。
- **WebView 性能**：长时间线与流式渲染是转 RN 的主要触发条件，M0 先测。
- **Tauri 移动端**：插件生态比 Expo 薄，前台服务需要自写 Kotlin 插件。
- **凭据存储**：v1 用 tauri-plugin-store（应用私有目录），root 设备上可被读取；M4 改 Keystore。

## 7. M3 实现要点（后台与输入）

**两种情况都要成立**：M0 实测华为 HarmonyOS 的 freezer 会在切后台约 3 秒后冻结整个进程（含 WebView），前台服务也挡不住；用户放行自启动 / 电池优化后是否有效要真机复测。所以设计成：没被冻结时后台照常收 `client.attention` 弹本地通知；被冻结时回到前台立刻检测死连接、重连，并用 `sinceSeq` 补齐，补齐期间界面照常可用。

**Android 本地插件 `native`**（`mobile/src/native.rs` + `gen/android/.../NativePlugin.kt`，手改部分已加注释）：`keepalive_start({ text, wakeLock? })` / `keepalive_stop`（`KeepAliveService`，specialUse 类型）、`battery_optimization_status`、`request_ignore_battery_optimization`、`open_app_settings`、`show_attention`（后台提醒通知）、`notification_status`、`take_launch_target`，以及插件事件 `notificationClicked`。移动端 Tauri 会把 Rust 没处理的 `plugin:native|xxx` 按 lowerCamelCase 直接转给 Kotlin 同名方法，所以 Rust 侧只做 `register_android_plugin` 与 ACL 声明（`build.rs` 的 `InlinedPlugin` + `capabilities/background.json`）。JS 包装在 `web/src/mobile/native/native-plugin.ts`，非 Tauri 环境全部 no-op。

**保持连接的启停时机**（`native/keepalive-controller.ts`）：选「连上就启动、断开就停」，而不是「进后台再启动」。原因：Android 12+ 禁止 App 在后台启动前台服务，而 `visibilitychange → hidden` 触发时 Activity 已经 stop，此时 `startForegroundService` 会抛 `ForegroundServiceStartNotAllowedException`；在前台、连接刚建立时启动最可靠。代价只是前台期间也有一条静音低优先级常驻通知。规则（设置页「后台保持连接」开关默认开，localStorage 持久化）：本次运行中第一次连上才启动；启动后短暂断线（自动重连中）保持服务，只把常驻通知文案从「AgentDeck 已连接：<电脑名>」改成「重连中」；用户断开 / 删除电脑、凭据失效、关闭开关、切换电脑时停止。`wakeLock` 参数默认关，仅作为锁屏后 CPU 休眠导致断连时的备用手段（目前没有界面入口）。

**前台服务被系统杀后重启**：`KeepAliveService` 改为 `START_NOT_STICKY`，并在 `onStartCommand` 收到 null intent（旧版本遗留的 sticky 重启，不带 extras）时直接 `stopSelf`。原因：进程被杀后与电脑的连接早已不在，必须由前端重建，系统重启出来的服务只会显示一条假的「AgentDeck 已连接」；Android 12+ 后台启动前台服务本就受限。二选一里选 NOT_STICKY 为主、stopSelf 兜底。

**华为的审批通知不弹横幅**：华为会把「待审批」channel 降为 importance 3，不弹横幅。设置页「后台运行」小节加了引导文案，并提供「打开『待审批』通知设置」按钮（`NativePlugin.openChannelSettings` → `Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS`，channel 不存在时先创建）。

**后台页面保活**（真机测试发现）：放行华为后台设置后进程不再被 freezer 冻结（cgroup 始终 `freezer:/`），但切后台约 5 分钟后 WebView 页面 JS 整体停止，超过 5 分钟的通知不再触发。推断原因：`WryActivity.onPause` 调 `webView.onPause()`，Activity stop 后窗口可见性又变为 INVISIBLE，Chromium 把页面视为不可见，后台定时器限流（1 次/秒 → 5 分钟后 1 次/分钟）并最终冻结。`generated/` 下的 WryActivity 每次构建都会被 wry 重新生成，不能改，所以在 `MainActivity.kt`（手改）里补：「后台保持连接」开启且已连接（`KeepAliveService.active`，服务 onStartCommand / onDestroy 维护）时，① `onPause` 后立刻 `webView.onResume()` + `resumeTimers()`；② `onStop` 后延迟几次把窗口可见性重新派发为 VISIBLE（`dispatchWindowVisibilityChanged`，系统的 INVISIBLE 在 stop 之后的下一次 traversal 才派发）；③ `setRendererPriorityPolicy(IMPORTANT, waivedWhenNotVisible=false)`，渲染进程优先级不随不可见降级。WebView 拿不到字段（`mWebView` 是 private），改为 override `onWebViewCreate` 自己持有。Chromium 没有「关闭后台节流」的 `WebSettings`，所以只能让页面保持「可见」。**代价**：后台时 `document.visibilityState` 也是 `visible`，前端的前台 / 后台改由 `NativePlugin` 的 `appState`（Activity onResume=前台、onStop=后台，命令 `app_state` + 事件 `appState`）提供，见 `native/app-state.ts`；回前台时用它触发 `SidecarClient.hintWake()`（连着就探活、断着就重连）。**这条路没有自动化测试能覆盖**，复测方法见最终回报；若真机仍在约 5 分钟后停摆，说明 Chromium 的冻结不受可见性欺骗影响，只剩「Kotlin 原生 WS 只收 attention」方案。

**断线期间发送不再误报失败**（真机测试发现）：页面被系统挂起期间发出的 prompt，回前台后会收到「与 Agent 服务的连接已断开」，但服务端回合其实已执行，用户可能因此重复发送。协议不变（sidecar 写入时间线的 `user_message` 本来就带 `clientMessageId`，`agent.send` / `agent.steer` 的 `clientMessageId` 原样落入）：`SidecarClient` 区分「请求发出后连接断开」（`SidecarConnectionLostError`，结果未知）与未连接 / RPC 错误 / 超时；`sendPrompt` / `steerPrompt` 遇到前者时调 `confirmUserMessage`——重连并按 `sinceSeq` 补齐该会话时间线，若已有同 `clientMessageId` 的 `user_message` 就按成功处理（不报错、不追加失败提示、不回填输入框），没有才按原样报错；重连仍失败（结果未知）也按原样报错。桌面共用同一段逻辑。

**回前台快速恢复**（`SidecarClient` 新增可选 `livenessProbe`，只有手机端配置，桌面行为不变）：`visibilitychange → visible`、`online`、Network Information API 的 `change` 触发检查；连接看起来还开着但距最后一次收到数据超过 15 秒，立即发 `sidecar.info`，3 秒内无任何回应（RPC 错误也算有回应）就 `forceReconnect`，不等 TCP 自然超时。时钟跳变 watchdog（JS 被冻结后恢复）在页面可见时仍无条件强制重连；**页面处于后台时**（默认看 `document.visibilityState`，手机壳里由 `isBackground` 改读原生前后台状态）跳变多半只是浏览器把后台定时器限速到每分钟一次，不等于系统休眠，所以不再强制重连（真机上曾因此每 60 秒断开重连一次），改走同一套 livenessProbe：空闲超过阈值才发 `sidecar.info`，3 秒无回应才重连。桌面（未配置 `livenessProbe`）行为不变。重连后沿用 `sinceSeq` 补齐；补齐期间 `client.syncing` 为 true，界面顶部显示轻量的「正在同步…」，结束自动消失。

**本地通知**：sidecar 总是向手机发 `client.attention`，是否提醒由设置页「通知」三档决定（`always` 默认 / `foreground` / `never`，存 localStorage 的偏好里，见 design.md 4.31 表格）。`always` 时 App 在后台（`document.visibilityState !== "visible"`）收到 → `BackgroundNotifier` 按 `id` 去重后调用 `show_attention`；前台规则：当前会话忽略 / 其它页面弹提示条；`foreground` 后台不通知；`never` 都不提醒。三个 channel：`agentdeck_permission`（待审批，高优先级）、`agentdeck_result`（完成 / 失败）、`agentdeck_schedule`（定时任务）；前台服务常驻通知用独立的 `agentdeck_keepalive`（低优先级静音）。首次连上电脑（App 在前台）时用 `tauri-plugin-notification` 的 `requestPermission` 申请 Android 13+ 通知权限，被拒后设置页显示状态并引导去系统设置。**点击跳转**：`tauri-plugin-notification` 2.6.0 在 Android 上的点击回调 payload 不含自定义 extra 和通知 id（`sourceJson` 从未赋值），无法知道该开哪个会话，所以提醒通知由 `NativePlugin` 自己发，`PendingIntent` 带 `agentId`；App 存活时经 `onNewIntent` → 事件 `notificationClicked` → 前端导航，进程被杀后冷启动经 `take_launch_target` 取走一次。

**图片附件**：输入区「图片」按钮 →「拍照 / 相册」，用 `<input type="file" accept="image/*">`（拍照加 `capture="environment"`）。wry 的 `RustWebChromeClient.onShowFileChooser` 原生支持文件选择与拍照（相机权限由 barcode-scanner 合并进 Manifest，拍照走 FileProvider），无需额外插件。发送前压缩：长边 ≤ 2048px、JPEG 质量 0.85（透明底铺白）、压缩后单张 > 5MB 拒绝；最多 4 张，可预览可删除；按 `{ type: "image", data, mimeType }` 发送，运行中插话（`agent.steer` 的 prompt 同为 `AgentPromptInput`）也允许带图。协议里没有「provider 支持图片」的能力字段（`ProviderCapabilities` 只有 steer / fork），不预先禁用按钮，带图发送失败时在错误后补一句「如果当前 Agent 不支持图片，请去掉图片后重试」，并保留文字与图片草稿。

**后台运行引导**：设置页「后台运行」小节显示通知开关与电池优化状态（回前台自动刷新）、「请求忽略电池优化」「打开应用设置」按钮、华为 / 荣耀、小米、OPPO / vivo 的自启动 / 后台活动 / 锁定最近任务指引，以及「被系统冻结时回到 App 自动补齐，不会丢消息」的说明；首次开启「后台保持连接」后连上电脑时弹一次引导对话框。

**真机验证清单（M3）**：锁屏 10 分钟内收到完成 / 审批通知；点通知（App 在后台 / 被杀后）跳转到对应会话；Wi-Fi ↔ 移动网络（Tailscale）切换后会话不丢且无重复消息；切后台被冻结后回到前台能在数秒内重连并补齐，「正在同步…」出现后消失；拍照 / 相册选图并发送；放行自启动 / 电池优化后后台存活是否改善。
