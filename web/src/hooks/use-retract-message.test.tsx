// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createStore } from "jotai";
import type { SidecarClient } from "@/lib/sidecar-client";
import { createAgentSessionActions } from "./use-agent-session";

import { promptToPrefill, RETRACT_UNAVAILABLE_NOTICE, useRetractMessage } from "./use-retract-message";

afterEach(cleanup);

describe("promptToPrefill", () => {
  it("字符串直接回填；多段文本换行拼接，图片还原为 File", () => {
    expect(promptToPrefill("你好")).toEqual({ text: "你好", files: [] });
    const { text, files } = promptToPrefill([
      { type: "text", text: "a" },
      { type: "image", data: "QUJD", mimeType: "image/png" },
      { type: "text", text: "b" },
    ]);
    expect(text).toBe("a\nb");
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe("image-1.png");
    expect(files[0]!.type).toBe("image/png");
    expect(files[0]!.size).toBe(3);
  });
});

describe("useRetractMessage", () => {
  it("成功：调用 retract 并回填文本 / 图片", async () => {
    const retract = vi.fn(async () => ({ prompt: [{ type: "text" as const, text: "原文" }] }));
    const onPrefill = vi.fn();
    const onRetracted = vi.fn();
    const onRetractFailed = vi.fn();
    const { result } = renderHook(() => useRetractMessage({ retract, onPrefill, onRetracted, onRetractFailed }));
    await act(async () => {
      await result.current.run();
    });
    expect(retract).toHaveBeenCalledTimes(1);
    expect(onRetracted).toHaveBeenCalledTimes(1);
    expect(onRetractFailed).not.toHaveBeenCalled();
    expect(onPrefill).toHaveBeenCalledWith({ text: "原文", files: [] });
    expect(result.current.notice).toBeUndefined();
    expect(result.current.retracting).toBe(false);
  });

  it("失败：显示短提示且不回填", async () => {
    const retract = vi.fn(async () => {
      throw new Error("RETRACT_UNAVAILABLE");
    });
    const onPrefill = vi.fn();
    const onRetractFailed = vi.fn();
    const { result } = renderHook(() => useRetractMessage({ retract, onPrefill, onRetractFailed }));
    await act(async () => {
      await result.current.run();
    });
    expect(onRetractFailed).toHaveBeenCalledTimes(1);
    expect(onPrefill).not.toHaveBeenCalled();
    expect(result.current.notice).toBe(RETRACT_UNAVAILABLE_NOTICE);
  });

  it("进行中重复触发被忽略（按钮禁用）", async () => {
    let resolve!: (value: { prompt: string }) => void;
    const retract = vi.fn(() => new Promise<{ prompt: string }>((r) => (resolve = r)));
    const { result } = renderHook(() => useRetractMessage({ retract, onPrefill: vi.fn() }));
    let first!: Promise<void>;
    act(() => {
      first = result.current.run();
      void result.current.run();
    });
    expect(result.current.retracting).toBe(true);
    expect(retract).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve({ prompt: "x" });
      await first;
    });
    expect(result.current.retracting).toBe(false);
  });
});

describe("actions.retract", () => {
  it("调用 agent.retract 并返回原始 prompt", async () => {
    const request = vi.fn(async () => ({ prompt: "原文", clientMessageId: "m1" }));
    const actions = createAgentSessionActions({ request } as unknown as SidecarClient, createStore());
    await expect(actions.retract("a1")).resolves.toEqual({ prompt: "原文", clientMessageId: "m1" });
    expect(request).toHaveBeenCalledWith("agent.retract", { agentId: "a1" }, expect.anything());
  });
});
