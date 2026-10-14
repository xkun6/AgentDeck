// M0 验证用打点：console.log 在 Android WebView 中会进 logcat（chromium 标签），带毫秒时间戳。
export function m0Log(message: string): void {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
  console.log(`[m0] ${stamp} ${message}`);
}
