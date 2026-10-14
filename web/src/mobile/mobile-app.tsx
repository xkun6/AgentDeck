// 手机端最小壳：会话列表 ↔ 会话详情，用 location.hash 路由（Android 返回键走 history）。
import { useCallback, useEffect, useState } from "react";
import { useSidecarBridge } from "@/hooks/use-agent-session";
import { SessionList } from "./session-list";
import { SessionDetail } from "./session-detail";

function readAgentId(): string | null {
  const match = /^#\/s\/(.+)$/.exec(window.location.hash);
  return match ? decodeURIComponent(match[1]!) : null;
}

export function MobileApp() {
  useSidecarBridge();
  const [agentId, setAgentId] = useState<string | null>(readAgentId);

  useEffect(() => {
    const onHash = () => setAgentId(readAgentId());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const open = useCallback((id: string) => {
    window.location.hash = `#/s/${encodeURIComponent(id)}`;
  }, []);
  const back = useCallback(() => {
    if (window.history.length > 1) window.history.back();
    else window.location.hash = "";
  }, []);

  return agentId ? <SessionDetail key={agentId} agentId={agentId} onBack={back} /> : <SessionList onOpen={open} />;
}
