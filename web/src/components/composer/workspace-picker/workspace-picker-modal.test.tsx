// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  expandHomePath,
  splitBreadcrumb,
  workspaceParentTarget,
  WorkspacePickerModal,
} from "./workspace-picker-modal";

const fsMock = vi.hoisted(() => {
  const posix = {
    path: "/home/user/projects",
    home: "/home/user",
    entries: [
      { name: "alpha", path: "/home/user/projects/alpha", is_dir: true },
      { name: "beta", path: "/home/user/projects/beta", is_dir: true },
    ],
  };
  return {
    posix,
    /** 按 path 返回的数据；未命中时回落 posix 数据 */
    byPath: {} as Record<string, unknown>,
    calls: [] as Array<string | null>,
  };
});

vi.mock("@/hooks/use-fs-list", () => ({
  useFsList: (path: string | null) => {
    fsMock.calls.push(path);
    return {
      data: (path !== null && fsMock.byPath[path]) || fsMock.posix,
      isFetching: false,
    };
  },
}));

afterEach(() => {
  cleanup();
  fsMock.byPath = {};
  fsMock.calls = [];
});

describe("WorkspacePickerModal", () => {
  it("confirms the resolved directory", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<WorkspacePickerModal open initialPath="/home/user/projects" onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: /选择此目录/ }));
    expect(onConfirm).toHaveBeenCalledWith("/home/user/projects");
  });

  it("cancels via the close button", () => {
    const onCancel = vi.fn();
    render(<WorkspacePickerModal open initialPath="/home/user/projects" onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "关闭目录选择" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("jumps to a manually typed path and navigates entries", () => {
    const onConfirm = vi.fn();
    render(<WorkspacePickerModal open initialPath="/home/user/projects" onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/粘贴目录路径/), { target: { value: "/home/user/other" } });
    fireEvent.click(screen.getByRole("button", { name: /跳转/ }));
    // after navigation the mock still returns the same data path, so confirm uses resolved path
    fireEvent.click(screen.getByRole("button", { name: /选择此目录/ }));
    expect(onConfirm).toHaveBeenCalledWith("/home/user/projects");
  });

  it("Windows：盘符根目录「上一级」回到盘符列表，从盘符列表双击进入目录", () => {
    fsMock.byPath = {
      "C:\\": {
        path: "C:\\",
        parent: null,
        home: "C:\\Users\\me",
        entries: [{ name: "Users", path: "C:\\Users", is_dir: true }],
      },
      "": {
        path: "",
        parent: null,
        home: "C:\\Users\\me",
        entries: [
          { name: "C:\\", path: "C:\\", is_dir: true },
          { name: "D:\\", path: "D:\\", is_dir: true },
        ],
      },
    };
    const onConfirm = vi.fn();
    render(<WorkspacePickerModal open initialPath={"C:\\"} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "上一级" }));
    expect(fsMock.calls[fsMock.calls.length - 1]).toBe("");
    // 盘符列表：没有上一级，不能选为工作区
    expect((screen.getByRole("button", { name: "上一级" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /选择此目录/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.doubleClick(screen.getByRole("button", { name: "D:\\" }));
    expect(fsMock.calls).toContain("D:\\");
  });

  it("没有初始路径时以 null 请求主目录", () => {
    render(<WorkspacePickerModal open onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(fsMock.calls[0]).toBeNull();
  });
});

describe("workspace picker 路径辅助", () => {
  it("workspaceParentTarget：优先 parent；盘符根回到盘符列表；POSIX 根与盘符列表无上一级", () => {
    expect(workspaceParentTarget("C:\\Users", "C:\\")).toBe("C:\\");
    expect(workspaceParentTarget("C:\\", null)).toBe("");
    expect(workspaceParentTarget("", null)).toBeNull();
    expect(workspaceParentTarget("/", null)).toBeNull();
    // 读取失败（无 parent）时按路径推导
    expect(workspaceParentTarget("/home/user/missing", undefined)).toBe("/home/user");
  });

  it("splitBreadcrumb：Windows 带「此电脑」入口，POSIX 以 ~ 为根", () => {
    expect(splitBreadcrumb("C:\\Users\\me", "C:\\Users\\me")).toEqual([
      { label: "此电脑", path: "" },
      { label: "C:", path: "C:\\" },
      { label: "Users", path: "C:\\Users" },
      { label: "me", path: "C:\\Users\\me" },
    ]);
    expect(splitBreadcrumb("", "C:\\Users\\me")).toEqual([{ label: "此电脑", path: "" }]);
    expect(splitBreadcrumb("/home/user/projects", "/home/user")).toEqual([
      { label: "~", path: "/home/user" },
      { label: "projects", path: "/home/user/projects" },
    ]);
  });

  it("expandHomePath 展开 ~", () => {
    expect(expandHomePath("~", "/home/user")).toBe("/home/user");
    expect(expandHomePath("~/code", "/home/user")).toBe("/home/user/code");
    expect(expandHomePath("/abs", "/home/user")).toBe("/abs");
    expect(expandHomePath("~/code", "")).toBe("~/code");
  });
});
