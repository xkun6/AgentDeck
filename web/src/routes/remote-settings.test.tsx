// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider as JotaiProvider, createStore } from "jotai";
import type { RemoteStatus, SidecarSettings } from "@agentdeck/protocol";
import { AGENT_QUERY_KEYS } from "@/lib/agent-query-keys";
import { sidecarConnectionAtom } from "@/stores/agents";
import { ConfirmProvider } from "@/lib/use-confirm";

const getSidecarSettings = vi.fn<() => Promise<SidecarSettings>>();
const setSidecarSettings = vi.fn();
const getRemoteStatus = vi.fn<() => Promise<RemoteStatus>>();
const createRemotePairing = vi.fn();
const revokeRemoteDevice = vi.fn();
vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => ({
    getSidecarSettings,
    setSidecarSettings,
    getRemoteStatus,
    createRemotePairing,
    revokeRemoteDevice,
  }),
  humanizeSidecarError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { PUBLIC_NETWORK_HINT, RemoteSettingsSection } from "./remote-settings";

const ALL_MOCKS = [getSidecarSettings, setSidecarSettings, getRemoteStatus, createRemotePairing, revokeRemoteDevice];

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  for (const mock of ALL_MOCKS) mock.mockReset();
});

const BASE_SETTINGS: SidecarSettings = {
  snapshots: { enabled: true, maxFiles: 20_000, maxFileBytes: 5 * 1024 * 1024 },
  interop: { enabled: true },
  remote: { enabled: true, port: 47_631 },
  idleReclaim: { enabled: true, idleMinutes: 15 },
};

const STATUS: RemoteStatus = {
  enabled: true,
  port: 47_631,
  listening: true,
  addresses: [
    { host: "192.168.1.20", port: 47_631, kind: "lan" },
    { host: "100.101.102.103", port: 47_631, kind: "tailscale" },
  ],
  devices: [
    { deviceId: "d1", name: "我的小米", pairedAt: 1_700_000_000_000, lastSeenAt: 1_700_000_100_000, connected: true },
    { deviceId: "d2", name: "备用机", pairedAt: 1_700_000_000_000, connected: false },
  ],
};

// 一个真实可编码的 URL（长度接近真实 offer）
const OFFER_URL = `agentdeck://pair#${"A".repeat(400)}`;

function renderPage(options: { settings?: SidecarSettings; status?: RemoteStatus; connected?: boolean } = {}) {
  getSidecarSettings.mockResolvedValue(options.settings ?? BASE_SETTINGS);
  getRemoteStatus.mockResolvedValue(options.status ?? STATUS);
  const store = createStore();
  store.set(sidecarConnectionAtom, options.connected === false ? "closed" : "open");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <JotaiProvider store={store}>
        <ConfirmProvider>
          <RemoteSettingsSection />
        </ConfirmProvider>
      </JotaiProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

describe("RemoteSettingsSection", () => {
  afterEach(() => {
    delete (window as { agentdeckDesktop?: unknown }).agentdeckDesktop;
  });

  it("所在网卡为公用网络的地址标红并给出提示；专用网络的地址不标", async () => {
    (window as { agentdeckDesktop?: unknown }).agentdeckDesktop = {
      networkCategories: async () => [
        { address: "192.168.1.20", interfaceAlias: "以太网", category: "public" },
        { address: "100.101.102.103", interfaceAlias: "Tailscale", category: "private" },
      ],
    };
    renderPage();
    const publicRow = (await screen.findByText("192.168.1.20:47631")).closest("li")!;
    await waitFor(() => expect(publicRow.getAttribute("data-public")).toBe("true"));
    expect(screen.getByText("公用网络")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(PUBLIC_NETWORK_HINT);
    expect(screen.getByText("100.101.102.103:47631").closest("li")!.getAttribute("data-public")).toBeNull();
  });

  it("检测结果为空（非 Windows / 失败）时不提示", async () => {
    (window as { agentdeckDesktop?: unknown }).agentdeckDesktop = { networkCategories: async () => [] };
    renderPage();
    await screen.findByText("192.168.1.20:47631");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("公用网络")).toBeNull();
    expect(screen.queryByText(PUBLIC_NETWORK_HINT)).toBeNull();
  });

  it("未连接 sidecar 时给出提示", () => {
    renderPage({ connected: false });
    expect(screen.getByText(/Agent 服务未连接/)).toBeTruthy();
  });

  it("显示开关、端口、地址标签与设备列表（在线 / 离线）", async () => {
    renderPage();
    expect(await screen.findByDisplayValue("47631")).toBeTruthy();
    expect(screen.getByText("开启").getAttribute("data-active")).toBe("true");
    expect(await screen.findByText("192.168.1.20:47631")).toBeTruthy();
    expect(screen.getByText("局域网")).toBeTruthy();
    expect(screen.getByText("100.101.102.103:47631")).toBeTruthy();
    expect(screen.getByText("Tailscale")).toBeTruthy();
    expect(screen.getByText("我的小米")).toBeTruthy();
    expect(screen.getByText("备用机")).toBeTruthy();
    expect(screen.getByText("在线")).toBeTruthy();
    expect(screen.getByText("离线")).toBeTruthy();
    expect(screen.getByText(/尚未连接过/)).toBeTruthy();
  });

  it("关闭状态：不显示地址 / 配对 / 设备区域", async () => {
    renderPage({
      settings: { ...BASE_SETTINGS, remote: { enabled: false, port: 47_631 } },
      status: { enabled: false, port: 47_631, listening: false, addresses: [], devices: [] },
    });
    await screen.findByDisplayValue("47631");
    expect(screen.queryByText("连接地址")).toBeNull();
    expect(screen.queryByText("生成配对二维码")).toBeNull();
  });

  it("启用开关只提交 remote.enabled，并提示 Windows 防火墙「专用网络」", async () => {
    setSidecarSettings.mockImplementation(async (patch) => ({
      ...BASE_SETTINGS,
      remote: { ...BASE_SETTINGS.remote, ...patch.remote },
    }));
    renderPage({
      settings: { ...BASE_SETTINGS, remote: { enabled: false, port: 47_631 } },
      status: { enabled: false, port: 47_631, listening: false, addresses: [], devices: [] },
    });
    const on = await screen.findByText("开启");
    expect(screen.queryByText(/专用网络/)).toBeNull();
    fireEvent.click(on);
    await waitFor(() => expect(setSidecarSettings).toHaveBeenCalledWith({ remote: { enabled: true } }));
    expect(await screen.findByText(/专用网络/)).toBeTruthy();
  });

  it("端口：合法值提交，非法值还原并提示", async () => {
    setSidecarSettings.mockImplementation(async (patch) => ({
      ...BASE_SETTINGS,
      remote: { ...BASE_SETTINGS.remote, ...patch.remote },
    }));
    renderPage();
    const input = (await screen.findByLabelText("监听端口")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "50000" } });
    fireEvent.blur(input);
    await waitFor(() => expect(setSidecarSettings).toHaveBeenCalledWith({ remote: { port: 50_000 } }));

    setSidecarSettings.mockClear();
    fireEvent.change(input, { target: { value: "80" } });
    fireEvent.blur(input);
    expect(await screen.findByText(/端口需为 1024–65535/)).toBeTruthy();
    expect(setSidecarSettings).not.toHaveBeenCalled();
  });

  it("保存失败显示错误；sidecar 返回的启动错误（端口占用）显示在页面上", async () => {
    setSidecarSettings.mockRejectedValue(new Error("磁盘已满"));
    renderPage({
      status: { ...STATUS, listening: false, error: "端口 47631 已被占用，请换一个端口" },
    });
    expect(await screen.findByText("端口 47631 已被占用，请换一个端口")).toBeTruthy();
    fireEvent.click(await screen.findByText("关闭"));
    expect(await screen.findByText(/保存失败：磁盘已满/)).toBeTruthy();
  });

  it("没有可用地址时给出提示；未在监听时「生成配对二维码」不可点", async () => {
    renderPage({ status: { ...STATUS, listening: false, addresses: [] } });
    expect(await screen.findByText(/没有找到局域网或 Tailscale 地址/)).toBeTruthy();
    const button = screen.getByText("生成配对二维码").closest("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("生成二维码：渲染 SVG 与 5 分钟倒计时，过期后可重新生成", async () => {
    const expiresAt = Date.now() + 5 * 60 * 1000;
    createRemotePairing.mockResolvedValueOnce({ offerUrl: OFFER_URL, expiresAt });
    renderPage();
    fireEvent.click(await screen.findByText("生成配对二维码"));
    const qr = await screen.findByRole("img", { name: "配对二维码" });
    expect(qr.querySelector("path")?.getAttribute("d")?.length).toBeGreaterThan(100);
    expect(screen.getByText(/0[45]:\d\d/)).toBeTruthy();
    // 二维码里不显示配对链接明文
    expect(screen.queryByText(OFFER_URL)).toBeNull();
    cleanup();
  });

  it("倒计时走到 0 后显示已过期并允许重新生成", async () => {
    const expiresAt = Date.now() + 2000;
    createRemotePairing.mockResolvedValueOnce({ offerUrl: OFFER_URL, expiresAt });
    renderPage();
    fireEvent.click(await screen.findByText("生成配对二维码"));
    await screen.findByRole("img", { name: "配对二维码" });
    expect(await screen.findByText("二维码已过期", undefined, { timeout: 5000 })).toBeTruthy();

    createRemotePairing.mockResolvedValueOnce({ offerUrl: OFFER_URL, expiresAt: Date.now() + 300_000 });
    fireEvent.click(screen.getByText("重新生成"));
    await waitFor(() => expect(createRemotePairing).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/0[45]:\d\d/)).toBeTruthy();
  });

  it("签发失败（如网关未监听）显示错误", async () => {
    createRemotePairing.mockRejectedValueOnce(new Error("远程网关未启用或未在监听"));
    renderPage();
    fireEvent.click(await screen.findByText("生成配对二维码"));
    expect(await screen.findByText(/生成二维码失败：远程网关未启用或未在监听/)).toBeTruthy();
  });

  it("remote.changed 写入缓存后设备列表实时刷新；配对成功时收起二维码", async () => {
    createRemotePairing.mockResolvedValueOnce({ offerUrl: OFFER_URL, expiresAt: Date.now() + 300_000 });
    const { client } = renderPage();
    fireEvent.click(await screen.findByText("生成配对二维码"));
    await screen.findByRole("img", { name: "配对二维码" });

    act(() => {
      client.setQueryData<RemoteStatus>(AGENT_QUERY_KEYS.remoteStatus, {
        ...STATUS,
        devices: [
          ...STATUS.devices,
          { deviceId: "d3", name: "新手机", pairedAt: 1_700_000_200_000, connected: true },
        ],
      });
    });
    expect(await screen.findByText("新手机")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("img", { name: "配对二维码" })).toBeNull());
    expect(screen.getByText("已配对新设备。")).toBeTruthy();
  });

  it("网关停止监听后二维码消失", async () => {
    createRemotePairing.mockResolvedValueOnce({ offerUrl: OFFER_URL, expiresAt: Date.now() + 300_000 });
    const { client } = renderPage();
    fireEvent.click(await screen.findByText("生成配对二维码"));
    await screen.findByRole("img", { name: "配对二维码" });
    act(() => {
      client.setQueryData<RemoteStatus>(AGENT_QUERY_KEYS.remoteStatus, { ...STATUS, listening: false });
    });
    await waitFor(() => expect(screen.queryByRole("img", { name: "配对二维码" })).toBeNull());
  });

  it("吊销需要二次确认，取消不调用，确认后调用 remote.devices.revoke", async () => {
    revokeRemoteDevice.mockResolvedValue(undefined);
    renderPage();
    const revokeButtons = await screen.findAllByText("吊销");
    fireEvent.click(revokeButtons[0]!);
    expect(await screen.findByText(/吊销「我的小米」后/)).toBeTruthy();
    expect(revokeRemoteDevice).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("取消"));
    await waitFor(() => expect(screen.queryByText(/吊销「我的小米」后/)).toBeNull());
    expect(revokeRemoteDevice).not.toHaveBeenCalled();

    fireEvent.click((await screen.findAllByText("吊销"))[0]!);
    await screen.findByText(/吊销「我的小米」后/);
    const confirmButtons = screen.getAllByText("吊销");
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!);
    await waitFor(() => expect(revokeRemoteDevice).toHaveBeenCalledWith("d1"));
    expect(await screen.findByText("已吊销该设备。")).toBeTruthy();
  });
});
