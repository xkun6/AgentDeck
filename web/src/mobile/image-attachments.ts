// 手机端图片附件：发送前在前端压缩（长边 ≤ 2048px、转 JPEG、质量 0.85，压缩后单张 ≤ 5MB），最多 4 张。
// 压缩结果以 base64 放进 AgentPromptInput 的 { type: "image", data, mimeType }（走 lib/agent-prompt.ts 的 prepareAgentPrompt）。
import type { ComposerAttachment } from "@/components/chat/composer-types";

export const IMAGE_LIMITS = {
  maxCount: 4,
  maxLongEdge: 2048,
  jpegQuality: 0.85,
  maxBytes: 5 * 1024 * 1024,
} as const;

/** 面向用户的图片错误（message 已是中文） */
export class ImageAttachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageAttachError";
  }
}

export interface DraftImage {
  id: string;
  name: string;
  /** 恒为 image/jpeg */
  mimeType: string;
  /** 压缩后的 JPEG 字节数 */
  size: number;
  /** data:image/jpeg;base64,…，既用于缩略图预览也用于发送 */
  previewUrl: string;
}

export interface DecodedImage {
  width: number;
  height: number;
  /** 底层可绘制对象（ImageBitmap / HTMLImageElement），仅 browserImageEnv 使用 */
  source?: unknown;
  /** 释放位图资源 */
  close?(): void;
}

/** 解码与编码的底层实现（浏览器用 canvas；测试里替换） */
export interface ImageEnv {
  decode(file: Blob): Promise<DecodedImage>;
  encode(image: DecodedImage, width: number, height: number, type: string, quality: number): Promise<Blob>;
}

/** 等比缩到长边不超过 maxLongEdge；已经够小的不放大 */
export function fitWithin(width: number, height: number, maxLongEdge: number): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) return { width, height };
  const scale = maxLongEdge / longEdge;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
    reader.addEventListener("error", () => reject(new ImageAttachError("读取图片失败")), { once: true });
    reader.readAsDataURL(blob);
  });
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

let counter = 0;

/** 压缩一张图片：长边 ≤ 2048、JPEG 0.85；压缩后仍大于 5MB 则拒绝 */
export async function compressImage(file: File, env: ImageEnv = browserImageEnv): Promise<DraftImage> {
  if (file.type && !file.type.startsWith("image/")) throw new ImageAttachError("不是图片文件");
  let decoded: DecodedImage;
  try {
    decoded = await env.decode(file);
  } catch {
    throw new ImageAttachError("无法读取这张图片（格式可能不受支持）");
  }
  try {
    const { width, height } = fitWithin(decoded.width, decoded.height, IMAGE_LIMITS.maxLongEdge);
    const blob = await env.encode(decoded, width, height, "image/jpeg", IMAGE_LIMITS.jpegQuality);
    if (blob.size > IMAGE_LIMITS.maxBytes) {
      throw new ImageAttachError(
        `压缩后仍有 ${formatMegabytes(blob.size)}，超过 ${formatMegabytes(IMAGE_LIMITS.maxBytes)} 的上限`,
      );
    }
    const previewUrl = await readAsDataUrl(blob);
    counter += 1;
    const baseName = (file.name || "照片").replace(/\.[^./\\]+$/, "") || "照片";
    return { id: `img-${Date.now()}-${counter}`, name: `${baseName}.jpg`, mimeType: "image/jpeg", size: blob.size, previewUrl };
  } finally {
    decoded.close?.();
  }
}

export interface AddImagesResult {
  images: DraftImage[];
  /** 面向用户的提示（超出数量 / 单张失败），为空表示全部成功 */
  errors: string[];
}

/** 把新选的图片依次压缩后追加到已有列表，总数不超过 maxCount；单张失败不影响其它张 */
export async function addImages(
  existing: DraftImage[],
  files: File[],
  compress: (file: File) => Promise<DraftImage> = compressImage,
): Promise<AddImagesResult> {
  const errors: string[] = [];
  const room = Math.max(0, IMAGE_LIMITS.maxCount - existing.length);
  const accepted = files.slice(0, room);
  if (files.length > accepted.length) {
    errors.push(`最多附 ${IMAGE_LIMITS.maxCount} 张图片，已忽略多出的 ${files.length - accepted.length} 张`);
  }
  const images = [...existing];
  for (const file of accepted) {
    try {
      images.push(await compress(file));
    } catch (error) {
      errors.push(`${file.name || "图片"}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { images, errors };
}

/** 草稿图片 → 提交给 prepareAgentPrompt 的附件（data URL 已在 previewUrl 里） */
export function imagesToAttachments(images: DraftImage[]): ComposerAttachment[] {
  return images.map((image) => ({
    id: image.id,
    source: "browser",
    name: image.name,
    kind: "image",
    status: "ready",
    size: image.size,
    mimeType: image.mimeType,
    previewUrl: image.previewUrl,
  }));
}

/**
 * 协议里没有「provider 支持图片」的能力字段（ProviderCapabilities 只有 steer / fork），所以不预先禁用按钮；
 * 带图发送失败时在原错误后补一句明确提示，让用户知道可能是 Agent 不收图片。
 */
export function describeImageSendFailure(message: string, imageCount: number): string {
  if (imageCount === 0) return message;
  return `${message}（本条带有 ${imageCount} 张图片；如果当前 Agent 不支持图片，请去掉图片后重试）`;
}

/** 浏览器实现：优先 createImageBitmap（按 EXIF 方向），不行退回 <img>；编码时先铺白底，避免透明 PNG 变黑 */
export const browserImageEnv: ImageEnv = {
  async decode(file) {
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
        return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close() };
      } catch {
        // 退回 <img>
      }
    }
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.decoding = "async";
      image.src = url;
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight, source: image };
    } finally {
      URL.revokeObjectURL(url);
    }
  },
  async encode(image, width, height, type, quality) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new ImageAttachError("当前环境不支持图片压缩");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image.source as CanvasImageSource, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
    if (!blob) throw new ImageAttachError("图片压缩失败");
    return blob;
  },
};
