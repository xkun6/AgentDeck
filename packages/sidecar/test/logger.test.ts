import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LOG_ROTATE_BYTES, createLogger } from "../src/logger.js";

describe("sidecar.log 启动轮转", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "agentdeck-logger-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("超过 10MB 时重命名为 .1（覆盖旧的）并新建", () => {
    writeFileSync(path.join(dir, "sidecar.log"), Buffer.alloc(LOG_ROTATE_BYTES + 1, "a"));
    writeFileSync(path.join(dir, "sidecar.log.1"), "old");
    const logger = createLogger({ logDir: dir, stderr: false });
    logger.info("hello");
    logger.close();
    expect(readFileSync(path.join(dir, "sidecar.log.1")).length).toBe(LOG_ROTATE_BYTES + 1);
    const text = readFileSync(path.join(dir, "sidecar.log"), "utf8");
    expect(text).toContain("hello");
    expect(text).not.toContain("aaaa");
  });

  it("未超限时继续追加，不产生 .1", () => {
    writeFileSync(path.join(dir, "sidecar.log"), "previous\n");
    const logger = createLogger({ logDir: dir, stderr: false });
    logger.info("next");
    logger.close();
    const text = readFileSync(path.join(dir, "sidecar.log"), "utf8");
    expect(text).toContain("previous");
    expect(text).toContain("next");
    expect(existsSync(path.join(dir, "sidecar.log.1"))).toBe(false);
  });
});
