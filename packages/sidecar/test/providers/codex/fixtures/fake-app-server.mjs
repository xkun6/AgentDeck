// 假的 `codex app-server`：按行读 JSON-RPC，按剧本回放通知与审批请求（字段形状取自 codex-cli 0.162.1）。
// 用法：node fake-app-server.mjs app-server
// 环境变量：FAKE_CODEX_LOG=<jsonl 路径> 记录收到的每条消息；FAKE_CODEX_INIT_FAIL=1 让 initialize 失败。
// 剧本由 turn/start 输入文本的第一个单词决定：hello / shell / patch / fail / error / hang / crash / plan / compact / compactlegacy / unknownreq / resolved。
// thread/compact/start 按 compact 剧本开一个回合；mcpServerStatus/list 分两页返回三个服务器；config/mcpServer/reload 回 {}。
import { appendFileSync } from "node:fs";
import readline from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.162.1-fake\n");
  process.exit(0);
}

const LOG = process.env.FAKE_CODEX_LOG;
let CWD = "C:\\work"; // thread/start 时替换为客户端传入的 cwd
let THREAD_ID = "thr_fake"; // thread/resume 时替换为被恢复的线程 id
let turnCounter = 0;
let activeTurn = null; // { id, onInterrupt?: () => void }
let serverRequestId = 1000;
const waitingResponses = new Map();

function log(direction, msg) {
  if (LOG) appendFileSync(LOG, `${JSON.stringify({ direction, msg })}\n`);
}

function send(msg) {
  log("out", msg);
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const notify = (method, params) => send({ method, params });
const respond = (id, result) => send({ id, result });
const respondError = (id, code, message) => send({ id, error: { code, message } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 发 server→client 请求并等待客户端应答 */
function serverRequest(method, params) {
  const id = serverRequestId++;
  return new Promise((resolve) => {
    waitingResponses.set(id, resolve);
    send({ id, method, params });
  });
}

function turnObj(id, status, error = null) {
  return { id, rootTurnId: id, items: [], itemsView: "notLoaded", status, error, startedAt: null, completedAt: null, durationMs: null };
}

function completeTurn(turnId, status, error = null) {
  if (activeTurn?.id === turnId) activeTurn = null;
  notify("turn/completed", { threadId: THREAD_ID, turn: turnObj(turnId, status, error) });
}

const base = (turnId) => ({ threadId: THREAD_ID, turnId });

async function agentMessage(turnId, itemId, chunks) {
  notify("item/started", { ...base(turnId), item: { type: "agentMessage", id: itemId, text: "", phase: "final_answer" }, startedAtMs: Date.now() });
  for (const delta of chunks) {
    notify("item/agentMessage/delta", { ...base(turnId), itemId, delta });
  }
  notify("item/completed", { ...base(turnId), item: { type: "agentMessage", id: itemId, text: chunks.join(""), phase: "final_answer" }, completedAtMs: Date.now() });
}

function tokenUsage(turnId) {
  const last = { totalTokens: 120, inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 5 };
  notify("thread/tokenUsage/updated", { ...base(turnId), tokenUsage: { total: last, last, modelContextWindow: 200000 } });
}

const scenarios = {
  async hello(turnId) {
    notify("item/started", { ...base(turnId), item: { type: "reasoning", id: "rs_1", summary: [], content: [] } });
    notify("item/reasoning/summaryTextDelta", { ...base(turnId), itemId: "rs_1", delta: "思考", summaryIndex: 0 });
    notify("item/reasoning/summaryTextDelta", { ...base(turnId), itemId: "rs_1", delta: "中", summaryIndex: 0 });
    notify("item/completed", { ...base(turnId), item: { type: "reasoning", id: "rs_1", summary: ["思考中"], content: [] } });
    // 只有 completed、没有 delta 的推理项：应整段补发
    notify("item/completed", { ...base(turnId), item: { type: "reasoning", id: "rs_2", summary: ["补充推理"], content: [] } });
    await agentMessage(turnId, "msg_1", ["Hel", "lo"]);
    // completed 文本比 delta 多：只补发缺失后缀
    notify("item/agentMessage/delta", { ...base(turnId), itemId: "msg_2", delta: "A" });
    notify("item/completed", { ...base(turnId), item: { type: "agentMessage", id: "msg_2", text: "AB" } });
    tokenUsage(turnId);
    completeTurn(turnId, "completed");
  },

  async shell(turnId) {
    const item = {
      type: "commandExecution", id: "exec_1", command: "\"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe\" -Command 'echo hi'",
      cwd: "C:\\work", processId: "1", source: "unifiedExecStartup", status: "inProgress",
      commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null,
    };
    notify("item/started", { ...base(turnId), item, startedAtMs: Date.now() });
    const answer = await serverRequest("item/commandExecution/requestApproval", {
      kind: "command", ...base(turnId), itemId: "exec_1", startedAtMs: Date.now(), environmentId: null,
      reason: "需要运行命令", command: "echo hi", cwd: "C:\\work",
    });
    const accepted = answer?.result?.decision === "accept";
    notify("item/completed", {
      ...base(turnId),
      item: accepted
        ? { ...item, status: "completed", aggregatedOutput: "hi\r\n", exitCode: 0, durationMs: 5 }
        : { ...item, status: "declined" },
      completedAtMs: Date.now(),
    });
    if (answer?.result?.decision === "cancel") {
      completeTurn(turnId, "interrupted");
      return;
    }
    await agentMessage(turnId, "msg_shell", [accepted ? "done" : "skipped"]);
    completeTurn(turnId, "completed");
  },

  async patch(turnId) {
    const diff = "@@ -1 +1 @@\n-old\n+new\n";
    const item = { type: "fileChange", id: "patch_1", changes: [{ path: `${CWD}\\src\\a.txt`, kind: { type: "update", move_path: null }, diff }], status: "inProgress" };
    notify("item/started", { ...base(turnId), item, startedAtMs: Date.now() });
    const answer = await serverRequest("item/fileChange/requestApproval", { ...base(turnId), itemId: "patch_1", startedAtMs: Date.now(), reason: "写文件", grantRoot: null });
    const accepted = answer?.result?.decision === "accept";
    notify("item/completed", { ...base(turnId), item: { ...item, status: accepted ? "completed" : "declined" }, completedAtMs: Date.now() });
    // 新增文件（内容非 diff）→ write
    notify("item/completed", {
      ...base(turnId),
      item: { type: "fileChange", id: "patch_2", changes: [{ path: `${CWD}\\new.txt`, kind: { type: "add" }, diff: "hello\n" }], status: "completed" },
      completedAtMs: Date.now(),
    });
    completeTurn(turnId, "completed");
  },

  async fail(turnId) {
    completeTurn(turnId, "failed", { message: "boom", codexErrorInfo: "usageLimitExceeded", additionalDetails: null });
  },

  async error(turnId) {
    notify("error", { ...base(turnId), willRetry: true, error: { message: "重连中", codexErrorInfo: null } });
    notify("error", { ...base(turnId), willRetry: false, error: { message: "stream disconnected", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } } });
    completeTurn(turnId, "failed", { message: "stream disconnected" });
  },

  async hang(turnId) {
    activeTurn.onInterrupt = () => completeTurn(turnId, "interrupted");
  },

  async crash() {
    process.stderr.write("fatal: fake crash\n");
    await sleep(10);
    process.exit(3);
  },

  async plan(turnId) {
    notify("turn/plan/updated", {
      ...base(turnId), explanation: null,
      plan: [{ step: "第一步", status: "completed" }, { step: "第二步", status: "inProgress" }],
    });
    completeTurn(turnId, "completed");
  },

  // 上下文压缩：contextCompaction item（started / completed），随后的旧版 thread/compacted 不应重复
  async compact(turnId) {
    const item = { type: "contextCompaction", id: "cc_1" };
    notify("item/started", { ...base(turnId), item, startedAtMs: Date.now() });
    notify("item/completed", { ...base(turnId), item, completedAtMs: Date.now() });
    notify("thread/compacted", base(turnId));
    completeTurn(turnId, "completed");
  },

  // 只有旧版 thread/compacted 通知
  async compactlegacy(turnId) {
    notify("thread/compacted", base(turnId));
    completeTurn(turnId, "completed");
  },

  async unknownreq(turnId) {
    const answer = await serverRequest("item/tool/requestUserInput", { ...base(turnId), itemId: "q1", questions: [] });
    notify("item/completed", {
      ...base(turnId),
      item: { type: "agentMessage", id: "msg_u", text: answer?.error ? `error:${answer.error.code}` : "ok" },
    });
    completeTurn(turnId, "completed");
  },

  // 子代理：子线程通知先于父线程登记到达（应缓冲），登记后回放，随后继续实时路由
  async subagent(turnId) {
    const child = "thr_child";
    const childTurn = "turn_child_1";
    const cb = { threadId: child, turnId: childTurn };
    const collab = { type: "collabAgentToolCall", id: "collab_1", tool: "spawnAgent", prompt: "读取 name", receiverThreadIds: [], agentsStates: {}, status: "inProgress" };
    notify("item/started", { ...base(turnId), item: collab, startedAtMs: Date.now() });
    notify("turn/started", { threadId: child, turn: turnObj(childTurn, "inProgress") });
    notify("item/completed", { ...cb, item: { type: "userMessage", id: "cu_1", content: [{ type: "text", text: "读取 name", text_elements: [] }] } });
    notify("item/agentMessage/delta", { ...cb, itemId: "cm_1", delta: "我来" });
    const exec = { type: "commandExecution", id: "cexec_1", command: "cat package.json", cwd: CWD, processId: "2", source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
    notify("item/started", { ...cb, item: exec, startedAtMs: Date.now() });
    notify("item/completed", { ...cb, item: { ...exec, status: "completed", aggregatedOutput: "{\"name\":\"demo\"}", exitCode: 0, durationMs: 3 }, completedAtMs: Date.now() });
    await sleep(10);
    notify("item/completed", { ...base(turnId), item: { ...collab, status: "completed", receiverThreadIds: [child], agentsStates: { [child]: { status: "running" } } }, completedAtMs: Date.now() });
    notify("item/completed", { ...cb, item: { type: "agentMessage", id: "cm_1", text: "我来读取：name 是 demo" } });
    notify("turn/completed", { threadId: child, turn: turnObj(childTurn, "completed") });
    await agentMessage(turnId, "msg_sub", ["子代理说 name 是 demo"]);
    completeTurn(turnId, "completed");
  },

  async resolved(turnId) {
    const id = serverRequestId;
    void serverRequest("item/commandExecution/requestApproval", {
      kind: "command", ...base(turnId), itemId: "exec_r", startedAtMs: Date.now(), environmentId: null, command: "ls", cwd: "C:\\work",
    });
    await sleep(50);
    notify("serverRequest/resolved", { threadId: THREAD_ID, requestId: id });
    await sleep(50);
    completeTurn(turnId, "completed");
  },
};

async function handleRequest(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      if (process.env.FAKE_CODEX_INIT_FAIL === "1") {
        respondError(id, -32600, "init refused");
        return;
      }
      respond(id, { userAgent: "fake/0.162.1", codexHome: "/tmp/codex", platformFamily: "windows", platformOs: "windows" });
      return;
    case "model/list":
      respond(id, {
        data: [
          {
            id: "gpt-a", model: "gpt-a", displayName: "GPT-A", description: "默认模型", hidden: false, isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [{ reasoningEffort: "low", description: "快" }, { reasoningEffort: "high", description: "深" }],
          },
          { id: "gpt-hidden", model: "gpt-hidden", displayName: "Hidden", description: "", hidden: true, isDefault: false },
          { id: "gpt-b", model: "gpt-b", displayName: "GPT-B", description: "", hidden: false, isDefault: false },
        ],
        nextCursor: null,
      });
      return;
    case "thread/start":
      if (params?.cwd) CWD = params.cwd;
      respond(id, { thread: { id: THREAD_ID }, model: params?.model ?? "gpt-a", cwd: params?.cwd, approvalPolicy: params?.approvalPolicy, sandbox: { type: "readOnly", networkAccess: false } });
      notify("thread/started", { thread: { id: THREAD_ID } });
      return;
    case "thread/resume":
      THREAD_ID = params.threadId;
      if (params?.cwd) CWD = params.cwd;
      respond(id, { thread: { id: params.threadId }, model: "gpt-a" });
      return;
    case "turn/start": {
      const turnId = `turn_${++turnCounter}`;
      activeTurn = { id: turnId };
      respond(id, { turn: turnObj(turnId, "inProgress") });
      const text = params?.input?.find?.((p) => p.type === "text")?.text ?? "";
      const name = text.trim().split(/\s+/)[0] ?? "";
      const scenario = scenarios[name] ?? scenarios.hello;
      await sleep(5);
      notify("turn/started", { threadId: THREAD_ID, turn: turnObj(turnId, "inProgress") });
      await scenario(turnId);
      return;
    }
    case "thread/compact/start": {
      // 手动压缩：应答 {} 后像普通回合一样推 turn/started → contextCompaction item → turn/completed
      const turnId = `turn_${++turnCounter}`;
      activeTurn = { id: turnId };
      respond(id, {});
      await sleep(5);
      notify("turn/started", { threadId: THREAD_ID, turn: turnObj(turnId, "inProgress") });
      await scenarios.compact(turnId);
      return;
    }
    case "mcpServerStatus/list": {
      const server = (name, runtimeStatus, tools, toolsError = null) => ({
        name, runtimeStatus, pluginId: null, httpOrigin: null, serverInfo: null, serverCapabilities: null,
        tools, toolsError, resources: [], resourceTemplates: [], authStatus: "unsupported",
      });
      if (!params?.cursor) {
        respond(id, {
          data: [
            server("fs", "connected", { read: { name: "read" }, write: { name: "write" } }),
            server("gh", "authenticationRequired", {}),
          ],
          nextCursor: "page2",
        });
      } else {
        respond(id, { data: [server("bad", "failed", {}, "spawn ENOENT"), server("slow", null, {})], nextCursor: null });
      }
      return;
    }
    case "account/read":
      // FAKE_CODEX_ACCOUNT=none：未登录；error：读取失败
      if (process.env.FAKE_CODEX_ACCOUNT === "error") { respondError(id, -32000, "boom"); return; }
      respond(id, process.env.FAKE_CODEX_ACCOUNT === "none"
        ? { account: null, requiresOpenaiAuth: true }
        : { account: { type: "chatgpt", email: "dev@example.com", planType: "plus" }, requiresOpenaiAuth: true });
      return;
    case "account/rateLimits/read":
      if (process.env.FAKE_CODEX_ACCOUNT === "error") { respondError(id, -32000, "boom"); return; }
      respond(id, {
        rateLimits: {
          limitId: "codex", limitName: null,
          primary: { usedPercent: 23.4, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 7200 },
          secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: null },
        },
      });
      return;
    case "config/mcpServer/reload":
      respond(id, {});
      return;
    case "turn/interrupt":
      if (!activeTurn || activeTurn.id !== params?.turnId) {
        respondError(id, -32600, "no active turn to interrupt");
        return;
      }
      respond(id, {});
      activeTurn.onInterrupt?.();
      return;
    case "config/read":
      // FAKE_CODEX_CONFIG_EFFORT：模拟 config.toml 里的 model_reasoning_effort
      respond(id, { config: process.env.FAKE_CODEX_CONFIG_EFFORT ? { model_reasoning_effort: process.env.FAKE_CODEX_CONFIG_EFFORT } : {} });
      return;
    default:
      respondError(id, -32601, `unknown method ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  log("in", msg);
  if (msg.method === undefined && msg.id !== undefined) {
    const resolve = waitingResponses.get(msg.id);
    waitingResponses.delete(msg.id);
    resolve?.(msg);
    return;
  }
  if (msg.id === undefined) return; // 通知（initialized）
  void handleRequest(msg);
});
rl.on("close", () => process.exit(0));
