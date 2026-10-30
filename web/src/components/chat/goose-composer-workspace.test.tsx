// @vitest-environment jsdom
// 对话页输入框登记工作区：普通会话登记为项目并设为当前工作区，子会话不登记（design.md 4.26）。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { stubRadixGlobals } from "@/test-utils/radix";
import { __resetUiStoreForTests } from "@/lib/ui-store";
import { readWorkspacePath, readWorkspaceProjects } from "@/lib/workspaces";
import { GooseComposer } from "./goose-composer";

stubRadixGlobals();

function renderComposer(adoptWorkspace?: boolean) {
  return render(
    <MemoryRouter>
      <GooseComposer initialWorkspacePath="C:/work/other" adoptWorkspace={adoptWorkspace} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  __resetUiStoreForTests();
});

afterEach(() => {
  cleanup();
});

describe("GooseComposer 登记会话工作区", () => {
  it("默认登记为项目并设为当前工作区", () => {
    renderComposer();
    expect(readWorkspaceProjects().map((project) => project.path)).toEqual(["C:/work/other"]);
    expect(readWorkspacePath()).toBe("C:/work/other");
  });

  it("adoptWorkspace 为 false：照常显示目录，但不登记、不改当前工作区", () => {
    renderComposer(false);
    expect(screen.getByText("other")).toBeTruthy();
    expect(readWorkspaceProjects()).toEqual([]);
    expect(readWorkspacePath()).toBe("");
  });
});
