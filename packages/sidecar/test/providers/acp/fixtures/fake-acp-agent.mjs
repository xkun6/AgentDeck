// 测试用假 ACP agent：用 SDK 的 AgentSideConnection + ndJsonStream 实现，`process.execPath` 运行。
//
// 剧本选择：prompt 第一段文本形如 `scenario:<name>` 时用该剧本，否则用环境变量 FAKE_ACP_SCENARIO，默认 echo。
// 环境变量：
//   FAKE_ACP_LOAD_SESSION=1   声明 loadSession 能力
//   FAKE_ACP_IMAGE=1          声明 promptCapabilities.image
//   FAKE_ACP_NOISE=1          启动时往 stdout 打一行非 JSON（验证容错）
//   FAKE_ACP_FAIL_SET_MODEL=1 unstable_setSessionModel 返回 method not found
//   FAKE_ACP_NO_MODES=1       newSession 不返回 modes / models
//   FAKE_ACP_MCP_HTTP=1       声明 mcpCapabilities.http
//   FAKE_ACP_MCP_LOG=<file>   newSession / loadSession 收到的 mcpServers 追加写入该文件（每行一个 JSON）
//   FAKE_ACP_THOUGHT=1        返回 thought_level 配置项（同 DeepSeek Harness：reasoning_effort，默认 high），
//                             支持 session/set_config_option，echo 回显当前档位
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
} from "@agentclientprotocol/sdk";

const env = process.env;
const MODES = [
  { id: "default", name: "默认", description: "需要审批" },
  { id: "plan", name: "计划" },
];
const THOUGHT_VALUES = [
  { value: "off", name: "Off", description: "不思考" },
  { value: "low", name: "Low" },
  { value: "high", name: "High" },
  { value: "max", name: "Max" },
];
const MODELS = [
  { modelId: "fake-small", name: "Fake Small" },
  { modelId: "fake-large", name: "Fake Large", description: "更大" },
];

if (env.FAKE_ACP_NOISE === "1") {
  process.stdout.write("fake-acp-agent banner: not json\n");
}

class FakeAgent {
  constructor(conn) {
    this.conn = conn;
    this.sessions = new Map();
    this.counter = 0;
  }

  async initialize() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: env.FAKE_ACP_LOAD_SESSION === "1",
        mcpCapabilities: { http: env.FAKE_ACP_MCP_HTTP === "1", sse: false },
        promptCapabilities: { image: env.FAKE_ACP_IMAGE === "1" },
      },
      agentInfo: { name: "fake-acp-agent", version: "0.0.1" },
      authMethods: [],
    };
  }

  logMcp(method, params) {
    if (env.FAKE_ACP_MCP_LOG) {
      appendFileSync(env.FAKE_ACP_MCP_LOG, JSON.stringify({ method, mcpServers: params.mcpServers }) + "\n");
    }
  }

  async authenticate() {
    return {};
  }

  configOptions(state) {
    return [
      {
        id: "reasoning_effort",
        name: "Reasoning effort",
        category: "thought_level",
        type: "select",
        currentValue: state.thought,
        options: THOUGHT_VALUES,
      },
    ];
  }

  sessionState(sessionId) {
    const state = this.sessions.get(sessionId);
    const config = env.FAKE_ACP_THOUGHT === "1" ? { configOptions: this.configOptions(state) } : {};
    if (env.FAKE_ACP_NO_MODES === "1") {
      return config;
    }
    return {
      modes: { availableModes: MODES, currentModeId: state.mode },
      models: { availableModels: MODELS, currentModelId: state.model },
      ...config,
    };
  }

  async setSessionConfigOption(params) {
    const state = this.requireSession(params.sessionId);
    if (env.FAKE_ACP_THOUGHT !== "1" || params.configId !== "reasoning_effort") {
      throw RequestError.invalidParams({ configId: params.configId }, "未知配置项");
    }
    if (!THOUGHT_VALUES.some((option) => option.value === params.value)) {
      throw RequestError.invalidParams({ value: params.value }, "未知档位");
    }
    state.thought = params.value;
    return { configOptions: this.configOptions(state) };
  }

  async newSession(params) {
    this.logMcp("session/new", params);
    this.counter += 1;
    const sessionId = `fake-session-${this.counter}`;
    this.sessions.set(sessionId, { mode: "default", model: "fake-small", thought: "high", cwd: params.cwd, cancel: null });
    return { sessionId, ...this.sessionState(sessionId) };
  }

  async loadSession(params) {
    this.logMcp("session/load", params);
    if (env.FAKE_ACP_LOAD_SESSION !== "1") {
      throw RequestError.methodNotFound("session/load");
    }
    this.sessions.set(params.sessionId, { mode: "plan", model: "fake-small", thought: "high", cwd: params.cwd, cancel: null });
    // 重放历史（客户端应忽略）
    await this.update(params.sessionId, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "历史问题" },
    });
    await this.update(params.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "历史回答" },
    });
    return this.sessionState(params.sessionId);
  }

  async setSessionMode(params) {
    const state = this.requireSession(params.sessionId);
    if (!MODES.some((mode) => mode.id === params.modeId)) {
      throw RequestError.invalidParams({ modeId: params.modeId }, "未知模式");
    }
    state.mode = params.modeId;
    return {};
  }

  async unstable_setSessionModel(params) {
    if (env.FAKE_ACP_FAIL_SET_MODEL === "1") {
      throw RequestError.methodNotFound("session/set_model");
    }
    const state = this.requireSession(params.sessionId);
    state.model = params.modelId;
    return {};
  }

  async cancel(params) {
    const state = this.sessions.get(params.sessionId);
    state?.cancel?.();
  }

  requireSession(sessionId) {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw RequestError.resourceNotFound(sessionId);
    }
    return state;
  }

  update(sessionId, update) {
    return this.conn.sessionUpdate({ sessionId, update });
  }

  waitForCancel(state) {
    return new Promise((resolve) => {
      state.cancel = () => {
        state.cancel = null;
        resolve();
      };
    });
  }

  async prompt(params) {
    const { sessionId, prompt } = params;
    const state = this.requireSession(sessionId);
    const firstText = prompt.find((block) => block.type === "text")?.text ?? "";
    const match = /^scenario:(\S+)/.exec(firstText);
    const scenario = match ? match[1] : (env.FAKE_ACP_SCENARIO ?? "echo");
    const say = (text, messageId) =>
      this.update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
        ...(messageId ? { messageId } : {}),
      });

    // 有的 agent 会回显用户消息，客户端必须忽略
    await this.update(sessionId, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: firstText },
    });

    switch (scenario) {
      case "echo": {
        const images = prompt.filter((block) => block.type === "image").length;
        await say("你好，");
        await say(`世界（图片数:${images}，模式:${state.mode}，模型:${state.model}）`);
        if (env.FAKE_ACP_THOUGHT === "1") {
          await say(`思考:${state.thought}`);
        }
        await this.update(sessionId, {
          sessionUpdate: "usage_update",
          size: 200000,
          used: 1234,
          cost: { amount: 0.01, currency: "USD" },
        });
        return {
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, cachedReadTokens: 5 },
        };
      }
      case "slowecho": {
        // 首个输出之后 1.2 秒才结束回合，用于输出速度（design.md 4.30）
        await say("慢");
        await new Promise((resolve) => setTimeout(resolve, 1200));
        return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } };
      }
      case "thought": {
        await this.update(sessionId, {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "先想一想" },
        });
        await this.update(sessionId, {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "……想好了" },
        });
        await say("答案", "msg-1");
        return { stopReason: "end_turn" };
      }
      case "tools": {
        await say("开始干活");
        await this.update(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "call-exec",
          title: "Run ls",
          kind: "execute",
          status: "pending",
          rawInput: { command: "ls", args: ["-la"] },
        });
        await this.update(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-exec",
          status: "in_progress",
        });
        await this.update(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-exec",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "file.txt" } }],
          rawOutput: { exitCode: 0 },
        });
        await this.update(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "call-edit",
          title: "Edit a.txt",
          kind: "edit",
          status: "in_progress",
          locations: [{ path: "/repo/a.txt" }],
          content: [{ type: "diff", path: "/repo/a.txt", oldText: "old line", newText: "new line" }],
        });
        await this.update(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-edit",
          status: "completed",
        });
        await this.update(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "call-read",
          title: "Read missing.txt",
          kind: "read",
          status: "failed",
          locations: [{ path: "/repo/missing.txt" }],
          rawOutput: { message: "文件不存在" },
        });
        await say("干完了");
        return { stopReason: "end_turn" };
      }
      case "plan": {
        await this.update(sessionId, {
          sessionUpdate: "plan",
          entries: [
            { content: "第一步", priority: "high", status: "completed" },
            { content: "第二步", priority: "medium", status: "in_progress" },
            { content: "第三步", priority: "low", status: "pending" },
          ],
        });
        return { stopReason: "end_turn" };
      }
      case "thoughtupdate": {
        // agent 自己改了档位：发 config_option_update
        state.thought = "max";
        await this.update(sessionId, { sessionUpdate: "config_option_update", configOptions: this.configOptions(state) });
        return { stopReason: "end_turn" };
      }
      case "commands": {
        // available_commands_update：含重名项（缺 name 的项会被 SDK 的 schema 校验整条拒绝，不在此模拟）
        await this.update(sessionId, {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "init", description: "初始化项目" },
            { name: "review", description: "审查改动", input: { hint: "<文件>" } },
            { name: "init", description: "重名" },
          ],
        });
        return { stopReason: "end_turn" };
      }
      case "mode": {
        state.mode = "plan";
        await this.update(sessionId, { sessionUpdate: "current_mode_update", currentModeId: "plan" });
        return { stopReason: "end_turn" };
      }
      case "permission": {
        await this.update(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "call-perm",
          title: "rm -rf build",
          kind: "execute",
          status: "pending",
          rawInput: { command: "rm -rf build" },
        });
        const cancelled = this.waitForCancel(state);
        const response = await this.conn.requestPermission({
          sessionId,
          toolCall: { toolCallId: "call-perm" },
          options: [
            { optionId: "opt-allow-once", name: "允许一次", kind: "allow_once" },
            { optionId: "opt-allow-always", name: "总是允许", kind: "allow_always" },
            { optionId: "opt-reject", name: "拒绝", kind: "reject_once" },
          ],
        });
        if (response.outcome.outcome === "cancelled") {
          await cancelled;
          return { stopReason: "cancelled" };
        }
        const optionId = response.outcome.optionId;
        if (optionId.startsWith("opt-allow")) {
          await this.update(sessionId, {
            sessionUpdate: "tool_call_update",
            toolCallId: "call-perm",
            status: "completed",
          });
          await say(`已允许:${optionId}`);
          return { stopReason: "end_turn" };
        }
        await this.update(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-perm",
          status: "failed",
          rawOutput: "用户拒绝",
        });
        // 被拒后若客户端紧接着发 cancel（interrupt=true），按 cancelled 结束
        const outcome = await Promise.race([
          cancelled.then(() => "cancelled"),
          new Promise((resolve) => setTimeout(() => resolve("timeout"), 300)),
        ]);
        if (outcome === "cancelled") {
          return { stopReason: "cancelled" };
        }
        await say(`已拒绝:${optionId}`);
        return { stopReason: "end_turn" };
      }
      case "slow": {
        await say("处理中");
        await this.update(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "call-slow",
          title: "sleep 100",
          kind: "execute",
          status: "in_progress",
          rawInput: { command: "sleep 100" },
        });
        await this.waitForCancel(state);
        return { stopReason: "cancelled" };
      }
      case "hang": {
        // 收到 cancel 也不返回，逼客户端走 5 秒强制结束
        await say("卡住了");
        await new Promise(() => undefined);
        return { stopReason: "end_turn" };
      }
      case "refusal": {
        await say("不行");
        return { stopReason: "refusal" };
      }
      case "error": {
        throw RequestError.internalError({ details: "假 agent 内部错误" });
      }
      case "crash": {
        await say("要崩了");
        process.stderr.write("fake agent boom\n");
        setTimeout(() => process.exit(3), 20);
        await new Promise(() => undefined);
        return { stopReason: "end_turn" };
      }
      default:
        throw RequestError.invalidParams({ scenario }, "未知剧本");
    }
  }
}

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new AgentSideConnection((conn) => new FakeAgent(conn), stream);
