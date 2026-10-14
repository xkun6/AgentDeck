// @vitest-environment jsdom
// 手机端图片附件：压缩参数、数量与大小限制、选图 / 预览 / 删除 UI、随 agent.send 发出 base64 图片、带图发送失败的提示。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider as JotaiProvider, createStore } from "jotai";
import { stubRadixGlobals } from "@/test-utils/radix";
import { __setSidecarClientForTests, type SidecarClient } from "@/lib/sidecar-client";
import { prepareAgentPrompt } from "@/lib/agent-prompt";
import { replaceAgentSnapshotsAtom, sidecarConnectionAtom } from "@/stores/agents";
import { ensureChatSessionAtom } from "@/stores/chat";
import { MobileComposer } from "./composer";
import {
  IMAGE_LIMITS,
  ImageAttachError,
  addImages,
  compressImage,
  describeImageSendFailure,
  fitWithin,
  imagesToAttachments,
  type DecodedImage,
  type DraftImage,
  type ImageEnv,
} from "./image-attachments";
import { SessionDetail } from "./session-detail";
import { agent } from "./test-fixtures";

stubRadixGlobals();
Element.prototype.scrollTo = () => {};

afterEach(() => {
  cleanup();
  __setSidecarClientForTests(null);
});

function fakeEnv(size: { width: number; height: number }, blobBytes = 1_000) {
  const close = vi.fn();
  const decoded: DecodedImage = { ...size, close };
  const env = {
    decode: vi.fn(async (_file: Blob) => decoded),
    encode: vi.fn(async (_image: DecodedImage, _w: number, _h: number, _type: string, _quality: number) =>
      new Blob([new Uint8Array(blobBytes)], { type: "image/jpeg" }),
    ),
  } satisfies ImageEnv;
  return { env, close };
}

const photo = (name = "IMG_001.png", type = "image/png") => new File([new Uint8Array([1, 2, 3])], name, { type });

describe("图片压缩参数", () => {
  it("限制常量：最多 4 张、长边 2048、JPEG 0.85、单张 5MB", () => {
    expect(IMAGE_LIMITS).toEqual({ maxCount: 4, maxLongEdge: 2048, jpegQuality: 0.85, maxBytes: 5 * 1024 * 1024 });
  });

  it("fitWithin：长边超限等比缩小，横竖都支持；够小不放大", () => {
    expect(fitWithin(4000, 3000, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(3000, 4000, 2048)).toEqual({ width: 1536, height: 2048 });
    expect(fitWithin(2048, 2048, 2048)).toEqual({ width: 2048, height: 2048 });
    expect(fitWithin(1000, 800, 2048)).toEqual({ width: 1000, height: 800 });
    expect(fitWithin(10000, 1, 2048)).toEqual({ width: 2048, height: 1 });
  });

  it("compressImage：按缩放后尺寸以 image/jpeg、0.85 编码，输出 data URL 与 .jpg 文件名，并释放位图", async () => {
    const { env, close } = fakeEnv({ width: 4000, height: 3000 });
    const image = await compressImage(photo("IMG_001.png"), env);
    expect(env.encode).toHaveBeenCalledWith(expect.anything(), 2048, 1536, "image/jpeg", 0.85);
    expect(image).toMatchObject({ name: "IMG_001.jpg", mimeType: "image/jpeg", size: 1_000 });
    expect(image.previewUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(close).toHaveBeenCalled();
  });

  it("浏览器实现：createImageBitmap 解码、铺白底后缩放绘制、toBlob 输出 JPEG 0.85，位图只关闭一次", async () => {
    const bitmap = { width: 4000, height: 3000, close: vi.fn() };
    vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
    const ctx = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, type, quality) => {
      expect(type).toBe("image/jpeg");
      expect(quality).toBe(0.85);
      callback(new Blob([new Uint8Array(10)], { type: "image/jpeg" }));
    });
    try {
      const image = await compressImage(photo("big.png"));
      expect(image.name).toBe("big.jpg");
      expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 2048, 1536);
      expect(ctx.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 2048, 1536);
      expect(bitmap.close).toHaveBeenCalledTimes(1);
    } finally {
      getContext.mockRestore();
      toBlob.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("压缩后仍大于 5MB：拒绝并提示；恰好 5MB 通过", async () => {
    const big = fakeEnv({ width: 100, height: 100 }, IMAGE_LIMITS.maxBytes + 1);
    await expect(compressImage(photo(), big.env)).rejects.toThrow(/超过 5\.0MB/);
    expect(big.close).toHaveBeenCalled();
    const exact = fakeEnv({ width: 100, height: 100 }, IMAGE_LIMITS.maxBytes);
    await expect(compressImage(photo(), exact.env)).resolves.toMatchObject({ size: IMAGE_LIMITS.maxBytes });
  });

  it("非图片文件、无法解码的图片给出中文错误", async () => {
    const { env } = fakeEnv({ width: 10, height: 10 });
    await expect(compressImage(photo("a.txt", "text/plain"), env)).rejects.toBeInstanceOf(ImageAttachError);
    env.decode.mockRejectedValueOnce(new Error("bad"));
    await expect(compressImage(photo(), env)).rejects.toThrow("无法读取这张图片");
  });
});

describe("addImages 数量限制", () => {
  const draft = (id: string): DraftImage => ({ id, name: `${id}.jpg`, mimeType: "image/jpeg", size: 1, previewUrl: "data:image/jpeg;base64,AA==" });
  const compress = vi.fn(async (file: File) => draft(file.name));

  it("总数最多 4 张，多出的忽略并提示", async () => {
    const result = await addImages([draft("a"), draft("b"), draft("c")], [photo("1"), photo("2"), photo("3")], compress);
    expect(result.images.map((i) => i.id)).toEqual(["a", "b", "c", "1"]);
    expect(result.errors).toEqual(["最多附 4 张图片，已忽略多出的 2 张"]);
  });

  it("单张失败不影响其它张，错误带文件名", async () => {
    const flaky = vi.fn(async (file: File) => {
      if (file.name === "bad") throw new ImageAttachError("压缩后仍有 6.0MB，超过 5.0MB 的上限");
      return draft(file.name);
    });
    const result = await addImages([], [photo("ok1"), photo("bad"), photo("ok2")], flaky);
    expect(result.images.map((i) => i.id)).toEqual(["ok1", "ok2"]);
    expect(result.errors).toEqual(["bad：压缩后仍有 6.0MB，超过 5.0MB 的上限"]);
  });

  it("已满 4 张时一张都不再压缩", async () => {
    const spy = vi.fn(async (file: File) => draft(file.name));
    const full = ["a", "b", "c", "d"].map(draft);
    const result = await addImages(full, [photo("x")], spy);
    expect(spy).not.toHaveBeenCalled();
    expect(result.images).toHaveLength(4);
    expect(result.errors).toHaveLength(1);
  });
});

describe("发送内容与失败提示", () => {
  it("草稿图片经 prepareAgentPrompt 变成 { type: image, data, mimeType }，文本在前", async () => {
    const images: DraftImage[] = [
      { id: "i1", name: "a.jpg", mimeType: "image/jpeg", size: 3, previewUrl: "data:image/jpeg;base64,QUJD" },
      { id: "i2", name: "b.jpg", mimeType: "image/jpeg", size: 3, previewUrl: "data:image/jpeg;base64,REVG" },
    ];
    const prepared = await prepareAgentPrompt({ text: "看图", attachments: imagesToAttachments(images) });
    expect(prepared.prompt).toEqual([
      { type: "text", text: "看图" },
      { type: "image", data: "QUJD", mimeType: "image/jpeg" },
      { type: "image", data: "REVG", mimeType: "image/jpeg" },
    ]);
    expect(prepared.displayImages).toHaveLength(2);
    const imageOnly = await prepareAgentPrompt({ text: "", attachments: imagesToAttachments(images.slice(0, 1)) });
    expect(imageOnly.prompt).toEqual([{ type: "image", data: "QUJD", mimeType: "image/jpeg" }]);
  });

  it("无图时发送失败提示不变；带图时补一句明确提示", () => {
    expect(describeImageSendFailure("发送失败", 0)).toBe("发送失败");
    const message = describeImageSendFailure("发送失败", 2);
    expect(message).toContain("发送失败");
    expect(message).toContain("2 张图片");
    expect(message).toContain("不支持图片");
  });
});

describe("MobileComposer 图片入口", () => {
  const base = { value: "", onChange: () => {}, connected: true, steerSupported: false, onSend: vi.fn(), onSteer: vi.fn(), onCancel: vi.fn(), busy: false };
  const thumb = (id: string): DraftImage => ({ id, name: `${id}.jpg`, mimeType: "image/jpeg", size: 1, previewUrl: "data:image/jpeg;base64,AA==" });

  it("没有 onAddImages 时不显示图片入口", () => {
    render(<MobileComposer {...base} />);
    expect(screen.queryByRole("button", { name: "图片" })).toBeNull();
  });

  it("点「图片」出现拍照 / 相册；拍照用 capture=environment，相册可多选；选文件回调 onAddImages", () => {
    const onAddImages = vi.fn();
    render(<MobileComposer {...base} onAddImages={onAddImages} />);
    fireEvent.click(screen.getByRole("button", { name: "图片" }));
    expect(screen.getByRole("menuitem", { name: "拍照" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "相册" })).toBeTruthy();
    const camera = screen.getByLabelText("拍照", { selector: "input" }) as HTMLInputElement;
    const gallery = screen.getByLabelText("从相册选择") as HTMLInputElement;
    expect(camera.accept).toBe("image/*");
    expect(camera.getAttribute("capture")).toBe("environment");
    expect(gallery.accept).toBe("image/*");
    expect(gallery.multiple).toBe(true);
    expect(gallery.hasAttribute("capture")).toBe(false);

    const file = photo();
    fireEvent.change(gallery, { target: { files: [file] } });
    expect(onAddImages).toHaveBeenCalledWith([file]);
  });

  it("缩略图可预览可删除；只有图片没有文字也能发送", () => {
    const onRemoveImage = vi.fn();
    const onSend = vi.fn();
    render(<MobileComposer {...base} images={[thumb("i1"), thumb("i2")]} onAddImages={vi.fn()} onRemoveImage={onRemoveImage} onSend={onSend} />);
    const strip = screen.getByRole("list", { name: "已选图片" });
    expect(within(strip).getAllByRole("img")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "移除图片 i1.jpg" }));
    expect(onRemoveImage).toHaveBeenCalledWith("i1");
    const send = screen.getByRole("button", { name: "发送" }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalled();
  });

  it("满 4 张时「图片」按钮禁用；压缩中禁用发送", () => {
    const { rerender } = render(<MobileComposer {...base} images={["a", "b", "c", "d"].map(thumb)} onAddImages={vi.fn()} />);
    expect((screen.getByRole("button", { name: "图片" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<MobileComposer {...base} value="hi" images={[thumb("a")]} imagesBusy onAddImages={vi.fn()} />);
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("压缩中…")).toBeTruthy();
  });
});

describe("SessionDetail 带图发送", () => {
  function setup(sendError?: Error) {
    const requests: Array<{ method: string; params: unknown }> = [];
    const client = {
      request: vi.fn(async (method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === "provider.list") return [{ id: "claude", kind: "claude", label: "Claude", available: true, capabilities: { steer: true } }];
        if (method === "agent.send") {
          if (sendError) throw sendError;
          return { turnId: "t1" };
        }
        return {};
      }),
      refreshAgents: vi.fn(async () => []),
      syncAgent: vi.fn(async () => undefined),
      historyState: vi.fn(() => ({ oldestSeq: 0, hasOlder: false })),
      fetchOlder: vi.fn(async () => ({ entries: [], hasOlder: false })),
    };
    __setSidecarClientForTests(client as unknown as SidecarClient);
    const store = createStore();
    store.set(sidecarConnectionAtom, "open");
    store.set(replaceAgentSnapshotsAtom, [agent("a1", { title: "会话" })]);
    store.set(ensureChatSessionAtom, "a1");
    const compress = vi.fn(async (file: File): Promise<DraftImage> => ({
      id: `id-${file.name}`,
      name: file.name.replace(/\.\w+$/, ".jpg"),
      mimeType: "image/jpeg",
      size: 3,
      previewUrl: "data:image/jpeg;base64,QUJD",
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <JotaiProvider store={store}>
          <SessionDetail agentId="a1" onBack={() => {}} compress={compress} />
        </JotaiProvider>
      </QueryClientProvider>,
    );
    return { requests, compress };
  }

  async function pick(file: File) {
    fireEvent.click(screen.getByRole("button", { name: "图片" }));
    const gallery = screen.getByLabelText("从相册选择");
    await act(async () => {
      fireEvent.change(gallery, { target: { files: [file] } });
    });
  }

  it("选图 → 预览 → 发送：agent.send 的 prompt 含文本与 base64 图片，发送后草稿清空", async () => {
    const { requests, compress } = setup();
    await pick(photo("IMG_9.png"));
    expect(compress).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("list", { name: "已选图片" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("消息输入框"), { target: { value: "看这张图" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
    });
    const send = requests.find((r) => r.method === "agent.send");
    expect(send?.params).toMatchObject({
      agentId: "a1",
      prompt: [
        { type: "text", text: "看这张图" },
        { type: "image", data: "QUJD", mimeType: "image/jpeg" },
      ],
    });
    await waitFor(() => expect(screen.queryByRole("list", { name: "已选图片" })).toBeNull());
  });

  it("带图发送失败：保留文字与图片，并给出明确提示（不预先禁用按钮）", async () => {
    const { requests } = setup(new Error("provider 拒绝了请求"));
    await pick(photo("IMG_9.png"));
    fireEvent.change(screen.getByLabelText("消息输入框"), { target: { value: "看这张图" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
    });
    expect(requests.some((r) => r.method === "agent.send")).toBe(true);
    // 时间线里也有一条发送失败的系统提示，这里只看输入区上方的提示
    const alert = await screen.findByText(/本条带有 1 张图片/);
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("不支持图片");
    expect((screen.getByLabelText("消息输入框") as HTMLTextAreaElement).value).toBe("看这张图");
    expect(screen.getByRole("list", { name: "已选图片" })).toBeTruthy();
  });

  it("超出 4 张时提示并只保留 4 张", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "图片" }));
    const gallery = screen.getByLabelText("从相册选择");
    await act(async () => {
      fireEvent.change(gallery, { target: { files: ["1", "2", "3", "4", "5"].map((n) => photo(`${n}.png`)) } });
    });
    expect(within(screen.getByRole("list", { name: "已选图片" })).getAllByRole("img")).toHaveLength(4);
    expect(await screen.findByText(/最多附 4 张图片/)).toBeTruthy();
  });

  it("图片被删除后，残留的「最多附 4 张」提示清除", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "图片" }));
    await act(async () => {
      fireEvent.change(screen.getByLabelText("从相册选择"), { target: { files: ["1", "2", "3", "4", "5"].map((n) => photo(`${n}.png`)) } });
    });
    expect(await screen.findByText(/最多附 4 张图片/)).toBeTruthy();
    for (let i = 0; i < 4; i += 1) {
      fireEvent.click(screen.getAllByRole("button", { name: /^移除图片/ })[0]!);
    }
    expect(screen.queryByText(/最多附 4 张图片/)).toBeNull();
  });
});
