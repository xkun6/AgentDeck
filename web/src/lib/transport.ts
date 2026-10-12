// 桌面端本地能力的薄包装（Hermes REST 已删除）：
// - raceAbort：让原生 IPC 调用可被 AbortSignal 取消；
// - readFileDataUrl / fetchMediaDataUrl：经 Rust 读取本机图片为 data URL。

function abortError(): DOMException | Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function abortPromise(signal?: AbortSignal | null): Promise<never> | null {
  if (!signal) return null;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

export async function raceAbort<T>(work: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  const aborted = abortPromise(signal);
  if (!aborted) return work;
  // abort 胜出后底层（原生 IPC）的 work 仍在后台跑，若它随后 reject 会变成
  // unhandled rejection——在“快速切换”这一高频场景里尤其刷屏。兜底吞掉它。
  work.catch(() => {});
  return Promise.race([work, aborted]);
}

/** 把本机图片路径读成 data URL（仅桌面端可用）。 */
export async function fetchMediaDataUrl(path: string): Promise<string> {
  const reader = window.hermesDesktop?.readFileDataUrl;
  if (!reader) throw new Error("当前环境无法读取本机图片");
  const dataUrl = await reader(path);
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
    throw new Error("读取结果不是图片 data URL");
  }
  return dataUrl;
}

export async function readFileDataUrl(path: string): Promise<string | null> {
  const reader = window.hermesDesktop?.readFileDataUrl;
  if (!reader) return null;
  try {
    const dataUrl = await reader(path);
    return dataUrl || null;
  } catch {
    return null;
  }
}
