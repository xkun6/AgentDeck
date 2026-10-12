import { useMemo } from "react";
import { useAtom, useAtomValue } from "jotai";
import { useNavigate } from "react-router-dom";
import { LoadingState } from "@agentdeck/shared-ui";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { agentListAtom, agentListLoadedAtom, sidecarConnectionAtom } from "@/stores/agents";
import { activeSessionIdAtom } from "@/stores/ui";
import { useAgentProviders } from "@/hooks/use-agent-catalog";
import { agentDisplayTitle, agentProviderLabel, isAgentRunning } from "@/lib/agent-session-display";
import { PanelComposer } from "@/components/panel/panel-composer";
import { PanelHero } from "@/components/panel/panel-hero";
import { QuickStart } from "@/components/panel/quick-start";
import { RecentTable } from "@/components/panel/recent-table";
import { TaskCard } from "@/components/panel/task-card";
import type { PanelSession } from "@/components/panel/panel-session";
import s from "./panel.module.css";

const TODAY_START_MS = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

interface SectionProps {
  num: string;
  tag: string;
  title: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
}

function Section({ num, tag, title, meta, children }: SectionProps) {
  return (
    <section className={s.section}>
      <div className={s.sectionNum}>§ {num}</div>
      <div className={s.sectionBody}>
        <div className={s.sectionHead}>
          <div className={s.sectionLh}>
            <span className={s.sectionTag}>[ {tag} ]</span>
            <h2 className={s.sectionTitle}>{title}</h2>
          </div>
          {meta && <div className={s.sectionMeta}>{meta}</div>}
        </div>
        {children}
      </div>
    </section>
  );
}

export function PanelRoute() {
  const [, setActiveId] = useAtom(activeSessionIdAtom);
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const agents = useAtomValue(agentListAtom);
  const loaded = useAtomValue(agentListLoadedAtom);
  const connection = useAtomValue(sidecarConnectionAtom);
  const { data: providers } = useAgentProviders();
  const navigate = useNavigate();

  const sessions = useMemo<PanelSession[]>(
    () =>
      agents.map((agent) => ({
        agent,
        title: agentDisplayTitle(agent, runtimeBySession[agent.id], providers),
        provider: agentProviderLabel(agent.provider, providers),
      })),
    [agents, providers, runtimeBySession],
  );

  const { active, recent } = useMemo(() => {
    const active = sessions.filter((session) => isAgentRunning(session.agent, runtimeBySession[session.agent.id]));
    const recent = sessions.filter((session) => !isAgentRunning(session.agent, runtimeBySession[session.agent.id]));
    return { active, recent };
  }, [runtimeBySession, sessions]);

  // sidecar 不记录回合结束原因：今日更新且出错的会话计入「需要关注」，其余今日活跃会话计入「已完成」。
  const todayStats = useMemo(() => {
    const start = TODAY_START_MS();
    let completed = 0;
    let needsAttention = 0;
    for (const { agent } of recent) {
      if (agent.updatedAt < start) continue;
      if (agent.status === "error") needsAttention += 1;
      else completed += 1;
    }
    return { completed, needsAttention };
  }, [recent]);

  const goSession = (sess: PanelSession) => {
    setActiveId(sess.agent.id);
    navigate(`/tasks/${encodeURIComponent(sess.agent.id)}`);
  };

  return (
    <main className={s.pageWrap} data-page-texture="pinhole">
      <div className={s.pageContent}>
        <PanelHero
          activeCount={active.length}
          completedToday={todayStats.completed}
          needsAttention={todayStats.needsAttention}
        />

        <Section num="01" tag="开始" title="新任务">
          <PanelComposer />
        </Section>

        {!loaded && connection !== "error" && connection !== "closed" ? (
          <LoadingState variant="block" label="正在连接 Agent 服务…" />
        ) : null}

        {active.length > 0 && (
          <Section
            num="02"
            tag="运行中"
            title="正在执行"
            meta={`${active.length} 个任务 · 自动刷新`}
          >
            <div className={s.taskGrid}>
              {active.map((sess) => (
                <TaskCard key={sess.agent.id} session={sess} onClick={() => goSession(sess)} />
              ))}
            </div>
          </Section>
        )}

        <Section
          num={active.length > 0 ? "03" : "02"}
          tag="近况"
          title="最近会话"
          meta={`共 ${recent.length} 个`}
        >
          <RecentTable sessions={recent} onOpen={goSession} />
        </Section>

        <Section
          num={active.length > 0 ? "04" : "03"}
          tag="模板"
          title="快速起手"
          meta="点击预填到 Composer"
        >
          <QuickStart />
        </Section>
      </div>
    </main>
  );
}
