// Computer Use 驱动：定位、manifest 解析、安装命令、stdio 连接（design.md 4.37）
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, test } from "vitest";

import {
  CUA_INSTALL_SCRIPT_URL,
  driverCandidates,
  installCommand,
  locateDriver,
  parseManifest,
} from "../../src/computer-use/driver.js";
import { CuaDriverConnection } from "../../src/computer-use/proxy.js";
import { createSilentLogger } from "../../src/logger.js";

/** 工具结果的第一段文本 */
function firstText(result: CallToolResult): string {
  const block = result.content[0];
  return block?.type === "text" ? block.text : "";
}

const FAKE_DRIVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-cua-driver.mjs");

describe("定位与 manifest", () => {
  const env = { PATH: "", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", USERPROFILE: "C:\\Users\\u" };

  test("候选路径：官方安装落点与 current 联接", () => {
    expect(driverCandidates(env)).toEqual([
      path.join(env.LOCALAPPDATA, "Programs", "Cua", "cua-driver", "bin", "cua-driver.exe"),
      path.join(env.USERPROFILE, ".cua-driver", "packages", "current", "cua-driver.exe"),
    ]);
  });

  test.runIf(process.platform === "win32")("取第一个存在的候选", () => {
    const second = path.join(env.USERPROFILE, ".cua-driver", "packages", "current", "cua-driver.exe");
    expect(locateDriver(env, (file) => file === second)).toBe(second);
    expect(locateDriver(env, () => false)).toBeNull();
  });

  test("parseManifest：版本与 mcp_invocation；缺失时回退 <binary> mcp", () => {
    expect(
      parseManifest(
        "C:\\d\\cua-driver.exe",
        JSON.stringify({ binary_version: "0.9.1", mcp_invocation: { command: "C:\\x\\cua-driver.exe", args: ["mcp"] } }),
      ),
    ).toEqual({ version: "0.9.1", command: "C:\\x\\cua-driver.exe", args: ["mcp"] });
    expect(parseManifest("C:\\d\\cua-driver.exe", "{}")).toEqual({ command: "C:\\d\\cua-driver.exe", args: ["mcp"] });
  });

  test("安装命令：只描述不执行，展示的命令里就是将要下载的脚本地址", () => {
    const command = installCommand({ PATH: "", SystemRoot: "C:\\Windows" });
    expect(command.program).toBe(path.join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
    expect(command.args).toEqual(["-NoProfile", "-Command", `irm ${CUA_INSTALL_SCRIPT_URL} | iex`]);
    expect(command.display).toBe(`powershell -NoProfile -Command "irm ${CUA_INSTALL_SCRIPT_URL} | iex"`);
    expect(command.sourceUrl).toBe(CUA_INSTALL_SCRIPT_URL);
  });
});

describe("CuaDriverConnection（stdio）", () => {
  let connection: CuaDriverConnection | null = null;

  afterEach(async () => {
    await connection?.stop();
    connection = null;
  });

  function connect(): CuaDriverConnection {
    connection = new CuaDriverConnection("test", createSilentLogger(), async () => ({
      installed: true,
      command: process.execPath,
      args: [FAKE_DRIVER],
    }));
    return connection;
  }

  test("懒启动、列工具、调用工具；进程退出后下次调用重新拉起；stop 结束进程", async () => {
    const driver = connect();
    expect(driver.running).toBe(false);
    expect((await driver.listTools()).map((tool) => tool.name)).toEqual(["list_windows", "pid", "exit"]);
    expect(driver.running).toBe(true);
    const listed = await driver.callTool("list_windows", {});
    expect(listed.structuredContent).toEqual({
      windows: [{ window_id: 1, pid: 1, bounds: { x: 0, y: 0, width: 1, height: 1 } }],
    });
    const firstPid = Number(firstText(await driver.callTool("pid", {})));

    await driver.callTool("exit", {});
    for (let i = 0; i < 100 && driver.running; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(driver.running).toBe(false);
    const secondPid = Number(firstText(await driver.callTool("pid", {})));
    expect(secondPid).not.toBe(firstPid);

    await driver.stop();
    expect(driver.running).toBe(false);
    expect(() => process.kill(secondPid, 0)).toThrow();
  });

  test("未安装时给出中文提示", async () => {
    connection = new CuaDriverConnection("test", createSilentLogger(), async () => ({ installed: false }));
    await expect(connection.listTools()).rejects.toThrow("未找到 cua-driver");
  });
});
