// @vitest-environment jsdom
// 新建会话主链路：选择的模型 / 模式 / 思考强度随 agent.create 传入（design.md 4.10）。
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const createSession = vi.fn(async (input: { provider: string; cwd: string }) => ({ id: "agent-1", ...input }));
const sendPrompt = vi.fn(async () => ({ turnId: "t1", clientMessageId: "cm-1" }));

vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => ({ createSession, sendPrompt }),
}));

import { useCreateAndSendSession } from "./use-create-and-send-session";

afterEach(() => {
  cleanup();
  createSession.mockClear();
  sendPrompt.mockClear();
});

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

describe("useCreateAndSendSession", () => {
  it("思考强度随 agent.create 传入；默认（null）时不传", async () => {
    const { result } = renderHook(() => useCreateAndSendSession(), { wrapper });
    const payload = { text: "你好", attachments: [], workspacePath: "/work" };

    await result.current(payload, { provider: "claude", model: "opus", modeId: null, thinkingOptionId: "max" });
    expect(createSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: "claude", cwd: "/work", model: "opus", thinkingOptionId: "max" }),
    );

    await result.current(payload, { provider: "claude", model: null, modeId: null, thinkingOptionId: null });
    expect(createSession.mock.calls.at(-1)?.[0]).not.toHaveProperty("thinkingOptionId");
  });

  it("翻译开关显式值随 agent.create 传入；未指定时不传（design.md 4.35）", async () => {
    const { result } = renderHook(() => useCreateAndSendSession(), { wrapper });
    const payload = { text: "你好", attachments: [], workspacePath: "/work" };
    const selection = { provider: "claude", model: null, modeId: null, thinkingOptionId: null };

    await result.current(payload, selection, false);
    expect(createSession.mock.calls.at(-1)?.[0]).toHaveProperty("translation", false);

    await result.current(payload, selection);
    expect(createSession.mock.calls.at(-1)?.[0]).not.toHaveProperty("translation");
  });
});
