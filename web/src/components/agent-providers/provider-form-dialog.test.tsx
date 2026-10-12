// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProviderInfo, ProviderProfile } from "@agentdeck/protocol";
import { stubRadixGlobals } from "@/test-utils/radix";
import { __setSidecarClientForTests, SidecarRpcError, type SidecarClient } from "@/lib/sidecar-client";
import { ProviderFormDialog, type ProviderFormTarget } from "./provider-form-dialog";

stubRadixGlobals();
afterEach(() => {
  cleanup();
  __setSidecarClientForTests(null);
});

const PROVIDERS: ProviderInfo[] = [
  { id: "claude", kind: "claude", label: "Claude Code", available: true },
  { id: "codex", kind: "codex", label: "Codex", available: true },
];

function setup(
  request: (method: string, params: unknown) => Promise<unknown>,
  options: { target?: ProviderFormTarget; profiles?: ProviderProfile[] } = {},
) {
  const fake = { request: vi.fn(request) };
  __setSidecarClientForTests(fake as unknown as SidecarClient);
  const onClose = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ProviderFormDialog
        target={options.target ?? { kind: "create" }}
        profiles={options.profiles ?? []}
        providers={PROVIDERS}
        configPath="C:\\data\\providers.json"
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  return { request: fake.request, onClose };
}

const input = (label: string | RegExp) => screen.getByLabelText(label) as HTMLInputElement;
const change = (element: HTMLElement, value: string) => fireEvent.change(element, { target: { value } });

describe("ProviderFormDialog", () => {
  it("名称自动生成 id（避开内置 id），切换「基于」时字段跟着变", () => {
    setup(async () => ({}));
    change(input(/名称/), "Claude");
    expect(input(/^id/).value).toBe("claude-2");
    expect(screen.getByLabelText("API Key")).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "认证方式" })).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: /Codex/ }));
    expect(screen.queryByRole("radiogroup", { name: "认证方式" })).toBeNull();
    expect(screen.getByText(/Codex 不会从中转发现模型/)).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: /ACP/ }));
    expect(screen.queryByLabelText("API Key")).toBeNull();
    expect(input(/命令/)).toBeTruthy();

    // 手动改过 id 后不再跟随名称
    change(input(/^id/), "custom-one");
    change(input(/名称/), "Other");
    expect(input(/^id/).value).toBe("custom-one");
  });

  it("测试连接：提交未保存的表单，显示 ok / HTTP / 延迟 / 模型数；拉取的模型勾选后填入", async () => {
    const { request } = setup(async (method) => {
      if (method === "provider.test") {
        return {
          ok: true,
          status: 200,
          latencyMs: 12,
          models: [
            { id: "fake-claude-1", label: "Fake Claude 1" },
            { id: "fake-claude-2", label: "Fake Claude 2" },
          ],
        };
      }
      throw new Error(`unexpected ${method}`);
    });
    change(input("Base URL"), "http://127.0.0.1:8787/");
    change(input("API Key"), "fake-ui-key-123456");
    expect(input("API Key").type).toBe("password");

    fireEvent.click(screen.getByRole("button", { name: /测试连接/ }));
    await screen.findByText("连接成功 · HTTP 200 · 12 ms · 拉取到 2 个模型");
    expect(request).toHaveBeenCalledWith(
      "provider.test",
      {
        profile: {
          id: "relay-test",
          extends: "claude",
          label: "测试",
          baseUrl: "http://127.0.0.1:8787",
          apiKey: "fake-ui-key-123456",
          authMode: "auth_token",
        },
      },
      { timeoutMs: 20_000 },
    );

    fireEvent.click(screen.getByRole("button", { name: /从接口拉取/ }));
    const group = await screen.findByRole("group", { name: "接口返回的模型" });
    fireEvent.click(within(group).getByRole("checkbox", { name: /fake-claude-2/ }));
    fireEvent.click(screen.getByRole("button", { name: "填入所选（1）" }));
    expect(input("第 1 个模型 id").value).toBe("fake-claude-1");
    expect(input("第 1 个模型显示名").value).toBe("Fake Claude 1");
    expect(screen.queryByLabelText("第 2 个模型 id")).toBeNull();
  });

  it("保存：校验错误 providers.<i>.id 就地显示在 id 字段", async () => {
    const existing: ProviderProfile = { id: "first", extends: "acp", label: "First", command: ["agent"] };
    const { request, onClose } = setup(async (method) => {
      if (method === "provider.config.set") {
        throw new SidecarRpcError({
          code: -32602,
          message: "参数错误",
          data: { issues: [{ path: "providers.1.id", message: "id「claude」与内置 provider 冲突" }] },
        });
      }
      throw new Error(`unexpected ${method}`);
    }, { profiles: [existing] });
    change(input(/名称/), "Mine");
    change(input(/^id/), "claude");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await screen.findByText("id「claude」与内置 provider 冲突");
    expect(input(/^id/).getAttribute("data-invalid")).toBe("true");
    expect(onClose).not.toHaveBeenCalled();
    const [, params] = request.mock.calls[0]!;
    expect((params as { providers: ProviderProfile[] }).providers).toEqual([
      existing,
      { id: "claude", extends: "claude", label: "Mine", authMode: "auth_token" },
    ]);

    // 修改 id 后错误清除
    change(input(/^id/), "mine");
    expect(screen.queryByText("id「claude」与内置 provider 冲突")).toBeNull();
  });

  it("编辑：整表替换对应项，成功后关闭；NOT_SUPPORTED 给出数据目录提示", async () => {
    const profiles: ProviderProfile[] = [
      { id: "a", extends: "claude", label: "A", apiKey: "fake-saved-key" },
      { id: "b", extends: "codex", label: "B" },
    ];
    let fail = true;
    const { request, onClose } = setup(async (method) => {
      if (method !== "provider.config.set") throw new Error(`unexpected ${method}`);
      if (fail) throw new SidecarRpcError({ code: -32000, message: "x", data: { code: "NOT_SUPPORTED" } });
      return { providers: PROVIDERS };
    }, { target: { kind: "edit", index: 0 }, profiles });

    // 已保存的密钥默认遮挡
    expect(input("API Key").type).toBe("password");
    expect(input("API Key").value).toBe("fake-saved-key");
    fireEvent.click(screen.getByRole("button", { name: "显示API Key" }));
    expect(input("API Key").type).toBe("text");

    change(input(/名称/), "A2");
    expect(input(/^id/).value).toBe("a");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText(/未设置数据目录/);
    expect(onClose).not.toHaveBeenCalled();

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [, params] = request.mock.calls[1]!;
    expect((params as { providers: ProviderProfile[] }).providers).toEqual([
      { id: "a", extends: "claude", label: "A2", apiKey: "fake-saved-key", authMode: "auth_token" },
      profiles[1],
    ]);
  });
});
