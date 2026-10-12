// 测试用假 claude：按 Claude Code CLI 的 stream-json stdio 协议回放固定脚本。
// 用户消息文本决定场景：
//   hello        → system init + stream_event 增量 + assistant + result
//   perm:<Tool>  → 发 can_use_tool 控制请求，收到应答后把应答原样写进 assistant 文本，再发 result
//   cancel-perm  → 发 can_use_tool 后紧接着发 control_cancel_request，收到应答后同上
//   hang         → 只发 system init，等 interrupt 控制请求后以 error_during_execution 结束本轮
//   crash        → stderr 打印错误并以退出码 3 退出
//   noisy        → 先输出一行非 JSON，再按 hello 回复
// 环境变量 FAKE_CLAUDE_SILENT=1 时忽略所有控制请求（用于测试超时）。
import readline from "node:readline";

const SESSION_ID = "fake-session-0001";
const silent = process.env.FAKE_CLAUDE_SILENT === "1";
const argv = process.argv.slice(2);
const pendingResponses = new Map();
let initSent = false;
let hangingUuid = null;
let counter = 0;

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

function requestPermission(requestId, toolName, cancel) {
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
      ok({ models: [{ value: "default", displayName: "Default" }, { value: "haiku", displayName: "Haiku" }], argv });
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
    case "set_model":
    case "set_permission_mode":
      ok({ echo: request });
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
    void handleUser(message);
  }
});
lines.on("close", () => process.exit(0));
