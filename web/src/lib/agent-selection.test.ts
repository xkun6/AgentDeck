import { beforeEach, describe, expect, it } from "vitest";
import type { AgentMode } from "@agentdeck/protocol";
import {
  AGENT_SELECTION_STORAGE_KEY,
  findMode,
  isDangerousMode,
  readAgentSelection,
  resolveModeChoice,
  writeAgentSelection,
} from "./agent-selection";
import { __resetUiStoreForTests, readUiValue } from "./ui-store";

const MODES: AgentMode[] = [
  { id: "default", label: "默认" },
  { id: "acceptEdits", label: "自动接受编辑" },
  // 危险与否只看 sidecar 的 dangerous 标记，与 id 无关
  { id: "yolo", label: "全自动", dangerous: true },
  { id: "bypassPermissions", label: "未标记的同名模式" },
];

beforeEach(() => {
  __resetUiStoreForTests();
});

describe("危险模式判断（AgentMode.dangerous）", () => {
  it("只认 dangerous 标记，不写死 id", () => {
    expect(isDangerousMode(findMode("yolo", MODES))).toBe(true);
    expect(isDangerousMode(findMode("bypassPermissions", MODES))).toBe(false);
    expect(isDangerousMode(findMode("default", MODES))).toBe(false);
    expect(isDangerousMode(undefined)).toBe(false);
    expect(isDangerousMode(null)).toBe(false);
  });

  it("危险模式不写入记忆", () => {
    writeAgentSelection({ provider: "claude", model: null, modeId: "yolo" }, MODES);
    expect(readUiValue<Record<string, unknown>>(AGENT_SELECTION_STORAGE_KEY, {}).modeId).toBeNull();
    writeAgentSelection({ provider: "claude", model: null, modeId: "acceptEdits" }, MODES);
    expect(readAgentSelection().modeId).toBe("acceptEdits");
  });

  it("危险模式不会被默认选中：只有本次手动选中的才保留", () => {
    expect(resolveModeChoice("yolo", MODES)).toBeNull();
    expect(resolveModeChoice("yolo", MODES, "yolo")).toBe("yolo");
    expect(resolveModeChoice("acceptEdits", MODES)).toBe("acceptEdits");
    // 目录未加载或已不存在 → 回落默认
    expect(resolveModeChoice("acceptEdits", undefined)).toBeNull();
    expect(resolveModeChoice("gone", MODES)).toBeNull();
  });
});
