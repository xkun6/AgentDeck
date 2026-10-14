// 把文本编码成 QR 码的 SVG path（design.md 4.31 配对二维码）。只用 qrcode 的矩阵，不拼 HTML 字符串，
// 由组件用 <svg><path/></svg> 渲染，避免 dangerouslySetInnerHTML。
import QRCode from "qrcode";

export interface QrSvgData {
  /** viewBox 边长（含四周静区） */
  size: number;
  /** 黑色模块的 path 数据（横向连续的模块合并成一条矩形） */
  path: string;
}

/** 静区：QR 规范要求至少 4 个模块 */
const QUIET_ZONE = 4;

export function buildQrSvg(text: string): QrSvgData {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const data = qr.modules.data;
  const parts: string[] = [];
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (!data[y * n + x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < n && data[y * n + x]) x += 1;
      parts.push(`M${start + QUIET_ZONE} ${y + QUIET_ZONE}h${x - start}v1h-${x - start}z`);
    }
  }
  return { size: n + QUIET_ZONE * 2, path: parts.join("") };
}

/** 倒计时文本，如 "04:59"；到期后为 "00:00" */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
