import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { CODING_AGENT_PATHS_FILE, readConfiguredAgentPath } from "./coding-agent-paths.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "agentdeck-coding-agent-paths-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function writeConfig(content: string): void {
  writeFileSync(path.join(dataDir, CODING_AGENT_PATHS_FILE), content);
}

describe("readConfiguredAgentPath", () => {
  test("未设置数据目录或文件不存在时返回 null", () => {
    expect(readConfiguredAgentPath(undefined, "claude")).toBeNull();
    expect(readConfiguredAgentPath(dataDir, "claude")).toBeNull();
  });

  test("读取对应键并去首尾空白；缺省 / 空字符串 / 非字符串视为未配置", () => {
    writeConfig(JSON.stringify({ claude: "  C:\\tools\\claude.exe  ", codex: "" }));
    expect(readConfiguredAgentPath(dataDir, "claude")).toBe("C:\\tools\\claude.exe");
    expect(readConfiguredAgentPath(dataDir, "codex")).toBeNull();

    writeConfig(JSON.stringify({ codex: 42 }));
    expect(readConfiguredAgentPath(dataDir, "claude")).toBeNull();
    expect(readConfiguredAgentPath(dataDir, "codex")).toBeNull();
  });

  test("允许 UTF-8 BOM", () => {
    writeConfig(`\uFEFF${JSON.stringify({ codex: "/usr/local/bin/codex" })}`);
    expect(readConfiguredAgentPath(dataDir, "codex")).toBe("/usr/local/bin/codex");
  });

  test("损坏的 JSON 或顶层不是对象时视为未配置", () => {
    writeConfig("{oops");
    expect(readConfiguredAgentPath(dataDir, "claude")).toBeNull();
    writeConfig(JSON.stringify(["claude"]));
    expect(readConfiguredAgentPath(dataDir, "claude")).toBeNull();
  });

  test("每次调用都重新读取文件（保存后即时生效）", () => {
    writeConfig(JSON.stringify({ claude: "/a/claude" }));
    expect(readConfiguredAgentPath(dataDir, "claude")).toBe("/a/claude");
    writeConfig(JSON.stringify({ claude: "/b/claude" }));
    expect(readConfiguredAgentPath(dataDir, "claude")).toBe("/b/claude");
  });
});
