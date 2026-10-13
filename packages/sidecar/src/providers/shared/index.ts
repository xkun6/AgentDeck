// provider 共用模块统一出口（claude / codex / acp 从这里导入）。
// 类型降级约定（协议 ToolCallDetail 为精简版，不得扩展）：
// - paseo 的 sub_agent → { type: "plain_text", label: subAgentType ?? "Agent", text: description / log }
// - paseo 的 worktree_setup → 不产生（AgentDeck 不做 worktree 编排）；如遇到按 plain_text 处理
// - plain_text 的 icon、search 的统计字段、fetch 的 code / bytes 等 → 丢弃
// - 解析不出结构化变体时 → { type: "unknown", input, output }
export * from "./tool-call-mapper-utils.js";
export * from "./tool-call-detail-primitives.js";
export * from "./provider-runner.js";
export * from "./thinking-options.js";
