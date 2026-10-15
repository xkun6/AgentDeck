// 测试用假 claude：按 Claude Code CLI 的 stream-json stdio 协议回放固定脚本。
// 用户消息文本决定场景：
//   hello        → system init + stream_event 增量 + assistant + result
//   perm:<Tool>  → 发 can_use_tool 控制请求，收到应答后把应答原样写进 assistant 文本，再发 result
//   cancel-perm  → 发 can_use_tool 后紧接着发 control_cancel_request，收到应答后同上
//   elicit:form | elicit:url | elicit:cancel → 发 MCP elicitation 控制请求（表单 / 浏览器链接 / 发出后紧接 control_cancel_request），
//                  收到应答后把应答原样写进 assistant 文本；url 场景应答后再发 system elicitation_complete
//   perm-sugg    → 发带 permission_suggestions / suppress_always_allow_rule / default_to_no / blocked_path 的 can_use_tool
//   hang         → 只发 system init，等 interrupt 控制请求后以 error_during_execution 结束本轮
//   crash        → stderr 打印错误并以退出码 3 退出
//   noisy        → 先输出一行非 JSON，再按 hello 回复
//   subagent     → Agent 工具派出子代理：task_* 公告 + 带 parent_tool_use_id 的 sidechain 帧，
//                  另有一个应被过滤的 local_bash task 及其帧，最后父消息回 tool_result 并 result
//   background   → 派出后台子代理并启动一条后台命令，回复「已派出」并 result；稍后无输入地自行开始一轮
//                  （CLI 自发轮次，design.md 4.12）：task_notification（子代理 + 后台命令）→ init → 文本 → 不带
//                  user_message_uuid 的 result，随后一个 init + 空 result 的空轮。自发轮次进行中收到的用户消息排队，
//                  等这一轮结束后再处理（同真实 CLI）
//   background-race → 同上，但自发轮次输出第一段文本后停住，直到收到下一条用户消息才结束
// 环境变量 FAKE_CLAUDE_SILENT=1 时忽略所有控制请求（用于测试超时）。
import readline from "node:readline";

const SESSION_ID = "fake-session-0001";
const silent = process.env.FAKE_CLAUDE_SILENT === "1";
const argv = process.argv.slice(2);
const pendingResponses = new Map();
let initSent = false;
let hangingUuid = null;
let counter = 0;
/** 自发轮次进行中：用户消息排队 */
let backgroundBusy = false;
const queuedUsers = [];
/** background-race：自发轮次等用户消息到达后再结束 */
let resumeBackground = null;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function ensureInit() {
  if (initSent) return;
  initSent = true;
  send({ type: "system", subtype: "init", session_id: SESSION_ID, model: "fake", permissionMode: "default" });
}

function reply(uuid, text) {
  const id = `msg_${++counter}`;
  send({
    type: "stream_event",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    event: { type: "message_start", message: { id, usage: { input_tokens: 3, cache_read_input_tokens: 7 } } },
  });
  for (const part of [text.slice(0, 2), text.slice(2)]) {
    send({
      type: "stream_event",
      parent_tool_use_id: null,
      session_id: SESSION_ID,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } },
    });
  }
  send({
    type: "assistant",
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    message: { id, role: "assistant", content: [{ type: "text", text }] },
  });
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    session_id: SESSION_ID,
    user_message_uuid: uuid,
    total_cost_usd: 0.001,
    usage: { input_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 0, output_tokens: 2 },
    modelUsage: { fake: { contextWindow: 1000 } },
  });
}

function subagentScenario(uuid) {
  const base = { session_id: SESSION_ID };
  const task = { ...base, type: "system" };
  send({
    ...base,
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      id: "msg_parent_1",
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_task", name: "Agent", input: { subagent_type: "Explore", description: "读 package.json", prompt: "读取 name" } }],
    },
  });
  send({ ...task, subtype: "task_started", task_id: "task_1", tool_use_id: "toolu_task", description: "读 package.json", subagent_type: "Explore", task_type: "local_agent", prompt: "读取 name" });
  // 被过滤的后台 shell 任务：它的帧不应出现在任何地方
  send({ ...task, subtype: "task_started", task_id: "task_bg", tool_use_id: "toolu_bash", description: "sleep", task_type: "local_bash" });
  send({ ...base, type: "assistant", parent_tool_use_id: "toolu_bash", message: { id: "msg_bg", role: "assistant", content: [{ type: "text", text: "后台杂务" }] } });
  send({
    ...base,
    type: "assistant",
    parent_tool_use_id: "toolu_task",
    message: { id: "msg_sub_1", role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "package.json" } }] },
  });
  send({ ...task, subtype: "task_progress", task_id: "task_1", usage: { total_tokens: 1234 } });
  send({
    ...base,
    type: "user",
    parent_tool_use_id: "toolu_task",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read", content: '{"name":"demo"}' }] },
  });
  send({ ...base, type: "assistant", parent_tool_use_id: "toolu_task", message: { id: "msg_sub_2", role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "name 是 demo" }] } });
  send({ ...task, subtype: "task_notification", task_id: "task_1", tool_use_id: "toolu_task", status: "completed", usage: { total_tokens: 2000 } });
  send({
    ...base,
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_task", content: [{ type: "text", text: "name 是 demo" }] }] },
  });
  reply(uuid, "子代理回报 name 是 demo");
}

function backgroundScenario(uuid, race) {
  const base = { session_id: SESSION_ID };
  send({
    ...base,
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      id: "msg_bg_launch",
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_bg_agent", name: "Agent", input: { subagent_type: "general-purpose", description: "读 package.json", prompt: "读取 name", run_in_background: true } },
        { type: "tool_use", id: "toolu_bg_bash", name: "Bash", input: { command: "sleep 1", run_in_background: true } },
      ],
    },
  });
  send({ ...base, type: "system", subtype: "task_started", task_id: "task_bg_agent", tool_use_id: "toolu_bg_agent", description: "读 package.json", subagent_type: "general-purpose", task_type: "local_agent", is_backgrounded: true, prompt: "读取 name" });
  send({ ...base, type: "system", subtype: "task_started", task_id: "task_bg_bash", tool_use_id: "toolu_bg_bash", description: "sleep 1", task_type: "local_bash" });
  send({
    ...base,
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_bg_agent", content: [{ type: "text", text: "Async agent launched successfully." }] },
        { type: "tool_result", tool_use_id: "toolu_bg_bash", content: "Command running in background with ID: task_bg_bash" },
      ],
    },
  });
  reply(uuid, "已派出");
  setTimeout(() => {
    backgroundBusy = true;
    send({ ...base, type: "system", subtype: "task_updated", task_id: "task_bg_agent", patch: { status: "completed" } });
    send({ ...base, type: "system", subtype: "task_notification", task_id: "task_bg_agent", tool_use_id: "toolu_bg_agent", status: "completed", summary: "name 是 demo", usage: { total_tokens: 500 } });
    send({ ...base, type: "system", subtype: "task_notification", task_id: "task_bg_bash", tool_use_id: "toolu_bg_bash", status: "completed", summary: 'Background command "sleep 1" completed (exit code 0)', output_file: "C:\\tmp\\task_bg_bash.output" });
    // 真实 CLI 每开始一轮都先发 init
    send({ type: "system", subtype: "init", session_id: SESSION_ID, model: "fake", permissionMode: "default" });
    const id = `msg_${++counter}`;
    send({ ...base, type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id, usage: { input_tokens: 1 } } } });
    send({ ...base, type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "子代理回报：" } } });
    const finish = () => {
      send({ ...base, type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "name 是 demo" } } });
      send({ ...base, type: "assistant", parent_tool_use_id: null, message: { id, role: "assistant", content: [{ type: "text", text: "子代理回报：name 是 demo" }] } });
      // 自发轮次没有对应的用户消息：result 不带 user_message_uuid
      send({ type: "result", subtype: "success", is_error: false, result: "子代理回报：name 是 demo", session_id: SESSION_ID, total_cost_usd: 0.002, usage: { input_tokens: 1, output_tokens: 4 } });
      // 真实 CLI 常紧跟一个只有 init + 空 result 的空轮（2.1.296 实测），排队的用户消息在它之后才处理
      send({ type: "system", subtype: "init", session_id: SESSION_ID, model: "fake", permissionMode: "default" });
      send({ type: "result", subtype: "success", is_error: false, result: "", session_id: SESSION_ID, usage: {} });
      backgroundBusy = false;
      for (const queued of queuedUsers.splice(0)) {
        send({ type: "system", subtype: "init", session_id: SESSION_ID, model: "fake", permissionMode: "default" });
        void handleUser(queued);
      }
    };
    if (race) {
      resumeBackground = finish;
    } else {
      finish();
    }
  }, 50);
}

function requestPermission(requestId, toolName, cancel, extra = {}) {
  return new Promise((resolve) => {
    pendingResponses.set(requestId, resolve);
    send({
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "can_use_tool",
        tool_name: toolName,
        input: { file_path: "a.txt", content: "x" },
        tool_use_id: "toolu_1",
        title: `Claude wants to use ${toolName}`,
        ...extra,
      },
    });
    if (cancel) {
      setTimeout(() => send({ type: "control_cancel_request", request_id: requestId }), 30);
    }
  });
}

function requestElicitation(requestId, mode, cancel) {
  return new Promise((resolve) => {
    pendingResponses.set(requestId, resolve);
    send({
      type: "control_request",
      request_id: requestId,
      request: mode === "url"
        ? {
            subtype: "elicitation", mcp_server_name: "oauth", message: "请在浏览器里授权", mode: "url",
            url: "https://example.com/auth", elicitation_id: "elic-1",
          }
        : {
            subtype: "elicitation", mcp_server_name: "forms", message: "请填写表单", mode: "form",
            requested_schema: {
              type: "object",
              properties: { b: { type: "string" }, a: { type: "integer", minimum: 1 } },
              required: ["a"],
            },
            property_order: ["a", "b"],
            title: "表单标题",
          },
    });
    if (cancel) {
      setTimeout(() => send({ type: "control_cancel_request", request_id: requestId }), 30);
    }
  });
}

async function handleUser(message) {
  const uuid = message.uuid;
  const text = message.message?.content?.find?.((block) => block.type === "text")?.text ?? "";
  if (text === "crash") {
    process.stderr.write("fatal: boom\n", () => process.exit(3));
    return;
  }
  ensureInit();
  if (text === "hang") {
    hangingUuid = uuid;
    return;
  }
  if (text === "noisy") {
    process.stdout.write("this is not json\n");
    reply(uuid, "Hello");
    return;
  }
  if (text === "subagent") {
    subagentScenario(uuid);
    return;
  }
  if (text === "background" || text === "background-race") {
    backgroundScenario(uuid, text === "background-race");
    return;
  }
  if (text.startsWith("elicit:")) {
    const kind = text.slice(7);
    const response = await requestElicitation(`elicit-${++counter}`, kind === "url" ? "url" : "form", kind === "cancel");
    if (kind === "url") {
      send({ type: "system", subtype: "elicitation_complete", mcp_server_name: "oauth", elicitation_id: "elic-1" });
    }
    reply(uuid, `decision:${JSON.stringify(response)}`);
    return;
  }
  if (text === "perm-sugg") {
    // 带 permission_suggestions / suppress_always_allow_rule / default_to_no / blocked_path 的 can_use_tool
    const response = await requestPermission(`perm-${++counter}`, "Bash", false, {
      permission_suggestions: [
        { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "git status" }], behavior: "allow", destination: "localSettings" },
      ],
      suppress_always_allow_rule: true,
      default_to_no: true,
      blocked_path: "/outside",
    });
    reply(uuid, `decision:${JSON.stringify(response)}`);
    return;
  }
  if (text.startsWith("perm:") || text === "cancel-perm") {
    const cancel = text === "cancel-perm";
    const response = await requestPermission(`perm-${++counter}`, cancel ? "Bash" : text.slice(5), cancel);
    reply(uuid, `decision:${JSON.stringify(response)}`);
    return;
  }
  reply(uuid, "Hello");
}

function handleControlRequest(message) {
  if (silent) return;
  const { request_id: requestId, request } = message;
  const ok = (response) =>
    send({ type: "control_response", response: { subtype: "success", request_id: requestId, ...(response ? { response } : {}) } });
  switch (request?.subtype) {
    case "initialize":
      // forwardSubagentText 原样回显，便于测试确认 initialize 打开了子代理文本转发
      ok({ models: [{ value: "default", displayName: "Default" }, { value: "haiku", displayName: "Haiku" }], argv, forwardSubagentText: request.forwardSubagentText, perTaskStopAffordance: request.perTaskStopAffordance });
      return;
    case "interrupt":
      ok({ still_queued: [] });
      if (hangingUuid) {
        send({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [],
          session_id: SESSION_ID,
          user_message_uuid: hangingUuid,
          usage: {},
        });
        hangingUuid = null;
      }
      return;
    case "stop_task":
      // 只认识 bk1：其它任务以 error 应答（与真实 CLI 一致）
      if (request.task_id === "bk1") {
        ok({});
      } else {
        send({ type: "control_response", response: { subtype: "error", request_id: requestId, error: `No task found with ID: ${request.task_id}` } });
      }
      return;
    case "set_model":
    case "set_permission_mode":
      ok({ echo: request });
      return;
    case "mcp_status":
      ok({ mcpServers: [{ name: "fs", status: "connected", scope: "user", tools: [{ name: "read" }] }] });
      return;
    case "mcp_reconnect":
      // 只认识 fs：其它服务器以 error 应答（与真实 CLI 一致）
      if (request.serverName === "fs") {
        ok({});
      } else {
        send({ type: "control_response", response: { subtype: "error", request_id: requestId, error: `Server not found: ${request.serverName}` } });
      }
      return;
    default:
      send({
        type: "control_response",
        response: { subtype: "error", request_id: requestId, error: `Unsupported control request subtype: ${request?.subtype}` },
      });
  }
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    handleControlRequest(message);
  } else if (message.type === "control_response") {
    const resolve = pendingResponses.get(message.response.request_id);
    pendingResponses.delete(message.response.request_id);
    resolve?.(message.response);
  } else if (message.type === "user") {
    if (backgroundBusy) {
      queuedUsers.push(message);
      const resume = resumeBackground;
      resumeBackground = null;
      resume?.();
    } else {
      void handleUser(message);
    }
  }
});
lines.on("close", () => process.exit(0));
