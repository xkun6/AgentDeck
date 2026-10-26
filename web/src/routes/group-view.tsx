// 并行协作视图（design.md 4.27）：成员会话并排（只读时间线 + 状态，per-member 时可查看 diff），底部为汇总结果。
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowRight, GitCompareArrows, MessageSquare, Trash2 } from "lucide-react";
import { Badge, Button, LoadingState, StatusDot, type StatusDotTone } from "@agentdeck/shared-ui";
import type { AgentGroup, AgentGroupMember, AgentSnapshot } from "@agentdeck/protocol";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { useAgentProviders } from "@/hooks/use-agent-catalog";
import { useConfirm } from "@/lib/use-confirm";
import {
  AGENT_STATUS_LABELS,
  agentProviderLabel,
  isAgentRunning,
} from "@/lib/agent-session-display";
import { CHAIR_MODE_LABELS, GROUP_STATUS_LABELS, lastAssistantMessageText } from "@/lib/group-display";
import { agentSnapshotsAtom, sidecarConnectionAtom } from "@/stores/agents";
import { chatRuntimeBySessionAtom, createEmptyChatRuntime } from "@/stores/chat";
import { groupsStateAtom } from "@/stores/groups";
import { activeSessionIdAtom } from "@/stores/ui";
import { agentUIMessagesToChatMessages } from "@/components/chat/message-adapter";
import { MessageText } from "@/components/chat/message-text";
import { MessageTimeline } from "@/components/chat/message-timeline";
import { ReviewTab } from "@/components/chat/preview-rail/review-tab";
import s from "./group-view.module.css";

const GROUP_STATUS_TONES: Record<AgentGroup["status"], "info" | "accent" | "success" | "danger"> = {
  running: "info",
  chairing: "accent",
  done: "success",
  failed: "danger",
};

function agentTone(agent: AgentSnapshot | undefined, running: boolean): StatusDotTone {
  if (running) return "success";
  if (agent?.status === "error") return "danger";
  return "neutral";
}

/** 打开某个会话的时间线（回放 agent.timeline 重建运行态）。 */
function useAgentTimelineLoaded(agentId: string | undefined): { loading: boolean; error?: string } {
  const actions = useAgentSession();
  const connected = useAtomValue(sidecarConnectionAtom) === "open";
  const [state, setState] = useState<{ id: string | undefined; loading: boolean; error?: string }>({
    id: undefined,
    loading: false,
  });
  useEffect(() => {
    if (!agentId || !connected) return;
    let cancelled = false;
    setState({ id: agentId, loading: true });
    actions.loadTimeline(agentId).then(
      () => {
        if (!cancelled) setState({ id: agentId, loading: false });
      },
      (error: unknown) => {
        if (!cancelled) setState({ id: agentId, loading: false, error: humanizeSidecarError(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [actions, agentId, connected]);
  if (state.id !== agentId) return { loading: Boolean(agentId) };
  return { loading: state.loading, ...(state.error ? { error: state.error } : {}) };
}

function useOpenSession() {
  const navigate = useNavigate();
  const setActiveId = useSetAtom(activeSessionIdAtom);
  return (agentId: string) => {
    setActiveId(agentId);
    navigate(`/tasks/${encodeURIComponent(agentId)}`);
  };
}

interface MemberColumnProps {
  member: AgentGroupMember;
  index: number;
}

function MemberColumn({ member, index }: MemberColumnProps) {
  const snapshots = useAtomValue(agentSnapshotsAtom);
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const { data: providers } = useAgentProviders();
  const openSession = useOpenSession();
  const [diffOpen, setDiffOpen] = useState(false);
  const timeline = useAgentTimelineLoaded(member.agentId);

  const agent = snapshots[member.agentId];
  const runtime = runtimeBySession[member.agentId] ?? createEmptyChatRuntime();
  const running = agent ? isAgentRunning(agent, runtimeBySession[member.agentId]) : false;
  const providerLabel = agentProviderLabel(member.provider, providers);
  const messages = useMemo(() => agentUIMessagesToChatMessages(runtime.messages), [runtime.messages]);
  const statusLabel = running ? AGENT_STATUS_LABELS.running : agent ? AGENT_STATUS_LABELS[agent.status] : "未知";

  return (
    <section className={s.column} aria-label={`成员 ${index + 1}：${providerLabel}`}>
      <header className={s.columnHead}>
        <div className={s.columnTitle}>
          <StatusDot tone={agentTone(agent, running)} size="xs" />
          <span className={s.columnName}>
            {index + 1}. {providerLabel}
          </span>
          {member.model ? <span className={s.columnModel}>{member.model}</span> : null}
          <span className={s.columnStatus}>{statusLabel}</span>
        </div>
        <div className={s.columnActions}>
          {member.worktree ? (
            <Button variant="ghost" aria-pressed={diffOpen} onClick={() => setDiffOpen((open) => !open)}>
              <GitCompareArrows size={16} aria-hidden="true" />
              {diffOpen ? "返回时间线" : "查看 diff"}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => openSession(member.agentId)}>
            进入会话
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
        </div>
      </header>
      {member.worktree ? (
        <div className={s.branch} title={member.worktree.path}>
          分支 {member.worktree.branch}
        </div>
      ) : null}
      <div className={s.columnBody}>
        {diffOpen && member.worktree ? (
          <ReviewTab workspaceRoot={member.worktree.path} active />
        ) : timeline.error ? (
          <div className={s.error}>{timeline.error}</div>
        ) : (
          <MessageTimeline
            messages={messages}
            loading={timeline.loading && messages.length === 0}
            assistantName={providerLabel}
            turnStartedAt={running ? runtime.turnStartedAt : undefined}
            density="compact"
          />
        )}
      </div>
    </section>
  );
}

function ChairResult({ group }: { group: AgentGroup }) {
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const { data: providers } = useAgentProviders();
  const openSession = useOpenSession();
  const chair = group.chair;
  const chairAgentId = chair?.agentId;
  const timeline = useAgentTimelineLoaded(chairAgentId);
  const text = lastAssistantMessageText(chairAgentId ? (runtimeBySession[chairAgentId]?.messages ?? []) : []);
  if (!chair) return null;

  let body: ReactNode;
  if (!chairAgentId) {
    body = <p className={s.muted}>{group.status === "failed" ? "汇总会话未能创建。" : "等待全部成员完成后开始汇总…"}</p>;
  } else if (text) {
    body = (
      <div className={s.chairText}>
        <MessageText text={text} />
      </div>
    );
  } else if (timeline.error) {
    body = <p className={s.error}>{timeline.error}</p>;
  } else {
    body = <p className={s.muted}>{group.status === "failed" ? "汇总没有产出回答。" : "汇总进行中…"}</p>;
  }

  return (
    <section className={s.chair} aria-label="汇总结果">
      <header className={s.chairHead}>
        <span className={s.chairTitle}>
          汇总结果（{CHAIR_MODE_LABELS[chair.mode]}，{agentProviderLabel(chair.provider, providers)}
          {chair.model ? `，${chair.model}` : ""}）
        </span>
        {chairAgentId ? (
          <Button variant="ghost" onClick={() => openSession(chairAgentId)}>
            <MessageSquare size={16} aria-hidden="true" />
            进入会话
          </Button>
        ) : null}
      </header>
      {body}
    </section>
  );
}

export function GroupViewRoute() {
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();
  const actions = useAgentSession();
  const { confirm } = useConfirm();
  const { groups, loaded } = useAtomValue(groupsStateAtom);
  const group = groupId ? groups[groupId] : undefined;
  const [deleting, setDeleting] = useState(false);

  // 协作组被删除（本页、其它窗口）后回到首页
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (group) setSeen(true);
  }, [group]);
  useEffect(() => {
    if (seen && !group) navigate("/", { replace: true });
  }, [seen, group, navigate]);

  if (!group) {
    return (
      <main className={s.page}>
        {loaded ? (
          <div className={s.empty}>
            <p>协作组不存在或已被删除。</p>
            <Button variant="outline" onClick={() => navigate("/")}>返回首页</Button>
          </div>
        ) : (
          <LoadingState variant="block" label="正在加载协作组…" />
        )}
      </main>
    );
  }

  const hasWorktrees = group.members.some((member) => member.worktree);

  const onDelete = async () => {
    const confirmed = await confirm({
      title: "删除协作组",
      body: "确定删除这个协作组？成员会话与汇总会话会保留（只解除分组），不会被删除。",
      confirmLabel: "删除协作组",
      danger: true,
    });
    if (!confirmed) return;
    const removeWorktrees = hasWorktrees
      ? await confirm({
          title: "同时删除 worktree？",
          body: "成员的独立 worktree 与对应分支里未合并的改动将永久丢失；运行中的成员会先被中断。",
          confirmLabel: "同时删除",
          cancelLabel: "保留 worktree",
          danger: true,
        })
      : false;
    setDeleting(true);
    try {
      const warnings = await actions.deleteGroup(group.id, removeWorktrees);
      if (warnings.length > 0) {
        await confirm({
          title: "协作组已删除，部分 worktree 未能清理",
          body: warnings.join("\n"),
          confirmLabel: "知道了",
          cancelLabel: "关闭",
        });
      }
      navigate("/", { replace: true });
    } catch (error) {
      setDeleting(false);
      await confirm({
        title: "删除失败",
        body: humanizeSidecarError(error),
        confirmLabel: "知道了",
        cancelLabel: "关闭",
      });
    }
  };

  return (
    <main className={s.page}>
      <header className={s.header}>
        <div className={s.headerMain}>
          <h1 className={s.title}>{group.title}</h1>
          <Badge tone={GROUP_STATUS_TONES[group.status]}>{GROUP_STATUS_LABELS[group.status]}</Badge>
          <span className={s.cwd} title={group.cwd}>{group.cwd}</span>
        </div>
        <Button variant="outline" tone="danger" loading={deleting} onClick={() => void onDelete()}>
          <Trash2 size={16} aria-hidden="true" />
          删除协作组
        </Button>
      </header>
      <p className={s.prompt} title={group.prompt}>{group.prompt}</p>
      {group.members.length === 0 ? (
        <div className={s.empty}>
          <p>所有成员会话都已被删除。</p>
        </div>
      ) : (
        <div className={s.columns} data-count={group.members.length}>
          {group.members.map((member, index) => (
            <MemberColumn key={member.agentId} member={member} index={index} />
          ))}
        </div>
      )}
      <ChairResult group={group} />
    </main>
  );
}
