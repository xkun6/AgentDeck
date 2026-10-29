import { describe, expect, it } from "vitest";
import {
  extractImagePartsFromUnknown,
  extractMarkdownImageParts,
  isAnchoredImageSource,
  isLikelyLocalFilePath,
  normalizeLocalFilePath,
  safeImageSrc,
} from "./message-images";

describe("message image extraction", () => {
  it("extracts Markdown image paths that contain spaces", () => {
    const parts = extractMarkdownImageParts(
      "结果：![预览](/Users/enzo/Library/Application Support/local.agentdeck.desktop/runtime/agentdeck-home/images/out.png)",
    );

    expect(parts).toEqual([{
      type: "image",
      url: "/Users/enzo/Library/Application Support/local.agentdeck.desktop/runtime/agentdeck-home/images/out.png",
      alt: "预览",
      name: "预览",
    }]);
  });

  it("extracts bare local image paths that contain spaces", () => {
    const parts = extractImagePartsFromUnknown(
      "图片保存在 /Users/enzo/Library/Application Support/local.agentdeck.desktop/runtime/agentdeck-home/images/out.png",
    );

    expect(parts[0]?.url).toBe(
      "/Users/enzo/Library/Application Support/local.agentdeck.desktop/runtime/agentdeck-home/images/out.png",
    );
  });

  it("decodes encoded local image paths before media loading", () => {
    expect(normalizeLocalFilePath("/Users/enzo/Library/Application%20Support/out.png"))
      .toBe("/Users/enzo/Library/Application Support/out.png");
  });

  it("recognizes POSIX-style Windows drive paths as local file paths", () => {
    expect(isLikelyLocalFilePath("/D:/AgentDeck/e2e/.runtime/agentdeck-home/images/model output.png")).toBe(true);
    expect(isLikelyLocalFilePath("/D:/data/shot.png")).toBe(true);
    expect(isLikelyLocalFilePath("/Users/enzo/Downloads/chart.png")).toBe(true);
    expect(isLikelyLocalFilePath("/about")).toBe(false);
  });

  it("keeps POSIX-style Windows drive paths out of the browser-safe src bucket", () => {
    // These are local filesystem paths (rendered by MessageImage through the
    // media bridge), not web-relative URLs, so safeImageSrc must reject them.
    expect(safeImageSrc("/D:/AgentDeck/e2e/.runtime/agentdeck-home/images/model output.png")).toBeUndefined();
    expect(safeImageSrc("/D:/data/shot.png")).toBeUndefined();
  });

  it("maps POSIX-style Windows drive paths back to the real filesystem path", () => {
    expect(
      normalizeLocalFilePath("/D:/AgentDeck/e2e/.runtime/agentdeck-home/images/generated%20previews/model%20output.png"),
    ).toBe("D:/AgentDeck/e2e/.runtime/agentdeck-home/images/generated previews/model output.png");
    expect(normalizeLocalFilePath("/D:/data/shot.png")).toBe("D:/data/shot.png");
  });
});

describe("isAnchoredImageSource", () => {
  it("接受 data / http(s) / blob 与本机绝对路径，拒绝相对路径", () => {
    for (const ok of ["data:image/png;base64,AAAA", "https://a.test/x.png", "http://127.0.0.1/x.png", "blob:abc", "C:\\a\\b.png", "J:/a/b.png", "/Users/me/b.png", "file:///C:/a.png"]) {
      expect(isAnchoredImageSource(ok), ok).toBe(true);
    }
    for (const bad of [undefined, "", "tag-none.png", "./images/a.png", "../a.png", "icons/32x32.png"]) {
      expect(isAnchoredImageSource(bad), String(bad)).toBe(false);
    }
  });
});
