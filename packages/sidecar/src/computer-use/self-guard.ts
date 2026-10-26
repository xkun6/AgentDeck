// Derived from LiveAgent crates/agent-gui/src/lib/tools/cuaSelfGuard.ts (MIT); modified for AgentDeck
// 改动：在 sidecar 代理里执行（design.md 4.37）；自身窗口与桌面坐标改用驱动自己的 list_windows 判断
// （按 z_index 找真正接收点击的窗口）；坐标对扩展到 from_x/from_y、to_x/to_y、x1/y1 等；
// 无目标键盘输入一律拒绝（sidecar 无法判断前台窗口）；出参同时过滤 structuredContent。
//
// 让模型操作 AgentDeck 自己的窗口是危险的自指：它能点掉审批弹窗（等于绕过审批）、改设置、或直接把应用关掉。
// 驱动没有「排除某个应用」的机制，所以这道闸开在宿主侧。

/** 自身身份：进程（Tauri 主进程 + sidecar）与窗口（Windows 上 window_id 即 HWND） */
export interface SelfIdentity {
  pids: ReadonlySet<number>;
  windowIds: ReadonlySet<number>;
}

/** 驱动 `list_windows` 的一条记录（只取用到的字段） */
export interface DriverWindow {
  pid: number | null;
  window_id: number;
  bounds: { x: number; y: number; width: number; height: number };
  is_on_screen?: boolean;
  minimized?: boolean | null;
  z_index?: number | null;
}

export interface Point {
  x: number;
  y: number;
}

const SETTING_HINT = "（如确需自动化 AgentDeck 本身，在「设置 → Computer Use」中打开「允许操作 AgentDeck 自身」。）";

export const SELF_TARGET_REFUSAL =
  "该目标是 AgentDeck 自身的进程或窗口，已被拒绝：让模型操作宿主界面可以绕过工具审批、改写设置或直接关闭应用。" +
  `请改为操作其他应用。${SETTING_HINT}`;

export const SELF_REGION_REFUSAL =
  "该坐标处是 AgentDeck 自身的窗口，已被拒绝：按屏幕坐标操作宿主界面同样可以点掉审批弹窗或改写设置。" +
  `请改为操作其他应用的窗口，或先把目标窗口移到前面。${SETTING_HINT}`;

export const KEYBOARD_REFUSAL =
  "没有指定目标窗口的键盘输入会落在当前前台应用上，而 AgentDeck 无法确认前台不是它自己（可能按掉审批弹窗），已被拒绝。" +
  "请在参数里带上目标窗口的 pid（以及 window_id），例如 {\"target\":{\"kind\":\"window\",\"pid\":…,\"window_id\":…}}；" +
  "Windows 上带 pid 的键盘输入直接投递给该窗口，不需要它在前台。";

export const SCAN_DEPTH_REFUSAL =
  "调用参数的嵌套层级超出了安全检查的上限，已被拒绝：无法确认它是否以 AgentDeck 自身为目标。请用扁平一些的参数重试。";

export const WINDOWS_UNKNOWN_REFUSAL =
  "无法读取当前窗口列表，不能确认这次操作的目标不是 AgentDeck 自身，已被拒绝。请稍后重试。";

/** 递归深度上限：超出时当作命中处理（扫不完就放行等于给出一条现成的绕过方式） */
const MAX_SCAN_DEPTH = 12;

/** 各家写法里表示进程 id 的字段名 */
const PID_KEYS = ["pid", "process_id", "processId", "owner_pid", "ownerPid"] as const;

/** 各家写法里表示窗口 id 的字段名 */
const WINDOW_ID_KEYS = ["window_id", "windowId"] as const;

/** 投递语义是「发给键盘焦点」的工具 */
const FOCUS_DELIVERY_TOOLS = new Set(["type_text", "press_key", "hotkey"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type ScanResult = "hit" | "truncated" | "clear";

/**
 * 深度遍历，对每个对象节点调用 `visit`。三态而非布尔：调用方要区分「确认安全」和「没能确认」。
 */
function scanRecords(node: unknown, visit: (record: Record<string, unknown>) => boolean, depth = 0): ScanResult {
  if (depth > MAX_SCAN_DEPTH) {
    return "truncated";
  }
  if (Array.isArray(node)) {
    return scanChildren(node, visit, depth);
  }
  const record = asRecord(node);
  if (!record) {
    return "clear";
  }
  if (visit(record)) {
    return "hit";
  }
  return scanChildren(Object.values(record), visit, depth);
}

function scanChildren(
  values: unknown[],
  visit: (record: Record<string, unknown>) => boolean,
  depth: number,
): ScanResult {
  let truncated = false;
  for (const value of values) {
    const result = scanRecords(value, visit, depth + 1);
    if (result === "hit") {
      return "hit";
    }
    if (result === "truncated") {
      truncated = true;
    }
  }
  return truncated ? "truncated" : "clear";
}

/** 参数里是否带了 window_id（需要先取自身窗口才能判断） */
export function mentionsWindowId(args: Record<string, unknown>): boolean {
  return (
    scanRecords(args, (record) => WINDOW_ID_KEYS.some((key) => readNumber(record[key]) !== null)) !== "clear"
  );
}

/** 参数里是否带了任何进程 / 窗口身份 */
function hasIdentity(args: Record<string, unknown>): boolean {
  return (
    scanRecords(args, (record) =>
      [...PID_KEYS, ...WINDOW_ID_KEYS].some((key) => readNumber(record[key]) !== null),
    ) === "hit"
  );
}

/** 入参寻址：pid / window_id 指向自身 → 拒绝；扫不完同样拒绝 */
export function refuseSelfTargetedCall(args: Record<string, unknown>, self: SelfIdentity): string | null {
  const result = scanRecords(args, (record) => {
    if (PID_KEYS.some((key) => self.pids.has(readNumber(record[key]) ?? Number.NaN))) {
      return true;
    }
    return WINDOW_ID_KEYS.some((key) => self.windowIds.has(readNumber(record[key]) ?? Number.NaN));
  });
  if (result === "hit") {
    return SELF_TARGET_REFUSAL;
  }
  return result === "truncated" ? SCAN_DEPTH_REFUSAL : null;
}

/**
 * 无明确进程身份的键盘输入：按工具名认，或按参数形态兜底（字符串 `key` / 字符串数组 `keys`），
 * 且参数里没有任何 pid / window_id。`text` 不参与形态兜底（clipboard_write 等也带 text，与焦点无关）。
 */
export function isUntargetedKeyboardCall(toolName: string, args: Record<string, unknown>): boolean {
  const byName = FOCUS_DELIVERY_TOOLS.has(toolName.trim().toLowerCase());
  const byShape =
    !byName &&
    scanRecords(args, (record) => {
      if (typeof record.key === "string") {
        return true;
      }
      return Array.isArray(record.keys) && record.keys.some((key) => typeof key === "string");
    }) === "hit";
  return (byName || byShape) && !hasIdentity(args);
}

/**
 * 键名里 `x` 所在的位置：`x` 必须是一个独立片段——前面是开头或 `_`，后面是结尾或数字。
 * 命中 x、from_x、to_x、x1、x2；不命中 max_x_offset 之类以外的普通单词。
 */
function coordinateAxisIndex(key: string): number {
  for (let index = key.length - 1; index >= 0; index -= 1) {
    if (key[index] !== "x") {
      continue;
    }
    const before = index === 0 || key[index - 1] === "_";
    const after = /^\d*$/.test(key.slice(index + 1));
    if (before && after) {
      return index;
    }
  }
  return -1;
}

/** 参数里所有坐标对（`<前缀>x<后缀>` 与 `<前缀>y<后缀>` 同为数字） */
export function collectPoints(args: Record<string, unknown>): Point[] {
  const points: Point[] = [];
  scanRecords(args, (record) => {
    for (const [key, value] of Object.entries(record)) {
      const x = readNumber(value);
      const index = coordinateAxisIndex(key);
      if (x === null || index < 0) {
        continue;
      }
      const y = readNumber(record[`${key.slice(0, index)}y${key.slice(index + 1)}`]);
      if (y !== null) {
        points.push({ x, y });
      }
    }
    return false;
  });
  return points;
}

/**
 * 按桌面屏幕坐标解释的点：参数里没有任何 pid / window_id 时，坐标是桌面绝对坐标
 * （`target.kind` 为 window 却不带身份的调用寻址不到任何窗口，同样按桌面处理，fail-closed）。
 * 带身份的调用坐标相对该窗口，而窗口本身是不是宿主已由 `refuseSelfTargetedCall` 判过。
 */
export function desktopPoints(args: Record<string, unknown>): Point[] {
  return hasIdentity(args) ? [] : collectPoints(args);
}

function contains(window: DriverWindow, point: Point): boolean {
  const { x, y, width, height } = window.bounds;
  return point.x >= x && point.x < x + width && point.y >= y && point.y < y + height;
}

/**
 * 实际接收该点的窗口：包含该点、在屏且未最小化的窗口里 z_index 最大的一个。
 * 有窗口缺 z_index 时无法确定层叠顺序，返回 null，由调用方按「任一自身窗口包含即拒绝」处理。
 */
function windowAtPoint(windows: readonly DriverWindow[], point: Point): DriverWindow | null | undefined {
  const hits = windows.filter(
    (window) => window.is_on_screen !== false && window.minimized !== true && contains(window, point),
  );
  if (hits.some((window) => typeof window.z_index !== "number")) {
    return null;
  }
  let top: DriverWindow | undefined;
  for (const window of hits) {
    if (!top || (window.z_index as number) > (top.z_index as number)) {
      top = window;
    }
  }
  return top;
}

/**
 * 桌面坐标检查：任一点（及按截图缩放比还原后的点）落在自身窗口上 → 拒绝。
 * `scale` 为最近一次 get_desktop_state 的「原图宽 / 截图宽」（截图被缩放时 > 1）。
 */
export function refuseSelfRegionCall(
  points: readonly Point[],
  windows: readonly DriverWindow[],
  selfPids: ReadonlySet<number>,
  scale = 1,
): string | null {
  const isSelf = (window: DriverWindow) => window.pid !== null && selfPids.has(window.pid);
  const variants = points.flatMap((point) =>
    scale > 1 ? [point, { x: point.x * scale, y: point.y * scale }] : [point],
  );
  for (const point of variants) {
    const top = windowAtPoint(windows, point);
    if (top === null) {
      if (windows.some((window) => isSelf(window) && window.minimized !== true && contains(window, point))) {
        return SELF_REGION_REFUSAL;
      }
    } else if (top && isSelf(top)) {
      return SELF_REGION_REFUSAL;
    }
  }
  return null;
}

/** 从 list_windows 的结构化结果里取窗口列表；格式不对返回 null */
export function parseWindows(value: unknown): DriverWindow[] | null {
  const list = asRecord(value)?.windows;
  if (!Array.isArray(list)) {
    return null;
  }
  const windows: DriverWindow[] = [];
  for (const entry of list) {
    const record = asRecord(entry);
    const bounds = asRecord(record?.bounds);
    const windowId = readNumber(record?.window_id);
    const x = readNumber(bounds?.x);
    const y = readNumber(bounds?.y);
    const width = readNumber(bounds?.width);
    const height = readNumber(bounds?.height);
    if (!record || windowId === null || x === null || y === null || width === null || height === null) {
      continue;
    }
    windows.push({
      pid: readNumber(record.pid),
      window_id: windowId,
      bounds: { x, y, width, height },
      ...(typeof record.is_on_screen === "boolean" ? { is_on_screen: record.is_on_screen } : {}),
      ...(typeof record.minimized === "boolean" ? { minimized: record.minimized } : {}),
      ...(readNumber(record.z_index) !== null ? { z_index: readNumber(record.z_index) } : {}),
    });
  }
  return windows;
}

/**
 * 剔除 JSON 值里 pid 属于自身的数组元素：不剔的话模型下一步就会拿着这些 id 来敲门。
 * 没有改动时返回 undefined（调用方保留原值）。
 */
export function stripSelfFromValue(value: unknown, selfPids: ReadonlySet<number>): unknown {
  let changed = false;
  const visit = (node: unknown, depth: number): unknown => {
    if (depth > MAX_SCAN_DEPTH) {
      return node;
    }
    if (Array.isArray(node)) {
      const kept = node.filter((entry) => {
        const record = asRecord(entry);
        if (!record || !PID_KEYS.some((key) => selfPids.has(readNumber(record[key]) ?? Number.NaN))) {
          return true;
        }
        changed = true;
        return false;
      });
      return kept.map((entry) => visit(entry, depth + 1));
    }
    const record = asRecord(node);
    if (!record) {
      return node;
    }
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      next[key] = visit(child, depth + 1);
    }
    return next;
  };
  const result = visit(value, 0);
  return changed ? result : undefined;
}

/**
 * 从 `from` 起找出下一段结构完整的 JSON 的区间。驱动的文本块常是「一行摘要 + 一段 JSON」，
 * 扫描时要认字符串字面量与转义，否则字符串里的花括号会把配对算错。
 */
function findJsonSpan(text: string, from: number): { start: number; end: number } | null {
  for (let i = from; i < text.length; i += 1) {
    const open = text[i];
    if (open !== "{" && open !== "[") {
      continue;
    }
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j += 1) {
      const char = text[j];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === open) {
        depth += 1;
      } else if (char === close) {
        depth -= 1;
        if (depth === 0) {
          return { start: i, end: j + 1 };
        }
      }
    }
    // 从这里开始的括号没有配平，再往后找也只会落进同一段未闭合文本
    return null;
  }
  return null;
}

/** 剔除一条结果文本里每段 JSON 中的自身记录；JSON 片段前后的摘要文字原样保留 */
export function stripSelfFromText(text: string, selfPids: ReadonlySet<number>): string {
  let out = "";
  let cursor = 0;
  let changed = false;
  for (let span = findJsonSpan(text, cursor); span; span = findJsonSpan(text, cursor)) {
    const raw = text.slice(span.start, span.end);
    let replacement = raw;
    try {
      const stripped = stripSelfFromValue(JSON.parse(raw), selfPids);
      if (stripped !== undefined) {
        replacement = JSON.stringify(stripped);
        changed = true;
      }
    } catch {
      // 不是合法 JSON：保留原文
    }
    out += text.slice(cursor, span.start) + replacement;
    cursor = span.end;
  }
  return changed ? out + text.slice(cursor) : text;
}
