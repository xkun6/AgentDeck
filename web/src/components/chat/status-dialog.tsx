// `/status` 打开的状态面板（design.md 4.14）：打开即拉 agent.status，按分组显示两列键值表，可刷新。
import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { AgentStatusSection } from "@agentdeck/protocol";
import { Button, Dialog, IconButton, LoadingState } from "@agentdeck/shared-ui";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import s from "./status-dialog.module.css";

interface StatusDialogProps {
  open: boolean;
  agentId: string;
  onClose: () => void;
}

export function StatusDialog({ open, agentId, onClose }: StatusDialogProps) {
  const actions = useAgentSession();
  const [sections, setSections] = useState<AgentStatusSection[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 关闭 / 换会话后丢弃过期的响应
  const generationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = generationRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await actions.status(agentId);
      if (generation === generationRef.current) setSections(next);
    } catch (err) {
      if (generation === generationRef.current) setError(humanizeSidecarError(err));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [actions, agentId]);

  useEffect(() => {
    generationRef.current += 1;
    setSections(null);
    setError(null);
    setLoading(false);
    if (open) void load();
  }, [agentId, load, open]);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className={s.dialog} aria-describedby={undefined}>
          <div className={s.head}>
            <Dialog.Title asChild>
              <h2 className={s.title}>状态</h2>
            </Dialog.Title>
            <div className={s.headActions}>
              <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
                {loading && sections ? "刷新中…" : "刷新"}
              </Button>
              <Dialog.Close asChild>
                <IconButton aria-label="关闭">
                  <X size={16} aria-hidden="true" />
                </IconButton>
              </Dialog.Close>
            </div>
          </div>
          <div className={s.body}>
            {error ? <p className={s.error} role="alert">{error}</p> : null}
            {!sections && loading ? <LoadingState label="正在读取状态…" /> : null}
            {sections?.map((section) => (
              <section key={section.title} className={s.section}>
                <h3 className={s.sectionTitle}>{section.title}</h3>
                <dl className={s.rows}>
                  {section.rows.map((row, index) => (
                    <div key={`${row.label}-${index}`} className={s.row}>
                      <dt className={s.label}>{row.label}</dt>
                      <dd className={s.value}>{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
