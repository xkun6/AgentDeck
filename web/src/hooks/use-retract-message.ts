import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentPromptInput } from "@agentdeck/protocol";

export const RETRACT_UNAVAILABLE_NOTICE = "Agent 已开始响应，无法撤回";
const NOTICE_MS = 4000;

export interface RetractPrefill {
  text: string;
  files: File[];
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function base64ToFile(data: string, mimeType: string, index: number): File {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const ext = EXTENSION_BY_MIME[mimeType] ?? mimeType.split("/")[1] ?? "bin";
  return new File([bytes], `image-${index + 1}.${ext}`, { type: mimeType });
}

/** 把撤回返回的 prompt 还原成输入框文本 + 图片文件（design.md 4.16）。 */
export function promptToPrefill(prompt: AgentPromptInput): RetractPrefill {
  if (typeof prompt === "string") return { text: prompt, files: [] };
  const texts: string[] = [];
  const files: File[] = [];
  for (const part of prompt) {
    if (part.type === "text") texts.push(part.text);
    else files.push(base64ToFile(part.data, part.mimeType, files.length));
  }
  return { text: texts.join("\n"), files };
}

interface UseRetractMessageOptions {
  retract: () => Promise<{ prompt: AgentPromptInput }>;
  onPrefill: (prefill: RetractPrefill) => void;
  /** 撤回成功（中断前）回调：宿主据此抑制队列自动出队。 */
  onRetracted?: () => void;
  /** 撤回失败回调：宿主据此复位 onRetracted 里提前置位的状态。 */
  onRetractFailed?: () => void;
}

/** 撤回按钮 / ↑ 键共用：防重复、成功回填、失败短提示。 */
export function useRetractMessage({
  retract,
  onPrefill,
  onRetracted,
  onRetractFailed,
}: UseRetractMessageOptions) {
  const [retracting, setRetracting] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const busyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const run = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setRetracting(true);
    setNotice(undefined);
    try {
      onRetracted?.();
      const { prompt } = await retract();
      onPrefill(promptToPrefill(prompt));
    } catch {
      onRetractFailed?.();
      setNotice(RETRACT_UNAVAILABLE_NOTICE);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setNotice(undefined), NOTICE_MS);
    } finally {
      busyRef.current = false;
      setRetracting(false);
    }
  }, [onPrefill, onRetracted, onRetractFailed, retract]);

  return { retracting, notice, run };
}
