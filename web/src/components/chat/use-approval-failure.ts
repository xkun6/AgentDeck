// 审批卡片回应失败的统一处理（权限卡 / 提问卡共用）：
// PERMISSION_NOT_FOUND = 另一端（桌面 / 另一台手机）刚处理完，显示「已在其他设备处理」后移除卡片；
// 其它错误经 humanizeSidecarError 转成中文提示，卡片保留以便重试。
import { useCallback, useState } from "react";
import { useSetAtom } from "jotai";
import { humanizeSidecarError } from "@/hooks/use-agent-session";
import { SidecarRpcError } from "@/lib/sidecar-client";
import { removeApprovalAtom, type PendingApproval } from "@/stores/chat";

export const HANDLED_ELSEWHERE_MESSAGE = "已在其他设备处理";
/** 提示停留多久后移除卡片 */
export const HANDLED_ELSEWHERE_REMOVE_DELAY_MS = 1500;

export function isPermissionNotFound(error: unknown): boolean {
  return error instanceof SidecarRpcError && error.businessCode === "PERMISSION_NOT_FOUND";
}

export interface ApprovalFailureState {
  /** 需要展示的错误文案（已汉化）；null = 无 */
  error: string | null;
  /** 已在其他设备处理：卡片显示提示并禁用按钮，稍后被移除 */
  handledElsewhere: boolean;
  /** 回应失败时调用 */
  fail: (error: unknown, fallback: string) => void;
  clearError: () => void;
}

export function useApprovalFailure(approval: Pick<PendingApproval, "sessionId" | "requestId">): ApprovalFailureState {
  const removeApproval = useSetAtom(removeApprovalAtom);
  const [error, setError] = useState<string | null>(null);
  const [handledElsewhere, setHandledElsewhere] = useState(false);
  const { sessionId, requestId } = approval;

  const fail = useCallback(
    (cause: unknown, fallback: string) => {
      if (isPermissionNotFound(cause)) {
        setError(null);
        setHandledElsewhere(true);
        // 卡片可能在此期间因 permission_resolved 先被移除；移除本身幂等，所以不随卸载取消
        setTimeout(() => removeApproval({ sessionId, requestId }), HANDLED_ELSEWHERE_REMOVE_DELAY_MS);
        return;
      }
      setError(humanizeSidecarError(cause) || fallback);
    },
    [removeApproval, sessionId, requestId],
  );
  const clearError = useCallback(() => setError(null), []);

  return { error, handledElsewhere, fail, clearError };
}
