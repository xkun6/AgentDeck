// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider as JotaiProvider, createStore } from "jotai";
import type { SidecarSettings, TranslationEndpoint } from "@agentdeck/protocol";
import { sidecarConnectionAtom } from "@/stores/agents";

const getSidecarSettings = vi.fn<() => Promise<SidecarSettings>>();
const setSidecarSettings = vi.fn();
const getTranslationEndpoint = vi.fn<() => Promise<TranslationEndpoint>>();
const setTranslationEndpoint = vi.fn();
const translateText = vi.fn<(direction: string, text: string) => Promise<string>>();
vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => ({
    getSidecarSettings,
    setSidecarSettings,
    getTranslationEndpoint,
    setTranslationEndpoint,
    translateText,
  }),
  humanizeSidecarError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { TranslationSettingsSection } from "./translation-settings";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const SETTINGS: SidecarSettings = {
  snapshots: { enabled: true, maxFiles: 20_000, maxFileBytes: 5 * 1024 * 1024 },
  interop: { enabled: true },
  remote: { enabled: false, port: 47_631 },
  idleReclaim: { enabled: true, idleMinutes: 15 },
  translation: { userLanguage: "简体中文", agentLanguage: "English", translateReasoning: false, enabledByDefault: false },
};

const ENDPOINT: TranslationEndpoint = {
  baseUrl: "",
  apiKey: "",
  model: "",
  protocol: "chat-completions",
  reasoningEffort: "default",
  timeoutMs: 30_000,
};

function renderPage() {
  const store = createStore();
  store.set(sidecarConnectionAtom, "open");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <JotaiProvider store={store}>
        <TranslationSettingsSection />
      </JotaiProvider>
    </QueryClientProvider>,
  );
}

describe("TranslationSettingsSection（design.md 4.35）", () => {
  it("endpoint 字段回车保存；超时按秒换算；语言写入 settings.translation", async () => {
    getSidecarSettings.mockResolvedValue(SETTINGS);
    getTranslationEndpoint.mockResolvedValue(ENDPOINT);
    setTranslationEndpoint.mockImplementation(async (patch) => ({ ...ENDPOINT, ...patch }));
    setSidecarSettings.mockImplementation(async (patch) => ({
      ...SETTINGS,
      translation: { ...SETTINGS.translation, ...patch.translation },
    }));
    renderPage();

    const baseUrl = await screen.findByLabelText("接口地址");
    fireEvent.change(baseUrl, { target: { value: " https://api.example/v1 " } });
    fireEvent.keyDown(baseUrl, { key: "Enter" });
    await waitFor(() => expect(setTranslationEndpoint).toHaveBeenCalledWith({ baseUrl: "https://api.example/v1" }));

    const timeout = screen.getByLabelText("超时（秒）");
    fireEvent.change(timeout, { target: { value: "45" } });
    fireEvent.keyDown(timeout, { key: "Enter" });
    await waitFor(() => expect(setTranslationEndpoint).toHaveBeenCalledWith({ timeoutMs: 45_000 }));

    const agentLanguage = await screen.findByLabelText("Agent 语言");
    fireEvent.change(agentLanguage, { target: { value: "日本語" } });
    fireEvent.blur(agentLanguage);
    await waitFor(() =>
      expect(setSidecarSettings).toHaveBeenCalledWith({ translation: { agentLanguage: "日本語" } }),
    );
  });

  it("测试按钮：显示译文或错误", async () => {
    getSidecarSettings.mockResolvedValue(SETTINGS);
    getTranslationEndpoint.mockResolvedValue(ENDPOINT);
    translateText.mockRejectedValueOnce(new Error("翻译未配置")).mockResolvedValueOnce("翻译正常。");
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "测试" }));
    expect(await screen.findByText("测试失败：翻译未配置")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "测试" }));
    expect(await screen.findByText("测试成功：翻译正常。")).toBeTruthy();
    expect(translateText).toHaveBeenLastCalledWith("agent-to-user", expect.any(String));
  });
});
