// 历史页的会话内容搜索（design.md 4.19）：输入非空时 300ms 防抖后调用 agent.search。
import { useEffect, useRef, useState } from "react";
import type { AgentSearchHit } from "@agentdeck/protocol";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";

export const CONTENT_SEARCH_DEBOUNCE_MS = 300;

export interface ContentSearchState {
  /** 已经（或正在）搜索的查询词；空串表示未搜索 */
  query: string;
  hits: AgentSearchHit[];
  truncated: boolean;
  loading: boolean;
  error: string | null;
}

const IDLE: ContentSearchState = { query: "", hits: [], truncated: false, loading: false, error: null };

export function useContentSearch(rawQuery: string): ContentSearchState {
  const actions = useAgentSession();
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const query = rawQuery.trim();
  const [state, setState] = useState<ContentSearchState>(IDLE);

  useEffect(() => {
    if (!query) {
      setState((prev) => (prev === IDLE ? prev : IDLE));
      return;
    }
    let cancelled = false;
    setState((prev) => ({ ...prev, query, loading: true, error: null }));
    const timer = setTimeout(() => {
      Promise.resolve().then(() => actionsRef.current.searchSessions(query)).then(
        ({ hits, truncated }) => {
          if (!cancelled) setState({ query, hits, truncated, loading: false, error: null });
        },
        (error: unknown) => {
          if (!cancelled) {
            setState({ query, hits: [], truncated: false, loading: false, error: humanizeSidecarError(error) });
          }
        },
      );
    }, CONTENT_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  return state;
}
