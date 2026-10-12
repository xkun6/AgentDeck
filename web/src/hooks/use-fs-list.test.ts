import { afterEach, describe, expect, it, vi } from "vitest";
import { FS_LIST_UNAVAILABLE_MESSAGE, listDirectory, mapFsListResult } from "./use-fs-list";

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("fs_list 结果映射", () => {
  it("isDir → is_dir，保留 parent / home，无错误时不带 error", () => {
    expect(mapFsListResult({
      path: "C:\\Users\\me",
      parent: "C:\\Users",
      home: "C:\\Users\\me",
      entries: [
        { name: "code", path: "C:\\Users\\me\\code", isDir: true },
        { name: "a.txt", path: "C:\\Users\\me\\a.txt", isDir: false },
      ],
    })).toEqual({
      path: "C:\\Users\\me",
      parent: "C:\\Users",
      home: "C:\\Users\\me",
      entries: [
        { name: "code", path: "C:\\Users\\me\\code", is_dir: true },
        { name: "a.txt", path: "C:\\Users\\me\\a.txt", is_dir: false },
      ],
    });
  });

  it("读取失败带中文 error 与空 entries", () => {
    const mapped = mapFsListResult({ path: "/nope", parent: null, home: "/home/me", entries: [], error: "路径不存在" });
    expect(mapped.error).toBe("路径不存在");
    expect(mapped.entries).toEqual([]);
    expect(mapped.parent).toBeNull();
  });
});

describe("listDirectory", () => {
  it("经桥调 fs_list：null 列主目录（不带 path），空字符串列盘符", async () => {
    const fsList = vi.fn(async (input: { path?: string; showHidden?: boolean }) => ({
      path: input.path ?? "/home/me",
      parent: null,
      home: "/home/me",
      entries: [{ name: "C:\\", path: "C:\\", isDir: true }],
    }));
    (globalThis as { window?: unknown }).window = { hermesDesktop: { windowType: "tauri", fsList } };

    const home = await listDirectory(null);
    expect(fsList).toHaveBeenLastCalledWith({ showHidden: false });
    expect(home.path).toBe("/home/me");

    const drives = await listDirectory("", { showHidden: true });
    expect(fsList).toHaveBeenLastCalledWith({ path: "", showHidden: true });
    expect(drives.entries).toEqual([{ name: "C:\\", path: "C:\\", is_dir: true }]);
  });

  it("纯 web 模式（无桥）给出友好提示", async () => {
    (globalThis as { window?: unknown }).window = {};
    await expect(listDirectory("/x")).rejects.toThrow(FS_LIST_UNAVAILABLE_MESSAGE);
  });
});
