// Computer Use 代理（design.md 4.37）：鉴权、工具转发、防自指、审批分流、出参过滤
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { AgentPermissionRequest, AgentPermissionResponse, SidecarSettings } from "@agentdeck/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, test } from "vitest";

import { ComputerUseProxy, desktopScaleOf, type DriverToolClient } from "../../src/computer-use/proxy.js";
import { COMPUTER_USE_POLICY_DENIED } from "../../src/providers/shared/interop.js";
import {
  KEYBOARD_REFUSAL,
  SELF_REGION_REFUSAL,
  SELF_TARGET_REFUSAL,
} from "../../src/computer-use/self-guard.js";

const HOST_PID = 4242;
const TOKEN = "adi_test";
const AGENT_ID = "agent-1";

const HOST_WINDOW = {
  window_id: 11,
  pid: HOST_PID,
  app_name: "AgentDeck",
  title: "AgentDeck",
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  is_on_screen: true,
  z_index: 2,
};
const NOTEPAD_WINDOW = {
  window_id: 22,
  pid: 500,
  app_name: "notepad",
  title: "记事本",
  bounds: { x: 1000, y: 0, width: 400, height: 400 },
  is_on_screen: true,
  z_index: 1,
};

class FakeDriver implements DriverToolClient {
  running = false;
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  timeouts: Array<number | undefined> = [];
  stopped = 0;
  windows = [HOST_WINDOW, NOTEPAD_WINDOW];

  async listTools(): Promise<Tool[]> {
    this.running = true;
    return [{ name: "click", inputSchema: { type: "object" } }, { name: "list_windows", inputSchema: { type: "object" } }];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    _signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<CallToolResult> {
    this.running = true;
    this.calls.push({ name, args });
    this.timeouts.push(timeoutMs);
    if (name === "list_windows") {
      const structured = { windows: this.windows };
      return { content: [{ type: "text", text: `✅ ${JSON.stringify(structured)}` }], structuredContent: structured };
    }
    if (name === "get_desktop_state") {
      return {
        content: [{ type: "text", text: "desktop" }],
        structuredContent: { screenshot_width: 1280, screenshot_original_width: 2560 },
      };
    }
    return { content: [{ type: "text", text: `${name} ok` }] };
  }

  async stop(): Promise<void> {
    this.stopped += 1;
    this.running = false;
  }
}

interface Harness {
  proxy: ComputerUseProxy;
  driver: FakeDriver;
  settings: SidecarSettings["computerUse"];
  approvals: { cli: boolean; requests: Array<Omit<AgentPermissionRequest, "id" | "provider">>; answer: AgentPermissionResponse };
}

function makeProxy(): Harness {
  const driver = new FakeDriver();
  const settings: SidecarSettings["computerUse"] = {
    enabled: true,
    allowSelfTargeting: false,
    approval: "ask",
    callTimeoutSec: 120,
  };
  const approvals: Harness["approvals"] = { cli: false, requests: [], answer: { behavior: "allow" } };
  const proxy = new ComputerUseProxy({
    settings: () => settings,
    agentIdForToken: (token) => (token === TOKEN ? AGENT_ID : null),
    approvals: {
      cliApprovesMcpTools: () => approvals.cli,
      requestHostPermission: async (_agentId, request) => {
        approvals.requests.push(request);
        return approvals.answer;
      },
    },
    hostPid: HOST_PID,
    version: "test",
    driver,
  });
  return { proxy, driver, settings, approvals };
}

const nonDriverCalls = (driver: FakeDriver) => driver.calls.filter((call) => call.name !== "list_windows");

describe("callTool：防自指与审批", () => {
  test("CLI 不审批时由 sidecar 发审批；允许后转发，拒绝时不调用驱动", async () => {
    const { proxy, driver, approvals } = makeProxy();
    const args = { target: { kind: "window", pid: 500, window_id: 22 }, x: 5, y: 5, delivery_mode: "background" };
    expect(await proxy.callTool(AGENT_ID, "click", args)).toEqual({ content: [{ type: "text", text: "click ok" }] });
    expect(approvals.requests).toHaveLength(1);
    expect(approvals.requests[0]).toMatchObject({
      name: "agentdeck_cua.click",
      kind: "tool",
      title: "允许 Computer Use：click？",
      input: args,
    });
    expect(approvals.requests[0]!.actions?.map((action) => action.id)).toEqual(["allow", "deny"]);

    approvals.answer = { behavior: "deny", message: "不行" };
    const denied = await proxy.callTool(AGENT_ID, "click", args);
    expect(denied.isError).toBe(true);
    expect(denied.content[0]).toEqual({ type: "text", text: "用户拒绝了这次 Computer Use 操作：不行" });
    expect(nonDriverCalls(driver)).toHaveLength(1);
  });

  test("CLI 自己审批（Claude 默认 / 自动模式）时不再发审批", async () => {
    const { proxy, driver, approvals } = makeProxy();
    approvals.cli = true;
    await proxy.callTool(AGENT_ID, "get_screen_size", {});
    expect(approvals.requests).toHaveLength(0);
    expect(nonDriverCalls(driver)).toEqual([{ name: "get_screen_size", args: {} }]);
  });

  test("审批策略：允许时不再审批、拒绝时不调用驱动；转发超时取设置", async () => {
    const { proxy, driver, settings, approvals } = makeProxy();
    settings.approval = "allow";
    settings.callTimeoutSec = 30;
    await proxy.callTool(AGENT_ID, "get_screen_size", {});
    expect(approvals.requests).toHaveLength(0);
    expect(nonDriverCalls(driver)).toEqual([{ name: "get_screen_size", args: {} }]);
    expect(driver.timeouts.at(-1)).toBe(30_000);
    // 允许时防自指照常生效
    expect((await proxy.callTool(AGENT_ID, "kill_app", { pid: HOST_PID })).content[0]).toEqual({
      type: "text",
      text: SELF_TARGET_REFUSAL,
    });

    settings.approval = "deny";
    approvals.cli = true;
    expect(await proxy.callTool(AGENT_ID, "get_screen_size", {})).toEqual({
      isError: true,
      content: [{ type: "text", text: COMPUTER_USE_POLICY_DENIED }],
    });
    expect(nonDriverCalls(driver)).toHaveLength(1);
    expect(approvals.requests).toHaveLength(0);
  });

  test("以宿主 pid / 窗口为目标、无目标键盘、点在宿主窗口上：审批前直接拒绝", async () => {
    const { proxy, driver, approvals } = makeProxy();
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["kill_app", { pid: HOST_PID }, SELF_TARGET_REFUSAL],
      ["kill_app", { pid: process.pid }, SELF_TARGET_REFUSAL],
      ["click", { target: { kind: "window", pid: 500, window_id: 11 }, x: 1, y: 1 }, SELF_TARGET_REFUSAL],
      ["press_key", { key: "return" }, KEYBOARD_REFUSAL],
      ["click", { target: { kind: "desktop", display_id: "primary" }, x: 100, y: 100 }, SELF_REGION_REFUSAL],
      ["drag", { from_x: 1100, from_y: 10, to_x: 10, to_y: 10 }, SELF_REGION_REFUSAL],
    ];
    for (const [name, args, refusal] of cases) {
      const result = await proxy.callTool(AGENT_ID, name, args);
      expect(result, `${name} ${JSON.stringify(args)}`).toEqual({ isError: true, content: [{ type: "text", text: refusal }] });
    }
    expect(approvals.requests).toHaveLength(0);
    expect(nonDriverCalls(driver)).toHaveLength(0);

    // 点在其它应用窗口上照常转发
    await proxy.callTool(AGENT_ID, "click", { target: { kind: "desktop", display_id: "primary" }, x: 1100, y: 100 });
    expect(nonDriverCalls(driver)).toHaveLength(1);
  });

  test("审批通过后再检查一次：等待期间宿主窗口移到了点击位置", async () => {
    const { proxy, driver, approvals } = makeProxy();
    const args = { target: { kind: "desktop", display_id: "primary" }, x: 1100, y: 100 };
    proxy["options"].approvals.requestHostPermission = async (_agentId, request) => {
      approvals.requests.push(request);
      driver.windows = [{ ...HOST_WINDOW, bounds: { x: 1000, y: 0, width: 400, height: 400 }, z_index: 3 }, NOTEPAD_WINDOW];
      await new Promise((resolve) => setTimeout(resolve, 450)); // 等窗口缓存过期
      return { behavior: "allow" };
    };
    const result = await proxy.callTool(AGENT_ID, "click", args);
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: SELF_REGION_REFUSAL }] });
    expect(nonDriverCalls(driver)).toHaveLength(0);
  });

  test("出参剔除宿主记录；允许操作自身时不过滤也不拦", async () => {
    const { proxy, settings, approvals } = makeProxy();
    approvals.cli = true;
    const filtered = await proxy.callTool(AGENT_ID, "list_windows", {});
    expect(filtered.structuredContent).toEqual({ windows: [NOTEPAD_WINDOW] });
    expect(filtered.content[0]).toEqual({ type: "text", text: `✅ ${JSON.stringify({ windows: [NOTEPAD_WINDOW] })}` });

    settings.allowSelfTargeting = true;
    const raw = await proxy.callTool(AGENT_ID, "list_windows", {});
    expect(raw.structuredContent).toEqual({ windows: [HOST_WINDOW, NOTEPAD_WINDOW] });
    expect((await proxy.callTool(AGENT_ID, "kill_app", { pid: HOST_PID })).isError).toBeUndefined();
  });

  test("截图被缩放后，桌面坐标按还原后的位置判断", async () => {
    const { proxy, driver, approvals } = makeProxy();
    approvals.cli = true;
    driver.windows = [{ ...HOST_WINDOW, bounds: { x: 1600, y: 0, width: 400, height: 400 } }, NOTEPAD_WINDOW];
    expect(desktopScaleOf({ screenshot_width: 1280, screenshot_original_width: 2560 })).toBe(2);
    expect(desktopScaleOf({ screenshot_width: 1280 })).toBe(1);
    expect((await proxy.callTool(AGENT_ID, "click", { x: 900, y: 100 })).isError).toBeUndefined();
    await proxy.callTool(AGENT_ID, "get_desktop_state", {});
    // 缩放比 2：(900, 100) 还原为 (1800, 200)，落在宿主窗口上
    expect(await proxy.callTool(AGENT_ID, "click", { x: 900, y: 100 })).toMatchObject({ isError: true });
    expect((await proxy.callTool(AGENT_ID, "click", { x: 1100, y: 100 })).isError).toBeUndefined();
  });

  test("关闭开关时结束驱动进程", async () => {
    const { proxy, driver, settings } = makeProxy();
    await driver.listTools();
    settings.enabled = false;
    proxy.onSettingsChanged();
    expect(driver.stopped).toBe(1);
  });
});

describe.runIf(process.platform === "win32")("POST /mcp/cua", () => {
  let http: HttpServer | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
    http = null;
  });

  async function listen(proxy: ComputerUseProxy): Promise<string> {
    http = createServer((req, res) => {
      void proxy.handle(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((resolve) => http!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(http!.address() as AddressInfo).port}/mcp/cua`;
  }

  async function connect(url: string, token: string): Promise<Client> {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    return client;
  }

  test("未启用 404、token 错误 401；tools/list 与 tools/call 经代理转发", async () => {
    const { proxy, settings, approvals } = makeProxy();
    const url = await listen(proxy);

    settings.enabled = false;
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(404);
    settings.enabled = true;
    expect((await fetch(url, { method: "POST", body: "{}", headers: { Authorization: "Bearer nope" } })).status).toBe(401);

    const client = await connect(url, TOKEN);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["click", "list_windows"]);
    approvals.cli = true;
    const result = await client.callTool({ name: "list_windows", arguments: {} });
    expect(result.structuredContent).toEqual({ windows: [NOTEPAD_WINDOW] });
    await client.close();
  });
});
