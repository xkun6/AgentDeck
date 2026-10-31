// @vitest-environment jsdom
// 手机端页面的组件测试：电脑列表、配对链接解析与错误提示、会话列表过滤、新建会话的危险模式、attention 提示条、详情页分页与输入区。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider as JotaiProvider, createStore } from "jotai";
import { encodeOfferUrl, type RemoteConnectionOffer } from "@agentdeck/remote";
import type { AgentStreamEnvelope, AgentStreamEvent, AttentionNotice } from "@agentdeck/protocol";
import { stubRadixGlobals } from "@/test-utils/radix";
import { __setSidecarClientForTests, type SidecarClient } from "@/lib/sidecar-client";
import { replaceAgentSnapshotsAtom, sidecarConnectionAtom } from "@/stores/agents";
import { applyAgentEventAtom, ensureChatSessionAtom } from "@/stores/chat";
import { replaceSubagentsAtom } from "@/stores/subagents";
import type { PairedHost } from "@/lib/remote/hosts";
import { PairingError } from "@/lib/remote/pairing";
import { AttentionBanner, useAttentionNotice } from "./attention-banner";
import { MobileComposer } from "./composer";
import type { ConnectionSnapshot } from "./connection-manager";
import { HostList } from "./host-list";
import { NewSession } from "./new-session";
import { PairScreen } from "./pair-screen";
import { CHUNK_OVERLAP, INITIAL_WINDOW, MAX_RENDERED, SessionDetail, WINDOW_STEP } from "./session-detail";
import { SessionList } from "./session-list";
import { agent } from "./test-fixtures";
import type { MobileRoute } from "./route";

const pairWithOffer = vi.fn();
vi.mock("@/lib/remote/pairing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/remote/pairing")>();
  return { ...actual, pairWithOffer: (...args: unknown[]) => pairWithOffer(...args) };
});

stubRadixGlobals();
// jsdom 没有元素级 scrollTo（MessageTimeline 贴底滚动用）
Element.prototype.scrollTo = () => {};

beforeEach(() => {
  pairWithOffer.mockReset();
});

afterEach(() => {
  cleanup();
  __setSidecarClientForTests(null);
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const CONNECTION: ConnectionSnapshot = {
  hostId: null,
  phase: "idle",
  error: null,
  authReason: null,
  client: null,
  store: null,
};

function pairedHost(id: string, overrides: Partial<PairedHost> = {}): PairedHost {
  return {
    id,
    name: `电脑-${id}`,
    daemonPublicKey: "k",
    addresses: [{ host: "192.168.1.8", port: 47631, kind: "lan" }],
    deviceId: id,
    deviceSecret: "s",
    pairedAt: 1,
    ...overrides,
  };
}

describe("HostList 电脑列表", () => {
  const noop = () => {};

  it("显示每台电脑的连接状态：已连接 / 连接中 / 失败原因 / 凭据失效", () => {
    const hosts = [pairedHost("a"), pairedHost("b")];
    const { rerender } = render(
      <HostList hosts={hosts} connection={{ ...CONNECTION, hostId: "a", phase: "open" }} onOpenHost={noop} onDeleteHost={noop} onScan={noop} onPaste={noop} />,
    );
    expect(within(screen.getByText("电脑-a").closest("li")!).getByText("已连接")).toBeTruthy();
    expect(within(screen.getByText("电脑-b").closest("li")!).getByText("未连接")).toBeTruthy();

    rerender(
      <HostList hosts={hosts} connection={{ ...CONNECTION, hostId: "a", phase: "connecting" }} onOpenHost={noop} onDeleteHost={noop} onScan={noop} onPaste={noop} />,
    );
    expect(screen.getByText("连接中…")).toBeTruthy();

    rerender(
      <HostList hosts={hosts} connection={{ ...CONNECTION, hostId: "a", phase: "failed", error: "连接超时" }} onOpenHost={noop} onDeleteHost={noop} onScan={noop} onPaste={noop} />,
    );
    expect(screen.getByText("连接失败：连接超时")).toBeTruthy();

    rerender(
      <HostList hosts={hosts} connection={{ ...CONNECTION, hostId: "a", phase: "auth_failed", authReason: "revoked" }} onOpenHost={noop} onDeleteHost={noop} onScan={noop} onPaste={noop} />,
    );
    expect(screen.getByText(/已在电脑上被吊销，请重新配对/)).toBeTruthy();
  });

  it("删除需要二次确认，取消不删除", () => {
    const onDeleteHost = vi.fn();
    render(
      <HostList hosts={[pairedHost("a")]} connection={CONNECTION} onOpenHost={noop} onDeleteHost={onDeleteHost} onScan={noop} onPaste={noop} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "删除 电脑-a" }));
    expect(onDeleteHost).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("button", { name: "确认删除" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "删除 电脑-a" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    expect(onDeleteHost).toHaveBeenCalledWith("a");
  });

  it("点击电脑进入；非 Tauri 环境隐藏扫码、只保留粘贴；Tauri 环境两个入口都有", () => {
    const onOpenHost = vi.fn();
    const onPaste = vi.fn();
    const { unmount } = render(
      <HostList hosts={[pairedHost("a")]} connection={CONNECTION} onOpenHost={onOpenHost} onDeleteHost={noop} onScan={noop} onPaste={onPaste} />,
    );
    expect(screen.queryByRole("button", { name: "扫码配对" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "粘贴配对链接" }));
    expect(onPaste).toHaveBeenCalled();
    fireEvent.click(screen.getByText("电脑-a"));
    expect(onOpenHost).toHaveBeenCalledWith("a");
    unmount();

    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    render(<HostList hosts={[]} connection={CONNECTION} onOpenHost={noop} onDeleteHost={noop} onScan={noop} onPaste={noop} />);
    expect(screen.getByRole("button", { name: "扫码配对" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "粘贴配对链接" })).toBeTruthy();
    expect(screen.getByText(/还没有配对过电脑/)).toBeTruthy();
  });
});

describe("PairScreen 配对页", () => {
  function validLink(overrides: Partial<RemoteConnectionOffer> = {}): string {
    return encodeOfferUrl({
      v: 1,
      name: "书房电脑",
      daemonPublicKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(5))),
      addresses: [{ host: "192.168.1.8", port: 47631, kind: "lan" }],
      pairingSecret: "B".repeat(43),
      expiresAt: Date.now() + 60_000,
      ...overrides,
    });
  }

  const setup = () => {
    const onPaired = vi.fn();
    render(<PairScreen deviceName="Pixel 8" onPaired={onPaired} onBack={() => {}} />);
    return { onPaired, input: screen.getByLabelText("配对链接") as HTMLTextAreaElement };
  };

  it("不是配对链接 → 提示格式，不发起连接", () => {
    setup();
    fireEvent.change(screen.getByLabelText("配对链接"), { target: { value: "hello world" } });
    fireEvent.click(screen.getByRole("button", { name: "配对" }));
    expect(screen.getByRole("alert").textContent).toContain("agentdeck://pair#");
    expect(pairWithOffer).not.toHaveBeenCalled();
  });

  it("链接已过期 → 提示重新生成", () => {
    setup();
    fireEvent.change(screen.getByLabelText("配对链接"), { target: { value: validLink({ expiresAt: Date.now() - 1000 }) } });
    fireEvent.click(screen.getByRole("button", { name: "配对" }));
    expect(screen.getByRole("alert").textContent).toContain("重新生成");
    expect(pairWithOffer).not.toHaveBeenCalled();
  });

  it("粘贴整段文字也能配对：用可编辑的设备名发起，成功后回调带主机记录", async () => {
    const host = pairedHost("dev-1", { name: "书房电脑" });
    pairWithOffer.mockResolvedValue(host);
    const { onPaired } = setup();
    fireEvent.change(screen.getByDisplayValue("Pixel 8"), { target: { value: "我的手机" } });
    fireEvent.change(screen.getByLabelText("配对链接"), { target: { value: `请扫描：${validLink()} 谢谢` } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "配对" }));
    });
    expect(pairWithOffer).toHaveBeenCalledTimes(1);
    expect(pairWithOffer.mock.calls[0]![0]).toMatchObject({ name: "书房电脑" });
    expect(pairWithOffer.mock.calls[0]![1]).toBe("我的手机");
    expect(onPaired).toHaveBeenCalledWith(host, "我的手机");
  });

  it("电脑端拒绝（密钥失效 / 网络不通）→ 显示可读原因并允许重试", async () => {
    pairWithOffer.mockRejectedValue(new PairingError("配对码无效或已被使用，请在电脑上重新生成", "invalid"));
    const { onPaired } = setup();
    fireEvent.change(screen.getByLabelText("配对链接"), { target: { value: validLink() } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "配对" }));
    });
    expect(screen.getByRole("alert").textContent).toContain("已被使用");
    expect(onPaired).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "配对" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

// ── 需要 sidecar 客户端与 jotai store 的页面 ──────────────────────────────────

interface FakeClient {
  request: ReturnType<typeof vi.fn>;
  refreshAgents: ReturnType<typeof vi.fn>;
  syncAgent: ReturnType<typeof vi.fn>;
  historyState: ReturnType<typeof vi.fn>;
  fetchOlder: ReturnType<typeof vi.fn>;
}

function makeClient(handler: (method: string, params: unknown) => unknown = () => ({})): FakeClient {
  return {
    request: vi.fn(async (method: string, params?: unknown) => handler(method, params)),
    refreshAgents: vi.fn(async () => []),
    syncAgent: vi.fn(async () => undefined),
    historyState: vi.fn(() => ({ oldestSeq: 0, hasOlder: false })),
    fetchOlder: vi.fn(async () => ({ entries: [], hasOlder: false })),
  };
}

describe("SessionList 会话列表", () => {
  it("隐藏归档与评判会话、置顶在前、待审批标记；切换后显示归档", async () => {
    const client = makeClient((method) => (method === "provider.list" ? [] : {}));
    const store = createStore();
    store.set(sidecarConnectionAtom, "open");
    store.set(replaceAgentSnapshotsAtom, [
      agent("a", { title: "普通会话", updatedAt: 5 }),
      agent("p", { title: "置顶会话", pinned: true, updatedAt: 1 }),
      agent("w", { title: "等审批", updatedAt: 4, pendingPermissions: [{ id: "r1" } as never] }),
      agent("q", { title: "等回答", updatedAt: 2, pendingPermissions: [{ id: "r2", kind: "question" } as never] }),
      agent("l", { title: "等计划", updatedAt: 2, pendingPermissions: [{ id: "r3", kind: "plan" } as never] }),
      agent("x", { title: "已归档会话", archived: true, updatedAt: 3 }),
      agent("j", { title: "评判会话", origin: "judge", updatedAt: 6 }),
    ]);
    __setSidecarClientForTests(client as unknown as SidecarClient);
    const onOpen = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <JotaiProvider store={store}>
          <SessionList onOpen={onOpen} />
        </JotaiProvider>
      </QueryClientProvider>,
    );

    expect(screen.queryByText("已归档会话")).toBeNull();
    expect(screen.queryByText("评判会话")).toBeNull();
    const rows = within(screen.getByRole("list", { name: "会话列表" })).getAllByRole("listitem");
    expect(rows[0]!.textContent).toContain("置顶会话");
    expect(rows[0]!.textContent).toContain("置顶");
    expect(rows.map((r) => r.textContent).join("|")).toContain("等审批");
    // 提问 / 计划按快照 pendingPermissions[0].kind 区分
    expect(rows.map((r) => r.textContent).join("|")).toContain("待回答");
    expect(rows.map((r) => r.textContent).join("|")).toContain("待确认计划");

    // 进入页面会刷新一次 agent.list
    expect(client.refreshAgents).toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("显示已归档（1）"));
    expect(screen.getByText("已归档会话")).toBeTruthy();
    expect(screen.queryByText("评判会话")).toBeNull();

    fireEvent.click(screen.getByText("普通会话"));
    expect(onOpen).toHaveBeenCalledWith("a");
  });
});

describe("NewSession 新建会话", () => {
  const PROVIDERS = [
    { id: "claude", kind: "claude", label: "Claude Code", available: true },
    { id: "codex", kind: "codex", label: "Codex", available: false, unavailableReason: "未安装" },
  ];
  const CATALOG = {
    models: [{ provider: "claude", id: "sonnet", label: "Sonnet", isDefault: true }],
    modes: [
      { id: "default", label: "默认询问" },
      { id: "bypassPermissions", label: "完全放行", dangerous: true },
    ],
  };

  function setup(
    agents = [agent("a", { cwd: "J:/Program/A", updatedAt: 5 }), agent("b", { cwd: "J:/Program/B", updatedAt: 9 })],
    translationDefault = false,
  ) {
    const created = agent("new-1");
    const client = makeClient((method) => {
      if (method === "provider.list") return PROVIDERS;
      if (method === "settings.get") return { translation: { enabledByDefault: translationDefault } };
      if (method === "provider.listModels") return CATALOG;
      if (method === "agent.create") return { agent: created };
      return {};
    });
    __setSidecarClientForTests(client as unknown as SidecarClient);
    const store = createStore();
    store.set(sidecarConnectionAtom, "open");
    store.set(replaceAgentSnapshotsAtom, agents);
    const onCreated = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <JotaiProvider store={store}>
          <NewSession onCreated={onCreated} />
        </JotaiProvider>
      </QueryClientProvider>,
    );
    return { client, onCreated };
  }

  const createCalls = (client: FakeClient) => client.request.mock.calls.filter((c) => c[0] === "agent.create");

  const openPicker = (name: RegExp) => fireEvent.click(screen.getByRole("button", { name }));
  const closePicker = () => fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  const createButton = () => screen.getByRole("button", { name: "创建" }) as HTMLButtonElement;
  const create = () =>
    act(async () => {
      fireEvent.click(createButton());
    });

  it("危险模式标红且不会默认选中：直接创建不带 modeId", async () => {
    const { client, onCreated } = setup();
    openPicker(/^模式/);
    const dangerous = await screen.findByRole("radio", { name: /完全放行/ });
    expect(dangerous.getAttribute("data-danger")).toBe("true");
    expect(dangerous.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("radio", { name: "默认模式" }).getAttribute("aria-checked")).toBe("true");
    expect(dangerous.textContent).toContain("跳过权限确认");
    closePicker();

    await create();
    const [, params] = createCalls(client)[0]!;
    expect(params).toMatchObject({ provider: "claude", cwd: "J:/Program/B" });
    expect(params).not.toHaveProperty("modeId");
    expect(onCreated).toHaveBeenCalledWith("new-1");
  });

  it("用户明确点选危险模式后才带 modeId，表单上标红提示；切回默认模式即去掉", async () => {
    const { client } = setup();
    openPicker(/^模式/);
    fireEvent.click(await screen.findByRole("radio", { name: /完全放行/ }));
    // 选完面板自动关闭，表单显示当前取值
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: /^模式/ }).textContent).toContain("跳过权限确认");
    await create();
    expect(createCalls(client)[0]![1]).toMatchObject({ modeId: "bypassPermissions" });

    openPicker(/^模式/);
    expect(screen.getByRole("radio", { name: /完全放行/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "默认模式" }));
    await create();
    expect(createCalls(client)[1]![1]).not.toHaveProperty("modeId");
  });

  it("工作目录来自现有会话去重、最近使用在前并默认选中；可改选；不可用的 provider 禁用", async () => {
    const { client } = setup([
      agent("a", { cwd: "J:/Program/A", updatedAt: 5 }),
      agent("a2", { cwd: "j:\\program\\a", updatedAt: 6 }),
      agent("b", { cwd: "J:/Program/B", updatedAt: 9 }),
    ]);
    openPicker(/^Agent/);
    expect(((await screen.findByRole("radio", { name: /Codex/ })) as HTMLButtonElement).disabled).toBe(true);
    closePicker();

    openPicker(/^工作目录/);
    const dirs = within(screen.getByRole("radiogroup", { name: "工作目录" })).getAllByRole("radio");
    expect(dirs).toHaveLength(3); // 两个目录 + 「手动输入路径」
    expect(dirs[2]!.textContent).toContain("手动输入路径");
    expect(dirs[0]!.textContent).toContain("J:/Program/B");
    expect(dirs[0]!.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(dirs[1]!);
    await create();
    expect(createCalls(client)[0]![1]).toMatchObject({ cwd: "j:\\program\\a" });
  });

  it("已有会话时也始终提供「手动输入路径」：选中后出现输入框，创建用输入的目录；改选回已有目录即恢复", async () => {
    const { client } = setup();
    expect(screen.queryByPlaceholderText(/J:\/Program\/MyProject/)).toBeNull();
    await vi.waitFor(() => expect(createButton().disabled).toBe(false));

    openPicker(/^工作目录/);
    fireEvent.click(screen.getByRole("radio", { name: /手动输入路径/ }));
    const input = screen.getByPlaceholderText(/J:\/Program\/MyProject/);
    // 选中手动但还没填：不能创建
    expect(createButton().disabled).toBe(true);
    fireEvent.change(input, { target: { value: " D:/other/proj " } });
    await create();
    expect(createCalls(client)[0]![1]).toMatchObject({ cwd: "D:/other/proj" });

    openPicker(/^工作目录/);
    expect(screen.getByRole("radio", { name: /手动输入路径/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: /Program\/A/ }));
    expect(screen.queryByPlaceholderText(/J:\/Program\/MyProject/)).toBeNull();
    await create();
    expect(createCalls(client)[1]![1]).toMatchObject({ cwd: "J:/Program/A" });
  });

  it("没有任何会话时允许手动输入目录，未填写前不能创建", async () => {
    setup([]);
    await vi.waitFor(() => expect(screen.getByRole("button", { name: /^Agent/ }).textContent).toContain("Claude"));
    expect(createButton().disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/J:\/Program\/MyProject/), { target: { value: "J:/x" } });
    expect(createButton().disabled).toBe(false);
  });

  it("翻译开关跟随「新会话默认开启」，未改动时不传 translation；改选后显式传入（design.md 4.35）", async () => {
    const { client } = setup(undefined, true);
    const toggle = () => screen.getByRole("switch", { name: "翻译" }) as HTMLInputElement;
    await vi.waitFor(() => expect(toggle().checked).toBe(true));
    await create();
    expect(createCalls(client)[0]![1]).not.toHaveProperty("translation");

    fireEvent.click(toggle());
    await create();
    expect(createCalls(client)[1]![1]).toMatchObject({ translation: false });
  });
});

describe("attention 提示条", () => {
  const notice: AttentionNotice = {
    id: "n1",
    kind: "permission",
    agentId: "a1",
    title: "重构登录",
    body: "Agent 请求审批：运行命令",
    timestamp: 1,
  };

  function Harness({ client, route, foreground = true, navigate }: {
    client: { onAttention: (l: (n: AttentionNotice) => void) => () => void };
    route: MobileRoute;
    foreground?: boolean;
    navigate: (r: MobileRoute) => void;
  }) {
    const [current, dismiss] = useAttentionNotice(client, route, () => foreground);
    return current ? <AttentionBanner notice={current} onOpen={navigate} onDismiss={dismiss} /> : <div>无提示</div>;
  }

  function fakeAttentionClient() {
    let listener: ((n: AttentionNotice) => void) | null = null;
    return {
      client: {
        onAttention: (l: (n: AttentionNotice) => void) => {
          listener = l;
          return () => {
            listener = null;
          };
        },
      },
      emit: (n: AttentionNotice) => act(() => listener?.(n)),
    };
  }

  it("前台在其它页面：弹出提示条，点击跳转到对应会话并关闭", () => {
    const { client, emit } = fakeAttentionClient();
    const navigate = vi.fn();
    render(<Harness client={client} route={{ name: "sessions" }} navigate={navigate} />);
    emit(notice);
    expect(screen.getByRole("status").textContent).toContain("重构登录");
    fireEvent.click(screen.getByText(/Agent 请求审批/));
    expect(navigate).toHaveBeenCalledWith({ name: "session", agentId: "a1" });
    expect(screen.getByText("无提示")).toBeTruthy();
  });

  it("前台且正停在该会话：忽略", () => {
    const { client, emit } = fakeAttentionClient();
    render(<Harness client={client} route={{ name: "session", agentId: "a1" }} navigate={vi.fn()} />);
    emit(notice);
    expect(screen.getByText("无提示")).toBeTruthy();
  });

  it("后台：不弹条（交给 M3 的后台处理器）；同一 id 不重复弹", () => {
    const { client, emit } = fakeAttentionClient();
    const { rerender } = render(<Harness client={client} route={{ name: "sessions" }} foreground={false} navigate={vi.fn()} />);
    emit(notice);
    expect(screen.getByText("无提示")).toBeTruthy();

    rerender(<Harness client={client} route={{ name: "sessions" }} foreground navigate={vi.fn()} />);
    emit({ ...notice, id: "n2" });
    expect(screen.getByRole("status")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
    emit({ ...notice, id: "n2" });
    expect(screen.getByText("无提示")).toBeTruthy();
  });
});

describe("MobileComposer 输入区", () => {
  const base = { value: "你好", onChange: () => {}, connected: true, onSend: vi.fn(), onSteer: vi.fn(), onCancel: vi.fn() };

  it("空闲：发送", () => {
    const onSend = vi.fn();
    render(<MobileComposer {...base} busy={false} steerSupported={false} onSend={onSend} />);
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onSend).toHaveBeenCalled();
  });

  it("运行中且支持插话：插话 + 取消；插话走 steer 而不是 send", () => {
    const onSend = vi.fn();
    const onSteer = vi.fn();
    const onCancel = vi.fn();
    render(<MobileComposer {...base} busy steerSupported onSend={onSend} onSteer={onSteer} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "插话" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onSteer).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("运行中占位文案足够短（不折成两行）", () => {
    const { rerender } = render(<MobileComposer {...base} busy steerSupported />);
    expect(screen.getByLabelText("消息输入框").getAttribute("placeholder")).toBe("运行中，可插话");
    rerender(<MobileComposer {...base} busy steerSupported={false} />);
    expect(screen.getByLabelText("消息输入框").getAttribute("placeholder")).toBe("运行中，可取消");
  });

  it("运行中且不支持插话：输入框禁用、只有取消", () => {
    render(<MobileComposer {...base} busy steerSupported={false} />);
    expect((screen.getByLabelText("消息输入框") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "插话" })).toBeNull();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
  });

  it("未连接：不能发送", () => {
    render(<MobileComposer {...base} busy={false} steerSupported={false} connected={false} />);
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("SessionDetail 时间线向前分页", () => {
  function turnEvents(base: number, turn: number): AgentStreamEnvelope[] {
    const e = (seq: number, event: AgentStreamEvent): AgentStreamEnvelope => ({
      agentId: "a1",
      seq,
      epoch: "e1",
      timestamp: 10_000 + seq,
      event,
    });
    return [
      e(base + 1, { type: "timeline", item: { type: "user_message", text: `问题${turn}` } }),
      e(base + 2, { type: "turn_started", turnId: `t${turn}` }),
      e(base + 3, { type: "timeline", turnId: `t${turn}`, item: { type: "assistant_message", text: `回答${turn}` } }),
      e(base + 4, { type: "turn_completed", turnId: `t${turn}` }),
    ];
  }

  function setup() {
    const older = turnEvents(0, 1);
    const client = makeClient((method) => (method === "provider.list" ? [{ id: "claude", kind: "claude", label: "Claude", available: true, capabilities: { steer: true } }] : {}));
    client.historyState.mockReturnValue({ oldestSeq: 5, hasOlder: true });
    client.fetchOlder.mockResolvedValue({ entries: older, hasOlder: false });
    __setSidecarClientForTests(client as unknown as SidecarClient);
    const store = createStore();
    store.set(sidecarConnectionAtom, "open");
    store.set(replaceAgentSnapshotsAtom, [agent("a1", { title: "长会话" })]);
    store.set(ensureChatSessionAtom, "a1");
    for (const envelope of [...turnEvents(4, 2), ...turnEvents(8, 3)]) store.set(applyAgentEventAtom, envelope, true);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <JotaiProvider store={store}>
          <SessionDetail agentId="a1" onBack={() => {}} />
        </JotaiProvider>
      </QueryClientProvider>,
    );
    return { client, store, ...view };
  }

  const order = () => {
    const text = document.body.textContent ?? "";
    return ["问题1", "回答1", "问题2", "回答2", "问题3", "回答3"].map((t) => text.indexOf(t));
  };

  it("点「加载更早的消息」按 beforeSeq 取回更早一页并插在最前面，顺序正确，取完后入口消失", async () => {
    const { client } = setup();
    expect(await screen.findByText("问题2")).toBeTruthy();
    expect(screen.queryByText("问题1")).toBeNull();
    const loadEarlier = await screen.findByRole("button", { name: "加载更早的消息" });
    await act(async () => {
      fireEvent.click(loadEarlier);
    });
    expect(client.fetchOlder).toHaveBeenCalledWith("a1", 300);
    const positions = order();
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(screen.queryByRole("button", { name: /加载更早|显示更早/ })).toBeNull();
  });

  it("滚动到顶部也会触发加载，且加载中不会重复请求", async () => {
    const { client } = setup();
    await screen.findByText("问题2");
    // hasOlder 在 loadTimeline 的 Promise 结束后才设置，消息可能先渲染：等入口出现再滚动
    await screen.findByRole("button", { name: "加载更早的消息" });
    const log = screen.getByRole("log");
    await act(async () => {
      fireEvent.scroll(log);
      fireEvent.scroll(log);
    });
    expect(client.fetchOlder).toHaveBeenCalledTimes(1);
  });

  it("顶栏「翻译」开关经 agent.update 切换会话翻译（design.md 4.35）", async () => {
    const { client } = setup();
    const toggle = await screen.findByRole("button", { name: "翻译" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(client.request).toHaveBeenCalledWith("agent.update", { agentId: "a1", translation: true });
  });

  it("provider 支持 steer 时空闲状态显示发送、状态行不渲染空芯片", async () => {
    setup();
    await screen.findByText("问题3");
    expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
    expect(screen.queryByTestId("composer-status-row")).toBeNull();
  });
});

describe("SessionDetail 子代理", () => {
  function sub(id: string, parentSubagentId: string | null = null) {
    return {
      id,
      parentAgentId: "a1",
      parentSubagentId,
      provider: "claude" as const,
      title: "Explore",
      description: `任务-${id}`,
      status: "running" as const,
      createdAt: 1,
      updatedAt: 1,
      toolCallId: id,
      cwd: null,
      subtitle: null,
    };
  }

  function setup(openSubagentId: string | null) {
    const client = makeClient((method) => {
      if (method === "provider.list") return [];
      if (method === "agent.subagents.list") return { subagents: [sub("s1"), sub("s2", "s1")] };
      if (method === "agent.subagents.timeline") {
        return { rows: [{ seq: 1, timestamp: 1, item: { type: "assistant_message", text: "子代理的发现" } }], hasOlder: false };
      }
      return {};
    });
    __setSidecarClientForTests(client as unknown as SidecarClient);
    const store = createStore();
    store.set(sidecarConnectionAtom, "open");
    store.set(replaceAgentSnapshotsAtom, [agent("a1", { title: "带子代理" })]);
    store.set(ensureChatSessionAtom, "a1");
    store.set(replaceSubagentsAtom, { agentId: "a1", subagents: [sub("s1"), sub("s2", "s1")] });
    const onOpenSubagent = vi.fn();
    const onCloseSubagent = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (open: string | null) => (
      <QueryClientProvider client={queryClient}>
        <JotaiProvider store={store}>
          <SessionDetail
            agentId="a1"
            onBack={() => {}}
            openSubagentId={open}
            onOpenSubagent={onOpenSubagent}
            onCloseSubagent={onCloseSubagent}
          />
        </JotaiProvider>
      </QueryClientProvider>
    );
    const view = render(tree(openSubagentId));
    return { client, store, onOpenSubagent, onCloseSubagent, rerender: (open: string | null) => view.rerender(tree(open)) };
  }

  it("状态行出现子代理药丸，点开列表选一行触发 onOpenSubagent，此时没有覆盖层", async () => {
    const { onOpenSubagent } = setup(null);
    const pill = await screen.findByRole("button", { name: /子代理/ });
    fireEvent.click(pill);
    expect(screen.queryByRole("dialog", { name: "子代理" })).toBeNull();
    fireEvent.click(within(screen.getByRole("list", { name: "子代理列表" })).getByRole("button"));
    expect(onOpenSubagent).toHaveBeenCalledWith("s1");
  });

  it("openSubagentId 非空：渲染全屏子代理时间线，会话页保持挂载；X 触发 onCloseSubagent；孙代理走 onOpenSubagent", async () => {
    const { client, onOpenSubagent, onCloseSubagent, rerender } = setup(null);
    await screen.findByRole("button", { name: /子代理/ });
    expect(screen.getByRole("heading", { name: "带子代理" })).toBeTruthy();
    rerender("s1");
    const overlay = await screen.findByRole("dialog", { name: "子代理" });
    expect(await within(overlay).findByText("子代理的发现")).toBeTruthy();
    expect(within(overlay).getByTestId("subagent-panel-timeline")).toBeTruthy();
    expect(client.request).toHaveBeenCalledWith("agent.subagents.timeline", expect.objectContaining({ agentId: "a1", subagentId: "s1" }));
    // 会话页仍在
    expect(screen.getByRole("heading", { name: "带子代理" })).toBeTruthy();
    // 孙代理
    fireEvent.click(within(overlay).getByRole("button", { name: /^子代理/ }));
    fireEvent.click(within(within(overlay).getByRole("list", { name: "子代理列表" })).getByRole("button"));
    expect(onOpenSubagent).toHaveBeenCalledWith("s2");
    fireEvent.click(within(overlay).getByRole("button", { name: "关闭子代理面板" }));
    expect(onCloseSubagent).toHaveBeenCalledTimes(1);
    rerender(null);
    expect(screen.queryByRole("dialog", { name: "子代理" })).toBeNull();
  });
});

describe("SessionDetail 长会话：渲染节点数上限", () => {
  const TURNS = 300; // 600 条消息（用户 + 助手），足以走完「原地展开 → 分段视图」

  function setupLong() {
    const client = makeClient((method) => (method === "provider.list" ? [] : {}));
    __setSidecarClientForTests(client as unknown as SidecarClient);
    const store = createStore();
    store.set(sidecarConnectionAtom, "open");
    store.set(replaceAgentSnapshotsAtom, [agent("a1", { title: "超长会话" })]);
    store.set(ensureChatSessionAtom, "a1");
    for (let turn = 1; turn <= TURNS; turn += 1) {
      const base = turn * 4;
      const e = (seq: number, event: AgentStreamEvent): AgentStreamEnvelope => ({ agentId: "a1", seq, epoch: "e1", timestamp: 10_000 + seq, event });
      for (const envelope of [
        e(base + 1, { type: "timeline", item: { type: "user_message", text: `问题${turn}` } }),
        e(base + 2, { type: "turn_started", turnId: `t${turn}` }),
        e(base + 3, { type: "timeline", turnId: `t${turn}`, item: { type: "assistant_message", text: `回答${turn}` } }),
        e(base + 4, { type: "turn_completed", turnId: `t${turn}` }),
      ]) {
        store.set(applyAgentEventAtom, envelope, true);
      }
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <JotaiProvider store={store}>
          <SessionDetail agentId="a1" onBack={() => {}} />
        </JotaiProvider>
      </QueryClientProvider>,
    );
  }

  const renderedMessages = () => screen.queryAllByText(/^(问题|回答)\d+$/).length;
  const showEarlier = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /显示更早的/ }));
    });
  };

  it("首屏只渲染最近 INITIAL_WINDOW 条；反复展开更早的消息，同时渲染的消息数始终不超过上限，DOM 节点数有界", async () => {
    setupLong();
    await screen.findByText(`问题${TURNS}`);
    expect(renderedMessages()).toBe(INITIAL_WINDOW);
    let peak = renderedMessages();
    let peakNodes = document.body.querySelectorAll("*").length;
    // 一直展开到没有更早的消息为止（600 条 > 上限，必然经过分段视图）
    for (let i = 0; i < 20 && screen.queryByRole("button", { name: /显示更早的/ }); i += 1) {
      await showEarlier();
      peak = Math.max(peak, renderedMessages());
      peakNodes = Math.max(peakNodes, document.body.querySelectorAll("*").length);
    }
    expect(peak).toBeLessThanOrEqual(MAX_RENDERED);
    expect(peak).toBeGreaterThan(INITIAL_WINDOW);
    expect(TURNS * 2).toBeGreaterThan(MAX_RENDERED); // 全部消息多于上限，上限确实起了作用
    expect(WINDOW_STEP).toBeGreaterThan(0);
    expect(peakNodes).toBeLessThan(MAX_RENDERED * 18); // 每条消息约 16 个节点；600 条全渲染会超过 9600
  }, 60_000);

  it("到达上限后换成「较早的消息」视图（与已看过的部分重叠衔接），可一键返回最新", async () => {
    setupLong();
    await screen.findByText(`问题${TURNS}`);
    // 展开到上限：INITIAL_WINDOW + n × WINDOW_STEP > MAX_RENDERED 之前都是原地展开
    const inPlaceSteps = Math.floor((MAX_RENDERED - INITIAL_WINDOW) / WINDOW_STEP);
    for (let i = 0; i < inPlaceSteps; i += 1) await showEarlier();
    expect(screen.queryByText("正在查看较早的消息")).toBeNull();
    const oldestBefore = screen.queryAllByText(/^(问题|回答)\d+$/)[0]!.textContent!;

    await showEarlier();
    expect(screen.getByText("正在查看较早的消息")).toBeTruthy();
    expect(renderedMessages()).toBeLessThanOrEqual(MAX_RENDERED);
    // 新视图的最后几条正是之前最早看到的那些（重叠 CHUNK_OVERLAP 条），而不是凭空跳到更早
    expect(screen.queryByText(oldestBefore)).toBeTruthy();
    expect(screen.queryByText(`问题${TURNS}`)).toBeNull();
    expect(CHUNK_OVERLAP).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "返回最新" }));
    expect(screen.queryByText("正在查看较早的消息")).toBeNull();
    expect(await screen.findByText(`问题${TURNS}`)).toBeTruthy();
    expect(renderedMessages()).toBe(INITIAL_WINDOW);
  }, 60_000);
});
