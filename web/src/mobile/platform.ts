// 手机端对运行环境的探测与原生能力封装（Tauri Android 才有扫码与 plugin-store）。
import { DEFAULT_DEVICE_NAME, createLocalStorageHostStorage, createTauriStoreHostStorage, type HostStorage } from "@/lib/remote/hosts";

export function isTauriShell(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

/** Tauri 下用 plugin-store，浏览器 / 测试用 localStorage */
export function createHostStorage(): HostStorage {
  return isTauriShell() ? createTauriStoreHostStorage() : createLocalStorageHostStorage();
}

/** 从 UA 里取设备型号（"…; Android 14; Pixel 8 Build/…)" → Pixel 8）；取不到（含 Chrome 精简 UA 的 "K"）用默认名 */
export function detectDeviceName(userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  const match = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?\s*[;)]/.exec(userAgent);
  const model = match?.[1]?.trim();
  if (!model || model.length < 2 || model === "K" || /^Android/i.test(model)) return DEFAULT_DEVICE_NAME;
  return model;
}

export type ScanOutcome = { ok: true; content: string } | { ok: false; message: string; canceled?: boolean };

/** 调起原生扫码（仅 Tauri Android）；权限被拒、用户取消都转成中文说明 */
export async function scanPairingQr(): Promise<ScanOutcome> {
  try {
    const scanner = await import("@tauri-apps/plugin-barcode-scanner");
    let permission = await scanner.checkPermissions();
    if (permission !== "granted") permission = await scanner.requestPermissions();
    if (permission !== "granted") {
      return { ok: false, message: "没有相机权限：请在系统设置里允许 AgentDeck 使用相机，或改用「粘贴配对链接」" };
    }
    const result = await scanner.scan({ formats: [scanner.Format.QRCode], windowed: false });
    return { ok: true, content: result.content };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/cancel/i.test(message)) return { ok: false, message: "已取消扫码", canceled: true };
    return { ok: false, message: `扫码失败：${message}` };
  }
}
