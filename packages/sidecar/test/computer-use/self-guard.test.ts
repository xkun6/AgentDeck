// Computer Use 防自指（design.md 4.37）
import { describe, expect, test } from "vitest";

import {
  KEYBOARD_REFUSAL,
  SCAN_DEPTH_REFUSAL,
  SELF_REGION_REFUSAL,
  SELF_TARGET_REFUSAL,
  collectPoints,
  desktopPoints,
  isUntargetedKeyboardCall,
  mentionsWindowId,
  parseWindows,
  refuseSelfRegionCall,
  refuseSelfTargetedCall,
  stripSelfFromText,
  stripSelfFromValue,
  type DriverWindow,
} from "../../src/computer-use/self-guard.js";

const HOST = 4242;
const SELF = { pids: new Set([HOST, 9]), windowIds: new Set([0x1a2b]) };

describe("入参寻址", () => {
  test("顶层与 target 内的 pid / window_id 都会被拦下", () => {
    expect(refuseSelfTargetedCall({ pid: HOST, key: "return" }, SELF)).toBe(SELF_TARGET_REFUSAL);
    expect(
      refuseSelfTargetedCall({ target: { kind: "window", pid: 100, window_id: 0x1a2b }, x: 1, y: 2 }, SELF),
    ).toBe(SELF_TARGET_REFUSAL);
    expect(refuseSelfTargetedCall({ pid: 9 }, SELF)).toBe(SELF_TARGET_REFUSAL);
    expect(refuseSelfTargetedCall({ target: { kind: "window", pid: 100, window_id: 7 } }, SELF)).toBeNull();
  });

  test("嵌套深到扫不完时拒绝", () => {
    let nested: Record<string, unknown> = { pid: 1 };
    for (let i = 0; i < 20; i += 1) nested = { inner: nested };
    expect(refuseSelfTargetedCall(nested, SELF)).toBe(SCAN_DEPTH_REFUSAL);
    expect(mentionsWindowId(nested)).toBe(true);
  });
});

describe("无目标键盘输入", () => {
  test("按工具名或参数形态识别，带 pid / window_id 的不算", () => {
    expect(isUntargetedKeyboardCall("press_key", { key: "return" })).toBe(true);
    expect(isUntargetedKeyboardCall("type_text", { text: "hi", target: { kind: "desktop", display_id: "primary" } })).toBe(true);
    expect(isUntargetedKeyboardCall("hold_key", { keys: ["ctrl", "w"] })).toBe(true);
    expect(isUntargetedKeyboardCall("press_key", { key: "return", pid: 100 })).toBe(false);
    expect(isUntargetedKeyboardCall("clipboard_write", { text: "hi" })).toBe(false);
  });

  test("拒绝理由会引导模型带上目标窗口", () => {
    expect(KEYBOARD_REFUSAL).toContain("pid");
  });
});

describe("桌面坐标", () => {
  test("收集 x/y、from_x/from_y、to_x/to_y、x1/y1 等坐标对", () => {
    expect(collectPoints({ x: 1, y: 2 })).toEqual([{ x: 1, y: 2 }]);
    expect(collectPoints({ from_x: 1, from_y: 2, to_x: 3, to_y: 4 })).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
    expect(collectPoints({ x1: 5, y1: 6, x2: 7, y2: 8 })).toEqual([
      { x: 5, y: 6 },
      { x: 7, y: 8 },
    ]);
    expect(collectPoints({ max_image_dimension: 1000, text: "x" })).toEqual([]);
  });

  test("带 pid / window_id 时坐标相对窗口，不按桌面判断", () => {
    expect(desktopPoints({ target: { kind: "window", pid: 1, window_id: 2 }, x: 1, y: 1 })).toEqual([]);
    expect(desktopPoints({ target: { kind: "desktop", display_id: "primary" }, x: 1, y: 1 })).toEqual([{ x: 1, y: 1 }]);
  });

  const windows: DriverWindow[] = [
    { pid: HOST, window_id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, is_on_screen: true, z_index: 1 },
    { pid: 500, window_id: 2, bounds: { x: 400, y: 300, width: 400, height: 300 }, is_on_screen: true, z_index: 2 },
    { pid: 600, window_id: 3, bounds: { x: 0, y: 0, width: 200, height: 200 }, minimized: true, z_index: 9 },
  ];

  test("按 z_index 取真正接收点击的窗口：宿主在最上面才拒绝", () => {
    expect(refuseSelfRegionCall([{ x: 100, y: 100 }], windows, SELF.pids)).toBe(SELF_REGION_REFUSAL);
    expect(refuseSelfRegionCall([{ x: 500, y: 400 }], windows, SELF.pids)).toBeNull();
    expect(refuseSelfRegionCall([{ x: 900, y: 900 }], windows, SELF.pids)).toBeNull();
    // drag 的终点落在宿主上同样拒绝
    expect(refuseSelfRegionCall([{ x: 900, y: 900 }, { x: 10, y: 10 }], windows, SELF.pids)).toBe(SELF_REGION_REFUSAL);
  });

  test("截图被缩放时按还原后的坐标再判一次", () => {
    const host = [{ ...windows[0]!, bounds: { x: 600, y: 400, width: 200, height: 200 } }];
    expect(refuseSelfRegionCall([{ x: 350, y: 250 }], host, SELF.pids)).toBeNull();
    expect(refuseSelfRegionCall([{ x: 350, y: 250 }], host, SELF.pids, 2)).toBe(SELF_REGION_REFUSAL);
    expect(refuseSelfRegionCall([{ x: 300, y: 250 }], [windows[1]!], SELF.pids, 2)).toBeNull();
  });

  test("z_index 缺失时任一自身窗口包含该点即拒绝", () => {
    const unknown = windows.map(({ z_index: _z, ...rest }) => rest);
    expect(refuseSelfRegionCall([{ x: 500, y: 400 }], unknown, SELF.pids)).toBe(SELF_REGION_REFUSAL);
  });

  test("parseWindows 取 list_windows 的结构化结果", () => {
    expect(
      parseWindows({
        windows: [
          { window_id: 1, pid: HOST, app_name: "AgentDeck", title: "", bounds: { x: 0, y: 0, width: 1, height: 1 }, is_on_screen: true, z_index: 3 },
          { window_id: "bad" },
        ],
      }),
    ).toEqual([{ pid: HOST, window_id: 1, bounds: { x: 0, y: 0, width: 1, height: 1 }, is_on_screen: true, z_index: 3 }]);
    expect(parseWindows({})).toBeNull();
  });
});

describe("出参过滤", () => {
  test("剔除结构化结果与文本 JSON 里的自身记录，摘要文字原样保留", () => {
    const structured = {
      windows: [
        { pid: HOST, window_id: 1, title: "AgentDeck" },
        { pid: 500, window_id: 2, title: "记事本" },
      ],
    };
    expect(stripSelfFromValue(structured, SELF.pids)).toEqual({ windows: [structured.windows[1]] });
    expect(stripSelfFromValue({ windows: [structured.windows[1]] }, SELF.pids)).toBeUndefined();

    const text = `✅ Windows listed\n${JSON.stringify(structured)}\n共 2 个`;
    expect(stripSelfFromText(text, SELF.pids)).toBe(
      `✅ Windows listed\n${JSON.stringify({ windows: [structured.windows[1]] })}\n共 2 个`,
    );
    expect(stripSelfFromText("no json {here", SELF.pids)).toBe("no json {here");
  });
});
