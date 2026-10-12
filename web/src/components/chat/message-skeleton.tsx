import { LoadingState } from "@agentdeck/shared-ui";

export function MessageSkeleton() {
  return <LoadingState variant="page" label="正在加载对话…" />;
}
