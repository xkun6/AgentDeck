import ReactDOMServer from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CodingAgentToolbar } from "./settings-coding-agents";

describe("CodingAgentToolbar", () => {
  it("为两个顶部操作使用同一按钮规格", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <CodingAgentToolbar
        isFetching={false}
        hasBridge
        onRefresh={() => undefined}
        diagnostics={() => "{}"}
      />,
    );

    expect(html).toContain('role="toolbar"');
    expect(html.match(/data-coding-agent-action="true"/g)).toHaveLength(2);
    expect(html).toContain("刷新检测");
    expect(html).toContain("复制诊断 JSON");
  });
});
