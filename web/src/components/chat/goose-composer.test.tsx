import ReactDOMServer from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { ComposerErrorMessage, GooseComposer, isComposerComposing } from "./goose-composer";

describe("ComposerErrorMessage", () => {
  it("renders the error text", () => {
    const html = ReactDOMServer.renderToStaticMarkup(<ComposerErrorMessage message="发送失败" />);
    expect(html).toContain("发送失败");
  });
});

function renderComposer(element: ReactElement): string {
  return ReactDOMServer.renderToStaticMarkup(
    <MemoryRouter>
      {element}
    </MemoryRouter>,
  );
}

describe("GooseComposer IME guard", () => {
  it("keeps keydown handlers suspended until the delayed composition state resets", () => {
    expect(isComposerComposing({ tracked: true, native: false })).toBe(true);
    expect(isComposerComposing({ tracked: false, native: true })).toBe(true);
    expect(isComposerComposing({ tracked: false, native: false })).toBe(false);
  });
});

describe("GooseComposer hints", () => {
  it("renders empty-state hints", () => {
    const html = renderComposer(<GooseComposer hints={[{ label: "把文件拖入此处直接附加" }]} />);
    expect(html).toContain("把文件拖入此处直接附加");
  });
});

describe("GooseComposer workspace picker", () => {
  it("renders initial draft text in the textarea", () => {
    const html = renderComposer(<GooseComposer initial="恢复的草稿" />);

    expect(html).toContain("恢复的草稿");
  });

  it("renders a clear workspace action when a workspace is selected", () => {
    const html = renderComposer(
      <GooseComposer initialWorkspacePath="/Users/enzo/Project" />,
    );

    expect(html).toContain("Project");
    expect(html).toContain("不指定默认工作区：/Users/enzo/Project");
  });

  it("does not render the clear workspace action without a selected workspace", () => {
    const html = renderComposer(<GooseComposer />);

    expect(html).not.toContain("不指定默认工作区：");
  });
});
