// @vitest-environment jsdom
// 排队消息里粘贴的文件：入队写入、移除时删除、重启后取回，发送等取回完成（design.md 4.22）
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "agentdeck.desktop.composerQueue.v1";
const files = new Map<string, File>();
const save = vi.fn(async (id: string, file: File) => {
  files.set(id, file);
  return true;
});
let releaseLoad: () => void = () => undefined;
let loadGate: Promise<void> = Promise.resolve();

vi.mock("@/lib/queue-attachment-files", () => ({
  saveAttachmentFile: save,
  loadAttachmentFile: vi.fn(async (id: string) => {
    await loadGate;
    return files.get(id) ?? null;
  }),
  deleteAttachmentFile: vi.fn(async (id: string) => {
    files.delete(id);
  }),
  pruneAttachmentFiles: vi.fn(async (keep: ReadonlySet<string>) => {
    for (const id of [...files.keys()]) if (!keep.has(id)) files.delete(id);
  }),
}));

const pasted = (id: string, file?: File) => ({
  id,
  source: "browser" as const,
  name: `${id}.png`,
  kind: "image" as const,
  status: "ready" as const,
  ...(file ? { file } : {}),
});

/** 模拟重启：重新加载模块，localStorage 与 IndexedDB 保留 */
async function loadStore() {
  vi.resetModules();
  return import("./composer-queue");
}

beforeEach(() => {
  files.clear();
  save.mockClear();
  loadGate = Promise.resolve();
  window.localStorage.clear();
});

afterEach(() => {
  releaseLoad();
});

describe("排队消息的粘贴文件", () => {
  it("入队写入文件，重启后取回并能发送，发送后删除", async () => {
    const file = new File(["x"], "a.png", { type: "image/png" });
    const first = await loadStore();
    const entry = first.enqueueQueuedPrompt("s1", { text: "看图", attachments: [pasted("a", file)] }, 1)!;
    expect(save).toHaveBeenCalledWith("a", file);

    const second = await loadStore();
    const send = vi.fn(async () => undefined);
    await second.drainQueuedPrompt("s1", entry, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0] as unknown as [{ attachments: { file?: File }[] }])[0].attachments[0]!.file).toBe(file);
    expect(files.has("a")).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("发送要等文件取回完成", async () => {
    const file = new File(["x"], "a.png");
    const first = await loadStore();
    const entry = first.enqueueQueuedPrompt("s1", { text: "", attachments: [pasted("a", file)] }, 1)!;

    loadGate = new Promise((resolve) => {
      releaseLoad = resolve;
    });
    const second = await loadStore();
    const send = vi.fn(async () => undefined);
    const draining = second.drainQueuedPrompt("s1", entry, send);
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    releaseLoad();
    await draining;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("文件取不回时：有文字的条目留下，只有附件的条目去掉", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      s1: [
        { id: "e1", text: "还有文字", queuedAt: 1, attachments: [pasted("gone1")] },
        { id: "e2", text: "", queuedAt: 2, attachments: [pasted("gone2")] },
      ],
    }));
    const store = await loadStore();
    const taken = await store.takeQueuedPrompt("s1", "e1");
    expect(taken).toMatchObject({ text: "还有文字", attachments: [] });
    expect(await store.takeQueuedPrompt("s1", "e2")).toBeNull();
  });

  it("编辑取走条目时带回文件并删除存储；删除排队消息同样删除存储", async () => {
    const a = new File(["a"], "a.png");
    const b = new File(["b"], "b.png");
    const first = await loadStore();
    const edited = first.enqueueQueuedPrompt("s1", { text: "1", attachments: [pasted("a", a)] }, 1)!;
    const removed = first.enqueueQueuedPrompt("s1", { text: "2", attachments: [pasted("b", b)] }, 2)!;
    await vi.waitFor(() => expect(files.size).toBe(2));

    const second = await loadStore();
    const taken = await second.takeQueuedPrompt("s1", edited.id);
    expect(taken!.attachments[0]!.file).toBe(a);
    second.removeQueuedPrompt("s1", removed.id);
    expect(files.size).toBe(0);
  });

  it("启动时清理没有引用的文件", async () => {
    files.set("orphan", new File(["x"], "o.png"));
    const store = await loadStore();
    await store.takeQueuedPrompt("s1", "none");
    expect(files.size).toBe(0);
  });
});
