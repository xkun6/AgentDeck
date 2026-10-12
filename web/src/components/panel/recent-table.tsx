import { useMemo, useState } from "react";
import { formatTokens, relativeTime } from "@/lib/format";
import { Dot } from "@/components/ui/pill";
import { AGENT_STATUS_LABELS } from "@/lib/agent-session-display";
import { sessionTokens, shortId, type PanelSession } from "./panel-session";
import s from "./recent-table.module.css";

const COLLAPSED_ROWS = 5;
const PAGE_SIZE = 20;

// Compact page list with ellipsis: always show first + last + 1-page neighbors of current.
// Examples (current/total): 1/10 → [1,2,…,10] · 5/10 → [1,…,4,5,6,…,10] · 10/10 → [1,…,9,10]
function buildPageItems(current: number, total: number): Array<number | "..."> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const items: Array<number | "..."> = [1];
  const left = Math.max(2, current - 1);
  const right = Math.min(total - 1, current + 1);
  if (left > 2) items.push("...");
  for (let i = left; i <= right; i += 1) items.push(i);
  if (right < total - 1) items.push("...");
  items.push(total);
  return items;
}

interface RecentTableProps {
  sessions: PanelSession[];
  onOpen: (session: PanelSession) => void;
}

export function RecentTable({ sessions, onOpen }: RecentTableProps) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(1);

  if (sessions.length === 0) {
    return (
      <div className={s.wrap}>
        <div className={s.empty}>暂无会话</div>
      </div>
    );
  }

  const canCollapse = sessions.length > COLLAPSED_ROWS;
  const showPager = expanded && canCollapse;

  const totalPages = Math.max(1, Math.ceil(sessions.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const startIdx = expanded ? (safePage - 1) * PAGE_SIZE + 1 : 1;
  const endIdx = expanded
    ? Math.min(safePage * PAGE_SIZE, sessions.length)
    : Math.min(COLLAPSED_ROWS, sessions.length);
  const sliced = expanded
    ? sessions.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
    : sessions.slice(0, COLLAPSED_ROWS);

  return (
    <>
      <div className={s.wrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th style={{ width: 80 }}>ID</th>
              <th>标题</th>
              <th style={{ width: 112 }}>Agent</th>
              <th style={{ width: 132 }}>模型</th>
              <th style={{ width: 112 }}>更新</th>
              <th style={{ width: 92 }} className={s.numeric}>Tokens</th>
            </tr>
          </thead>
          <tbody>
            {sliced.map((sess) => {
              const { agent } = sess;
              const isError = agent.status === "error";
              return (
                <tr key={agent.id} onClick={() => onOpen(sess)}>
                  <td className={s.mono}>{shortId(agent.id)}</td>
                  <td>
                    <span className={s.titleCell} data-error={isError ? "true" : undefined}>
                      {sess.title}
                      {isError && " — 出错"}
                    </span>
                  </td>
                  <td className={s.mono}>{sess.provider}</td>
                  <td className={s.mono}>{agent.model || "—"}</td>
                  <td>
                    <span className={s.statusCell} title={AGENT_STATUS_LABELS[agent.status]}>
                      {isError && <Dot tone="err" />}
                      {relativeTime(agent.updatedAt / 1000)}
                    </span>
                  </td>
                  <td className={s.numeric}>
                    {formatTokens(sessionTokens(agent))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className={s.foot}>
        <span>
          显示 {startIdx}–{endIdx} / {sessions.length}
        </span>
        {showPager ? (
          <span className={s.pager}>
            {buildPageItems(safePage, totalPages).map((item, idx) =>
              item === "..." ? (
                <span key={`gap-${idx}`} className={s.pageGap}>…</span>
              ) : (
                <button
                  key={item}
                  className={s.pageBtn}
                  data-active={item === safePage ? "true" : undefined}
                  onClick={() => setPage(item)}
                  aria-label={`第 ${item} 页`}
                  aria-current={item === safePage ? "page" : undefined}
                >
                  {item}
                </button>
              ),
            )}
            <button
              type="button"
              className={s.expandLink}
              onClick={() => {
                setExpanded(false);
                setPage(1);
              }}
            >
              收起 ↑
            </button>
          </span>
        ) : canCollapse ? (
          <button
            type="button"
            className={s.expandLink}
            onClick={() => setExpanded(true)}
          >
            查看全部 →
          </button>
        ) : null}
      </div>
    </>
  );
}
