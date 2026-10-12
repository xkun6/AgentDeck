// 走 shell 时 spawn.ts 自己拼接命令串、args 传空数组，不应再触发 Node 的 DEP0190 警告
// （shell:true + args 数组）。单独成文件：DEP0190 每个进程只发一次，避免被其它用例提前触发。
import { afterEach, describe, expect, test } from "vitest";

import { execCommand, spawnProcess } from "./spawn.js";

const warnings: Array<{ name: string; code?: string; message: string }> = [];
const onWarning = (warning: Error & { code?: string }) => {
  warnings.push({ name: warning.name, code: warning.code, message: warning.message });
};

afterEach(() => {
  process.off("warning", onWarning);
  warnings.length = 0;
});

describe("spawn 走 shell 时不触发 DEP0190", () => {
  test("execCommand 与 spawnProcess 显式 shell:true 且带参数", async () => {
    process.on("warning", onWarning);

    // 裸命令名 node：Windows 下本来就会走 cmd.exe；这里显式 shell:true 让各平台都覆盖 shell 分支
    const { stdout } = await execCommand("node", ["--version"], { shell: true });
    expect(stdout.trim()).toMatch(/^v[0-9]+[.]/);

    const child = spawnProcess("node", ["--version"], {
      shell: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => (output += chunk));
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
    expect(output.trim()).toMatch(/^v[0-9]+[.]/);

    // warning 事件在 nextTick 派发，留一拍再断言
    await new Promise((resolve) => setImmediate(resolve));
    expect(warnings.filter((w) => w.code === "DEP0190")).toEqual([]);
  });
});
