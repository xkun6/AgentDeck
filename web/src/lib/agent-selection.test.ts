import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMode, AgentModelDefinition, AgentSnapshot } from "@agentdeck/protocol";
import {
  AGENT_SELECTION_STORAGE_KEY,
  findMode,
  isDangerousMode,
  readAgentSelection,
  resolveModeChoice,
  resolveThinkingChoice,
  writeAgentSelection,
  applyAgentSelectionChange,
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

describe("思考强度选择（design.md 4.10）", () => {
  const MODELS: AgentModelDefinition[] = [
    { provider: "claude", id: "default", label: "默认", isDefault: true, thinkingOptions: [{ id: "low", label: "低" }] },
    { provider: "claude", id: "haiku", label: "Haiku" },
  ];

  it("随模型 / 模式一起记忆", () => {
    writeAgentSelection({ provider: "claude", model: null, modeId: null, thinkingOptionId: "low" });
    expect(readAgentSelection().thinkingOptionId).toBe("low");
    writeAgentSelection({ provider: "claude", model: null, modeId: null });
    expect(readAgentSelection().thinkingOptionId).toBeNull();
  });

  it("目录加载后丢掉当前模型（未选时为默认模型）不支持的档位；目录未加载时保留", () => {
    expect(resolveThinkingChoice("low", undefined, null)).toBe("low");
    expect(resolveThinkingChoice("low", MODELS, null)).toBe("low");
    expect(resolveThinkingChoice("low", MODELS, "haiku")).toBeNull();
    expect(resolveThinkingChoice("max", MODELS, "default")).toBeNull();
    expect(resolveThinkingChoice(null, MODELS, null)).toBeNull();
  });
});

describe("会话中应用选择变化（applyAgentSelectionChange）", () => {
  const snap = (patch: Partial<AgentSnapshot>) => ({ model: null, modeId: null, thinkingOptionId: null, ...patch }) as AgentSnapshot;
  function fakeActions(afterModel: Partial<AgentSnapshot> = {}) {
    return {
      setModel: vi.fn(async (_id: string, model: string | null) => snap({ model, ...afterModel })),
      setMode: vi.fn(async (_id: string, modeId: string) => snap({ modeId })),
      setThinking: vi.fn(async (_id: string, thinkingOptionId: string | null) => ({
        agent: snap({ thinkingOptionId }),
        notice: "思考强度将在下一轮生效",
      })),
    };
  }

  it("只改思考强度：调 setThinking 并返回提示，不碰模型 / 模式", async () => {
    const actions = fakeActions();
    const result = await applyAgentSelectionChange(actions, "a1", snap({ model: "opus" }), {
      provider: "claude",
      model: "opus",
      modeId: null,
      thinkingOptionId: "max",
    });
    expect(result).toEqual({ thinkingChanged: true, notice: "思考强度将在下一轮生效" });
    expect(actions.setThinking).toHaveBeenCalledWith("a1", "max");
    expect(actions.setModel).not.toHaveBeenCalled();
    expect(actions.setMode).not.toHaveBeenCalled();
  });

  it("换模型且档位被 sidecar 校正为 null、选择也重置为 null：不再调 setThinking", async () => {
    const actions = fakeActions({ thinkingOptionId: null });
    const result = await applyAgentSelectionChange(actions, "a1", snap({ model: "opus", thinkingOptionId: "max" }), {
      provider: "claude",
      model: "haiku",
      modeId: null,
      thinkingOptionId: null,
    });
    expect(result).toEqual({ thinkingChanged: false });
    expect(actions.setModel).toHaveBeenCalledWith("a1", "haiku");
    expect(actions.setThinking).not.toHaveBeenCalled();
  });

  it("档位未变：什么都不调", async () => {
    const actions = fakeActions();
    const current = snap({ thinkingOptionId: "low" });
    expect(
      await applyAgentSelectionChange(actions, "a1", current, {
        provider: "claude",
        model: null,
        modeId: null,
        thinkingOptionId: "low",
      }),
    ).toEqual({ thinkingChanged: false });
    expect(actions.setThinking).not.toHaveBeenCalled();
  });
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
