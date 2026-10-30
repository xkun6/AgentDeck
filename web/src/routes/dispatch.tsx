// 派单页（design.md 4.26）：总览列出所有主会话，详情显示一个主会话与它派发的子会话；点行打开与普通对话相同的页面。
import type { ReactNode } from "react";
import { useAtomValue } from "jotai";
import { useNavigate, useParams } from "react-router-dom";
import { ChevronRight, MessageSquare } from "lucide-react";
import { Badge, Button, LoadingState, StatusDot } from "@agentdeck/shared-ui";
import type { AgentSnapshot } from "@agentdeck/protocol";
import { useSessionActions } from "@/hooks/use-context-actions";
import { useAgentProviders } from "@/hooks/use-agent-catalog";
import { useDispatchGroups } from "@/hooks/use-dispatch-groups";
import { agentDisplayTitle, agentProviderLabel, formatAgentTime } from "@/lib/agent-session-display";
import {
  DISPATCH_STATUS_LABELS,
  DISPATCH_STATUS_TONES,
  dispatchSummaryText,
  type DispatchGroup,
  type DispatchNode,
  type DispatchStatus,
} from "@/lib/dispatch";
import { workspaceNameFromPath } from "@/lib/workspaces";
import { EntityContextMenu, type ContextMenuEntry } from "@/components/context-menu/entity-context-menu";
import { agentListLoadedAtom } from "@/stores/agents";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import s from "./dispatch.module.css";

function useTitleOf(): (agent: AgentSnapshot) => string {
  const runtimes = useAtomValue(chatRuntimeBySessionAtom);
  const { data: providers } = useAgentProviders();
  return (agent) => agentDisplayTitle(agent, runtimes[agent.id], providers);
}

function StatusLabel({ status }: { status: DispatchStatus }) {
  return (
    <span className={s.status} data-status={status}>
      <StatusDot tone={DISPATCH_STATUS_TONES[status]} size="xs" />
      {DISPATCH_STATUS_LABELS[status]}
    </span>
  );
}

function AgentMeta({ agent }: { agent: AgentSnapshot }) {
  const { data: providers } = useAgentProviders();
  return (
    <span className={s.meta} title={agent.cwd}>
      {[agentProviderLabel(agent.provider, providers), agent.model || "默认", workspaceNameFromPath(agent.cwd)]
        .filter(Boolean)
        .join(" · ")}
    </span>
  );
}

function RowShell({
  title,
  depth = 0,
  onClick,
  menu,
  children,
}: {
  title: string;
  depth?: number;
  onClick: () => void;
  menu: () => ContextMenuEntry[];
  children: ReactNode;
}) {
  return (
    <EntityContextMenu items={menu}>
      <div
        className={s.row}
        style={depth > 0 ? { paddingLeft: 12 + depth * 20 } : undefined}
        role="button"
        tabIndex={0}
        title={title}
        onClick={onClick}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onClick();
          }
        }}
      >
        {children}
      </div>
    </EntityContextMenu>
  );
}

function ChildRows({ nodes, depth = 0 }: { nodes: readonly DispatchNode[]; depth?: number }) {
  const sessionActions = useSessionActions();
  const titleOf = useTitleOf();
  const now = new Date();
  return (
    <>
      {nodes.map((node) => {
        const title = titleOf(node.agent);
        return (
          <div key={node.agent.id}>
            <RowShell
              title={title}
              depth={depth}
              onClick={() => sessionActions.openSession(node.agent)}
              menu={() => sessionActions.buildMenu(node.agent, title)}
            >
              <StatusLabel status={node.status} />
              <span className={s.rowTitle}>{title}</span>
              <AgentMeta agent={node.agent} />
              <span className={s.time}>{formatAgentTime(node.agent.updatedAt, now)}</span>
            </RowShell>
            {node.children.length > 0 ? <ChildRows nodes={node.children} depth={depth + 1} /> : null}
          </div>
        );
      })}
    </>
  );
}

function MasterRow({ group, master }: { group: DispatchGroup; master: DispatchNode }) {
  const navigate = useNavigate();
  const sessionActions = useSessionActions();
  const titleOf = useTitleOf();
  const title = titleOf(master.agent);
  return (
    <RowShell
      title={title}
      onClick={() => navigate(`/dispatch/${encodeURIComponent(master.agent.id)}`)}
      menu={() => sessionActions.buildMenu(master.agent, title)}
    >
      <StatusLabel status={master.status} />
      <span className={s.rowTitle}>{title}</span>
      <span className={s.summary} data-attention={group.summary.attention > 0 ? "true" : undefined}>
        {dispatchSummaryText(group.summary)}
      </span>
      <span className={s.time}>{formatAgentTime(master.agent.updatedAt, new Date())}</span>
      <ChevronRight size={14} className={s.chevron} aria-hidden="true" />
    </RowShell>
  );
}

export function DispatchOverviewRoute() {
  const groups = useDispatchGroups();
  const loaded = useAtomValue(agentListLoadedAtom);
  const masters = groups.filter((group) => group.master);
  const orphans = groups.find((group) => !group.master);
  // 有工作中或需要处理的排在前面，其余保持最近更新的顺序
  const sorted = [...masters].sort(
    (a, b) => Number(b.summary.working + b.summary.attention > 0) - Number(a.summary.working + a.summary.attention > 0),
  );
  return (
    <main className={s.page}>
      <header className={s.header}>
        <h1 className={s.title}>派单</h1>
      </header>
      {!loaded ? (
        <LoadingState variant="block" label="正在加载会话…" />
      ) : groups.length === 0 ? (
        <div className={s.empty}>还没有派单。让一个会话用 delegate 派发任务后，会在这里显示主会话和子会话。</div>
      ) : (
        <>
          {sorted.length > 0 ? (
            <section className={s.list}>
              {sorted.map((group) => (
                <MasterRow key={group.master!.agent.id} group={group} master={group.master!} />
              ))}
            </section>
          ) : null}
          {orphans ? (
            <section className={s.section}>
              <h2 className={s.sectionTitle}>主会话已删除</h2>
              <div className={s.list}>
                <ChildRows nodes={orphans.children} />
              </div>
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}

export function DispatchDetailRoute() {
  const { agentId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();
  const sessionActions = useSessionActions();
  const titleOf = useTitleOf();
  const groups = useDispatchGroups({ includeArchived: true });
  const loaded = useAtomValue(agentListLoadedAtom);
  const group = groups.find((entry) => entry.master?.agent.id === agentId);
  if (!group?.master) {
    return (
      <main className={s.page}>
        {loaded ? (
          <div className={s.empty}>
            <p>这个会话没有派发子会话，或主会话已被删除。</p>
            <Button variant="outline" onClick={() => navigate("/dispatch")}>返回派单总览</Button>
          </div>
        ) : (
          <LoadingState variant="block" label="正在加载会话…" />
        )}
      </main>
    );
  }
  const { master, summary } = { master: group.master, summary: group.summary };
  return (
    <main className={s.page}>
      <nav className={s.crumbs} aria-label="派单导航">
        <button type="button" className={s.crumb} onClick={() => navigate("/dispatch")}>派单</button>
        <ChevronRight size={12} aria-hidden="true" />
        <span className={s.crumbCurrent}>{titleOf(master.agent)}</span>
      </nav>
      <header className={s.header}>
        <div className={s.headerMain}>
          <h1 className={s.title}>{titleOf(master.agent)}</h1>
          <StatusLabel status={master.status} />
          {master.agent.archived ? <Badge>已归档</Badge> : null}
        </div>
        <Button variant="outline" onClick={() => sessionActions.openSession(master.agent)}>
          <MessageSquare size={16} aria-hidden="true" />
          打开对话
        </Button>
      </header>
      <div className={s.subhead}>
        <AgentMeta agent={master.agent} />
        <span className={s.summary} data-attention={summary.attention > 0 ? "true" : undefined}>
          {dispatchSummaryText(summary)}
        </span>
      </div>
      <section className={s.list}>
        <ChildRows nodes={group.children} />
      </section>
    </main>
  );
}
