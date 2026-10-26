import { useMemo, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { useNavigate } from "react-router-dom";
import { Users } from "lucide-react";
import { Button, LoadingState } from "@agentdeck/shared-ui";
import { GroupDialog } from "@/components/group/group-dialog";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { agentListAtom, agentListLoadedAtom, sidecarConnectionAtom } from "@/stores/agents";
import { activeSessionIdAtom } from "@/stores/ui";
import { useAgentProviders } from "@/hooks/use-agent-catalog";
import { agentDisplayTitle, agentProviderLabel, isAgentRunning } from "@/lib/agent-session-display";
import { PanelComposer } from "@/components/panel/panel-composer";
import { PanelHero } from "@/components/panel/panel-hero";
import { QuickStart } from "@/components/panel/quick-start";
import { TaskCard } from "@/components/panel/task-card";
import type { PanelSession } from "@/components/panel/panel-session";
import s from "./panel.module.css";

export function PanelRoute() {
  const [, setActiveId] = useAtom(activeSessionIdAtom);
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const agents = useAtomValue(agentListAtom);
  const loaded = useAtomValue(agentListLoadedAtom);
  const connection = useAtomValue(sidecarConnectionAtom);
  const { data: providers } = useAgentProviders();
  const navigate = useNavigate();
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);

  const active = useMemo<PanelSession[]>(
    () =>
      agents
        .filter((agent) => isAgentRunning(agent, runtimeBySession[agent.id]))
        .map((agent) => ({
          agent,
          title: agentDisplayTitle(agent, runtimeBySession[agent.id], providers),
          provider: agentProviderLabel(agent.provider, providers),
        })),
    [agents, providers, runtimeBySession],
  );

  const goSession = (sess: PanelSession) => {
    setActiveId(sess.agent.id);
    navigate(`/tasks/${encodeURIComponent(sess.agent.id)}`);
  };

  return (
    <main className={s.pageWrap}>
      <div className={s.pageContent}>
        <PanelHero />
        <PanelComposer />
        <div className={s.starters}>
          <QuickStart />
          <Button variant="ghost" size="sm" onClick={() => setGroupDialogOpen(true)}>
            <Users size={14} aria-hidden="true" />
            并行协作
          </Button>
        </div>
        <GroupDialog open={groupDialogOpen} onClose={() => setGroupDialogOpen(false)} />

        {!loaded && connection !== "error" && connection !== "closed" ? (
          <LoadingState variant="block" label="正在连接 Agent 服务…" />
        ) : null}

        {active.length > 0 ? (
          <section className={s.section} aria-label="进行中">
            <h2 className={s.sectionTitle}>进行中</h2>
            <div className={s.taskGrid}>
              {active.map((sess) => (
                <TaskCard key={sess.agent.id} session={sess} onClick={() => goSession(sess)} />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}
