import { useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import type { ProviderInfo } from "@agentdeck/protocol";
import { agentListAtom, agentListLoadedAtom, sidecarConnectionAtom } from "@/stores/agents";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import {
  AGENT_STATUS_LABELS,
  agentDisplayTitle,
  agentProviderLabel,
  formatAgentTime,
  isAgentRunning,
} from "@/lib/agent-session-display";
import s from "./mobile.module.css";

const CWD_KEY = "agentdeck-m0-cwd";
const DEFAULT_CWD = "J:/Program/Agent/AgentDeck/tmp";

const CONNECTION_LABELS: Record<string, string> = {
  idle: "未连接",
  connecting: "连接中…",
  open: "已连接",
  closed: "已断开",
  error: "连接失败",
};

export function SessionList({ onOpen }: { onOpen: (agentId: string) => void }) {
  const agents = useAtomValue(agentListAtom);
  const loaded = useAtomValue(agentListLoadedAtom);
  const connection = useAtomValue(sidecarConnectionAtom);
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const actions = useAgentSession();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [creating, setCreating] = useState(false);
  const [provider, setProvider] = useState("mock");
  const [cwd, setCwd] = useState(() => localStorage.getItem(CWD_KEY) ?? DEFAULT_CWD);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (connection !== "open") return;
    actions.listProviders().then(setProviders, () => {});
  }, [actions, connection]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => new Date(), [agents]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem(CWD_KEY, cwd);
      const agent = await actions.createSession({ provider, cwd });
      setCreating(false);
      onOpen(agent.id);
    } catch (e) {
      setError(humanizeSidecarError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.page}>
      <header className={s.header}>
        <h1 className={s.title}>会话</h1>
        <span className={s.conn} data-state={connection}>
          {CONNECTION_LABELS[connection] ?? connection}
        </span>
        <button type="button" className={s.primaryButton} onClick={() => setCreating((v) => !v)}>
          新建
        </button>
      </header>
      {creating ? (
        <div className={s.sheet}>
          <label className={s.field}>
            <span>Agent</span>
            <select value={provider} onChange={(e) => setProvider(e.target.value)} className={s.control}>
              {providers.length === 0 ? <option value="mock">mock</option> : null}
              {providers.map((item) => (
                <option key={item.id} value={item.id} disabled={!item.available}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className={s.field}>
            <span>工作目录</span>
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} className={s.control} />
          </label>
          {error ? <div className={s.error}>{error}</div> : null}
          <button type="button" className={s.primaryButton} disabled={busy || !cwd.trim()} onClick={() => void create()}>
            {busy ? "创建中…" : "创建会话"}
          </button>
        </div>
      ) : null}
      <ul className={s.list}>
        {agents.map((agent) => {
          const runtime = runtimeBySession[agent.id];
          const running = isAgentRunning(agent, runtime);
          return (
            <li key={agent.id}>
              <button type="button" className={s.row} onClick={() => onOpen(agent.id)}>
                <span className={s.rowTitle}>{agentDisplayTitle(agent, runtime, providers)}</span>
                <span className={s.rowMeta}>
                  <span data-running={running ? "true" : undefined}>{AGENT_STATUS_LABELS[agent.status]}</span>
                  <span>{agentProviderLabel(agent.provider, providers)}</span>
                  <span>{agent.lastSeq} 条</span>
                  <span>{formatAgentTime(agent.updatedAt, now)}</span>
                </span>
              </button>
            </li>
          );
        })}
        {loaded && agents.length === 0 ? <li className={s.empty}>还没有会话，点右上角「新建」</li> : null}
        {!loaded ? <li className={s.empty}>{connection === "open" ? "加载中…" : "等待连接 Agent 服务…"}</li> : null}
      </ul>
    </div>
  );
}
