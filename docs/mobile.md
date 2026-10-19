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

**Android 本地插件 `native`**（`mobile/src/native.rs` + `gen/android/.../NativePlugin.kt`，手改部分已加注释）：`keepalive_start({ text, wakeLock? })` / `keepalive_stop`（`KeepAliveService`，specialUse 类型）、`battery_optimization_status`、`request_ignore_battery_optimization`、`open_app_settings`、`open_url({ url })`（`Intent.ACTION_VIEW` 调起系统浏览器，只放行 http / https，不用 `resolveActivity` 预判以免 Android 11+ 包可见性误判；前端 `openExternalUrl` 在手机端只走它，失败也不退回 `window.open`，`web/src/mobile/external-links.ts` 另在入口全局拦截 `a[href]` 点击与 `window.open`，避免 Android WebView 在本页内导航把 App 界面替换掉）、`safe_area_insets`（返回顶部系统栏高度 `top`，单位 CSS px；前端写入 `--ad-safe-top`，`mobile.module.css` 的根容器 `padding-top` 用 `var(--ad-safe-top, env(safe-area-inset-top))`，因为 WebView 在 edge-to-edge 下的 `env()` 不一定含状态栏）、`show_attention`（后台提醒通知）、`cancel_attention({ id })`（取消一条已发出的提醒通知，别处处理审批后撤回）、`notification_status`、`take_launch_target`，以及插件事件 `notificationClicked`。移动端 Tauri 会把 Rust 没处理的 `plugin:native|xxx` 按 lowerCamelCase 直接转给 Kotlin 同名方法，所以 Rust 侧只做 `register_android_plugin` 与 ACL 声明（`build.rs` 的 `InlinedPlugin` + `capabilities/background.json`）。JS 包装在 `web/src/mobile/native/native-plugin.ts`，非 Tauri 环境全部 no-op。

**保持连接的启停时机**（`native/keepalive-controller.ts`）：选「连上就启动、断开就停」，而不是「进后台再启动」。原因：Android 12+ 禁止 App 在后台启动前台服务，而 `visibilitychange → hidden` 触发时 Activity 已经 stop，此时 `startForegroundService` 会抛 `ForegroundServiceStartNotAllowedException`；在前台、连接刚建立时启动最可靠。代价只是前台期间也有一条静音低优先级常驻通知。规则（设置页「后台保持连接」开关默认开，localStorage 持久化）：本次运行中第一次连上才启动；启动后短暂断线（自动重连中）保持服务，只把常驻通知文案从「AgentDeck 已连接：<电脑名>」改成「重连中」；用户断开 / 删除电脑、凭据失效、关闭开关、切换电脑时停止。`wakeLock` 参数默认关，仅作为锁屏后 CPU 休眠导致断连时的备用手段（目前没有界面入口）。

**前台服务被系统杀后重启**：`KeepAliveService` 改为 `START_NOT_STICKY`，并在 `onStartCommand` 收到 null intent（旧版本遗留的 sticky 重启，不带 extras）时直接 `stopSelf`。原因：进程被杀后与电脑的连接早已不在，必须由前端重建，系统重启出来的服务只会显示一条假的「AgentDeck 已连接」；Android 12+ 后台启动前台服务本就受限。二选一里选 NOT_STICKY 为主、stopSelf 兜底。

**华为的审批通知不弹横幅**：华为会把「待审批」channel 降为 importance 3，不弹横幅。设置页「后台运行」小节加了通用引导文案（各机型开关名称不同：「横幅通知」/「悬浮通知」），并提供「打开通知设置」按钮（`NativePlugin.openAppNotificationSettings` → `Settings.ACTION_APP_NOTIFICATION_SETTINGS`；不支持时依次退到「待审批」channel 设置、应用详情页）。不直接打开 channel 设置，因为华为会把它重定向到只有「允许通知 / 静默通知 / 锁屏通知」的「社交通讯」分组页，里面没有横幅开关。

**子代理**（真机测试发现会话页不显示子代理）：会话页状态行接 `useProviderSubagents(agentId)`，与桌面同源（`agent.subagents.list` + `agent.subagents.update` 通知，远程白名单已放行 `agent.subagents.list / timeline`）。点状态行的子代理药丸列表后，hash 路由变为 `#/s/<agentId>/sub/<subagentId>`，会话页**不卸载**（保留时间线窗口与滚动），页面内盖一层全屏只读子代理时间线（复用桌面 `SubagentPanelBody`，`data-testid="subagent-panel-timeline"`）；孙代理继续 push 同形态的路由，Android 返回键 / 右上角 X 都是 `history.back` 逐级回退。后台任务（backgroundTasks）手机端暂不显示。

**长会话卡顿**（真机测试：向前分页加载完整个 5000+ 条会话后约 3 万 DOM 节点，滑动帧耗时 p95 76ms、14 个长任务）：没有做真正的列表虚拟化，而是给会话详情加了「同时渲染消息数上限」（`MAX_RENDERED` = 400）。选它的理由：虚拟化要改 `MessageTimeline` 内部的滚动贴底 / 前插补偿 / 轮次导航 / 搜索定位，这些逻辑桌面共用，而变高行（Markdown、代码块、工具卡）的高度估算在真机上很难调稳，风险大且没有真机无法验证；折叠方案只动 `SessionDetail`，效果确定（DOM 节点数有硬上限，有单测）。做法：首屏 60 条、「显示更早」每次 +100 条原地展开；再展开会超过上限时，改为「较早的消息」视图——只渲染更早的一段（与刚看过的部分重叠 20 条衔接），时间线换 key 重挂按首次渲染贴底，顶部提示条「正在查看较早的消息 · 返回最新」；发送 / 插话 / 来了待审批时自动回到最新。没有新增依赖。

**后台页面保活**（真机测试发现）：放行华为后台设置后进程不再被 freezer 冻结（cgroup 始终 `freezer:/`），但切后台约 5 分钟后 WebView 页面 JS 整体停止，超过 5 分钟的通知不再触发。推断原因：`WryActivity.onPause` 调 `webView.onPause()`，Activity stop 后窗口可见性又变为 INVISIBLE，Chromium 把页面视为不可见，后台定时器限流（1 次/秒 → 5 分钟后 1 次/分钟）并最终冻结。`generated/` 下的 WryActivity 每次构建都会被 wry 重新生成，不能改，所以在 `MainActivity.kt`（手改）里补：「后台保持连接」开启且已连接（`KeepAliveService.active`，服务 onStartCommand / onDestroy 维护）时，① `onPause` 后立刻 `webView.onResume()` + `resumeTimers()`；② `onStop` 后延迟几次把窗口可见性重新派发为 VISIBLE（`dispatchWindowVisibilityChanged`，系统的 INVISIBLE 在 stop 之后的下一次 traversal 才派发）；③ `setRendererPriorityPolicy(IMPORTANT, waivedWhenNotVisible=false)`，渲染进程优先级不随不可见降级。WebView 拿不到字段（`mWebView` 是 private），改为 override `onWebViewCreate` 自己持有。Chromium 没有「关闭后台节流」的 `WebSettings`，所以只能让页面保持「可见」。**代价**：后台时 `document.visibilityState` 也是 `visible`，前端的前台 / 后台改由 `NativePlugin` 的 `appState`（Activity onResume=前台、onStop=后台，命令 `app_state` + 事件 `appState`）提供，见 `native/app-state.ts`；回前台时用它触发 `SidecarClient.hintWake()`（连着就探活、断着就重连）。**这条路没有自动化测试能覆盖**，复测方法见最终回报；若真机仍在约 5 分钟后停摆，说明 Chromium 的冻结不受可见性欺骗影响，只剩「Kotlin 原生 WS 只收 attention」方案。

**断线期间发送不再误报失败**（真机测试发现）：页面被系统挂起期间发出的 prompt，回前台后会收到「与 Agent 服务的连接已断开」，但服务端回合其实已执行，用户可能因此重复发送。协议不变（sidecar 写入时间线的 `user_message` 本来就带 `clientMessageId`，`agent.send` / `agent.steer` 的 `clientMessageId` 原样落入）：`SidecarClient` 区分「请求发出后连接断开」（`SidecarConnectionLostError`，结果未知）与未连接 / RPC 错误 / 超时；`sendPrompt` / `steerPrompt` 遇到前者时调 `confirmUserMessage`——重连并按 `sinceSeq` 补齐该会话时间线，若已有同 `clientMessageId` 的 `user_message` 就按成功处理（不报错、不追加失败提示、不回填输入框），没有才按原样报错；重连仍失败（结果未知）也按原样报错。桌面共用同一段逻辑。

**回前台快速恢复**（`SidecarClient` 新增可选 `livenessProbe`，只有手机端配置，桌面行为不变）：`visibilitychange → visible`、`online`、Network Information API 的 `change` 触发检查；连接看起来还开着但距最后一次收到数据超过 15 秒，立即发 `sidecar.info`，**10 秒内没有收到任何入站帧**（不必是 `sidecar.info` 的回应，流式事件、RPC 错误都算存活）就 `forceReconnect`，不等 TCP 自然超时。时钟跳变 watchdog 的间隔超过 5 秒时，手机端（配置了 `livenessProbe`）**一律只探活、不强制重连**：后台时（默认看 `document.visibilityState`，手机壳里由 `isBackground` 改读原生前后台状态）多半只是浏览器把后台定时器限速到每分钟一次（真机上曾因此每 60 秒断开重连一次），前台时则可能只是主线程卡顿 3 秒以上（长会话首屏、解密大帧、`JSON.parse`，曾因此误判重连）；都不等于连接已死。探活为空闲超过阈值才发 `sidecar.info`，10 秒无任何入站帧才重连。`online` / 回前台 / 网络切换在连接**正在建立**（CONNECTING）时不打断在途连接，由连接超时兜底。桌面（未配置 `livenessProbe`）行为不变，时钟跳变仍无条件强制重连。E2EE 连接建立（认证成功）之后若发生协议错误（解密失败、帧计数回退、收到文本帧），`E2eeSocket` 会真正关闭该连接（close code 1011，reason `protocol_error:<原因>`），由 `SidecarClient` 走正常的 onclose → 退避重连，不再留下只丢弃入站帧的半死连接。重连后沿用 `sinceSeq` 补齐；补齐期间 `client.syncing` 为 true，界面顶部显示轻量的「正在同步…」，结束自动消失。

**本地通知**：sidecar 总是向手机发 `client.attention`，是否提醒由设置页「通知」三档决定（`always` 默认 / `foreground` / `never`，存 localStorage 的偏好里，见 design.md 4.31 表格）。`always` 时 App 在后台（`document.visibilityState !== "visible"`）收到 → `BackgroundNotifier` 按 `id` 去重后调用 `show_attention`；前台规则：当前会话忽略 / 其它页面弹提示条；`foreground` 后台不通知；`never` 都不提醒。三个 channel：`agentdeck_permission`（待审批，高优先级）、`agentdeck_result`（完成 / 失败）、`agentdeck_schedule`（定时任务）；前台服务常驻通知用独立的 `agentdeck_keepalive`（低优先级静音）。首次连上电脑（App 在前台）时用 `tauri-plugin-notification` 的 `requestPermission` 申请 Android 13+ 通知权限，被拒后设置页显示状态并引导去系统设置。**点击跳转**：`tauri-plugin-notification` 2.6.0 在 Android 上的点击回调 payload 不含自定义 extra 和通知 id（`sourceJson` 从未赋值），无法知道该开哪个会话，所以提醒通知由 `NativePlugin` 自己发，`PendingIntent` 带 `agentId`；App 存活时经 `onNewIntent` → 事件 `notificationClicked` → 前端导航，进程被杀后冷启动经 `take_launch_target` 取走一次。

**图片附件**：输入区「图片」按钮 →「拍照 / 相册」，用 `<input type="file" accept="image/*">`（拍照加 `capture="environment"`）。wry 的 `RustWebChromeClient.onShowFileChooser` 原生支持文件选择与拍照（相机权限由 barcode-scanner 合并进 Manifest，拍照走 FileProvider），无需额外插件。发送前压缩：长边 ≤ 2048px、JPEG 质量 0.85（透明底铺白）、压缩后单张 > 5MB 拒绝；最多 4 张，可预览可删除；按 `{ type: "image", data, mimeType }` 发送，运行中插话（`agent.steer` 的 prompt 同为 `AgentPromptInput`）也允许带图。协议里没有「provider 支持图片」的能力字段（`ProviderCapabilities` 只有 steer / fork），不预先禁用按钮，带图发送失败时在错误后补一句「如果当前 Agent 不支持图片，请去掉图片后重试」，并保留文字与图片草稿。

**后台运行引导**：设置页「后台运行」小节显示通知开关与电池优化状态（回前台自动刷新）、「请求忽略电池优化」「打开应用设置」按钮、华为 / 荣耀、小米、OPPO / vivo 的自启动 / 后台活动 / 锁定最近任务指引，以及「被系统冻结时回到 App 自动补齐，不会丢消息」的说明；首次开启「后台保持连接」后连上电脑时弹一次引导对话框。

**真机验证清单（M3）**：锁屏 10 分钟内收到完成 / 审批通知；点通知（App 在后台 / 被杀后）跳转到对应会话；Wi-Fi ↔ 移动网络（Tailscale）切换后会话不丢且无重复消息；切后台被冻结后回到前台能在数秒内重连并补齐，「正在同步…」出现后消失；拍照 / 相册选图并发送；放行自启动 / 电池优化后后台存活是否改善。

## 8. 构建 release APK（签名、明文 ws、混淆）

**签名密钥在仓库外**：默认 `~/.agentdeck/android/`（Windows 上即 `C:/Users/<用户>/.agentdeck/android/`），含 `agentdeck-release.jks`（别名 `agentdeck`，RSA 4096，有效期 10000 天，DN `CN=AgentDeck, O=AgentDeck`）、`keystore.properties`（`storePassword` / `keyPassword` / `keyAlias` / `storeFile`）与 `README.txt`。**务必备份**：密钥丢失后新版本无法覆盖安装已装的版本，只能卸载重装，配对数据随之丢失。仓库里不放任何密码，`.gitignore` 已忽略 `keystore.properties`、`*.jks`、`*.keystore`。首次生成：

```bash
keytool -genkeypair -v -keystore agentdeck-release.jks -alias agentdeck -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=AgentDeck, O=AgentDeck" -storetype PKCS12
```

`mobile/gen/android/app/build.gradle.kts` 读取签名配置：优先环境变量 `AGENTDECK_ANDROID_KEYSTORE_PROPERTIES` 指向的文件，否则 `<user.home>/.agentdeck/android/keystore.properties`。文件不存在时，release 的 `assemble` / `bundle` / `package` 任务会直接报错并提示放置位置；debug 构建不受影响。

**构建步骤**（环境同 debug：NDK `29.0.14206865`、`ANDROID_HOME=C:/Users/<用户>/AppData/Local/Android/Sdk`、JDK 用 `C:/Program Files/Zulu/zulu-17`）。Windows 没开开发者模式时，`tauri android build` 在「把 .so 符号链接到 jniLibs」一步会失败，所以让它只负责编 Rust，再手动复制 `.so` 并直接跑 gradle：

```bash
cd web && pnpm build:mobile                                   # 必须先构建手机前端
cd ../mobile
../node_modules/.bin/tauri android build --target aarch64 --apk || true   # 编 Rust 并刷新 tauri.properties 的版本号，symlink 失败可忽略
mkdir -p gen/android/app/src/main/jniLibs/arm64-v8a
cp target/aarch64-linux-android/release/libagentdeck_mobile_lib.so gen/android/app/src/main/jniLibs/arm64-v8a/
cd gen/android && ./gradlew assembleArm64Release -x rustBuildArm64Release
# 产物：mobile/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release.apk
```

整套脚本见（gitignore 的）`tmp/build-apk-release.sh`。验证：`apksigner verify --verbose --print-certs <apk>`（build-tools 里）看证书 DN 为 `CN=AgentDeck, O=AgentDeck`；`aapt2 dump badging <apk>` 看 `versionName` / `versionCode`（0.3.0 → 3000，由 `tauri.conf.json` 的 version 经 `tauri.properties` 生成）。注意：APK 只带 v2 签名（minSdk 24，AGP 默认不加 v1），Android 7.0+ 均可安装；与 debug 版签名不同，**已装 debug 版的手机必须先卸载才能装 release 版**，配对数据会丢失。华为等带「隐私空间 / 应用分身」的手机，桌面卸载只移除当前用户，其它用户空间里的旧包仍在，安装会继续报签名不一致：用 `adb shell pm list packages -u | grep agentdeck` 检查，`adb uninstall local.agentdeck.mobile` 会从所有用户空间移除。

**release 放行明文 ws 的原因**：手机经局域网 / Tailscale 以 `ws://<电脑IP>:47631` 直连电脑网关，IP 段无法用 `domain-config` 限定；传输内容已是 tweetnacl 端到端加密，明文通道本身不泄露内容。放行依靠 `AndroidManifest.xml` 的 `android:networkSecurityConfig="@xml/network_security_config"`（`base-config cleartextTrafficPermitted="true"`，debug / release 共用）。该属性在 API 24+ 优先于 `usesCleartextTraffic`；Tauri 生成的 `manifestPlaceholders["usesCleartextTraffic"]` 默认 release 为 `false`，当前清单并未引用该占位符，为避免日后有人引用而误关，release 里也显式设为 `"true"`。

**混淆与压缩**：release 开启 `isMinifyEnabled`（R8）。`tauri-android` 自带的 consumer rules 已按注解保留 `@TauriPlugin` 的 `@Command` 方法与 `@InvokeArg` 类（`CancelAttentionArgs` 等经 `parseArgs` 反射），`generated/proguard-wry.pro` 保留 wry 的 JNI 入口；仍在 `proguard-rules.pro` 为 `local.agentdeck.mobile` 的 `NativePlugin`、`*Args`、`MainActivity`、`KeepAliveService` 补了显式 keep，并保留行号信息。核对方法：构建后看 `app/build/outputs/mapping/arm64Release/mapping.txt`，插件类、Args 类与全部 `@Command` 方法名应原样保留（如 `keepaliveStart`、`cancelAttention`）。
