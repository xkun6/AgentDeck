// `/mcp` 打开的 MCP 服务器面板（design.md 4.14）：打开即拉 agent.mcp.status；
// reconnect 为 server（Claude）时逐个重连，为 all（Codex）时整体重新加载。
import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { AgentMcpServer, AgentMcpServerStatus, AgentMcpStatusResult } from "@agentdeck/protocol";
import { Badge, Button, Dialog, IconButton, LoadingState, type BadgeTone } from "@agentdeck/shared-ui";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import s from "./mcp-servers-dialog.module.css";

const STATUS_META: Record<AgentMcpServerStatus, { label: string; tone: BadgeTone; order: number }> = {
  failed: { label: "连接失败", tone: "danger", order: 0 },
  "needs-auth": { label: "需要认证", tone: "warning", order: 1 },
  pending: { label: "连接中", tone: "warning", order: 2 },
  connected: { label: "已连接", tone: "success", order: 3 },
  disabled: { label: "已禁用", tone: "neutral", order: 4 },
};

/** 按状态（failed → needs-auth → pending → connected → disabled）再按名称排序。 */
export function sortMcpServers(servers: readonly AgentMcpServer[]): AgentMcpServer[] {
  return servers.slice().sort(
    (a, b) => STATUS_META[a.status].order - STATUS_META[b.status].order || a.name.localeCompare(b.name),
  );
}

interface McpServersDialogProps {
  open: boolean;
  agentId: string;
  onClose: () => void;
}

export function McpServersDialog({ open, agentId, onClose }: McpServersDialogProps) {
  const actions = useAgentSession();
  const [result, setResult] = useState<AgentMcpStatusResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadingAll, setReloadingAll] = useState(false);
  const [reconnecting, setReconnecting] = useState<Record<string, boolean>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  // 关闭 / 换会话后丢弃过期的响应
  const generationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = generationRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await actions.mcpStatus(agentId);
      if (generation !== generationRef.current) return;
      setResult(next);
      setRowErrors({});
    } catch (err) {
      if (generation === generationRef.current) setError(humanizeSidecarError(err));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [actions, agentId]);

  useEffect(() => {
    generationRef.current += 1;
    setResult(null);
    setError(null);
    setLoading(false);
    setReloadingAll(false);
    setReconnecting({});
    setRowErrors({});
    if (open) void load();
  }, [agentId, load, open]);

  const reconnectServer = async (name: string) => {
    const generation = generationRef.current;
    setReconnecting((current) => ({ ...current, [name]: true }));
    setRowErrors(({ [name]: _removed, ...rest }) => rest);
    try {
      const next = await actions.mcpReconnect(agentId, name);
      if (generation === generationRef.current) setResult(next);
    } catch (err) {
      if (generation === generationRef.current) {
        setRowErrors((current) => ({ ...current, [name]: humanizeSidecarError(err) }));
      }
    } finally {
      if (generation === generationRef.current) {
        setReconnecting(({ [name]: _removed, ...rest }) => rest);
      }
    }
  };

  const reloadAll = async () => {
    const generation = generationRef.current;
    setReloadingAll(true);
    setError(null);
    try {
      const next = await actions.mcpReconnect(agentId);
      if (generation === generationRef.current) setResult(next);
    } catch (err) {
      if (generation === generationRef.current) setError(humanizeSidecarError(err));
    } finally {
      if (generation === generationRef.current) setReloadingAll(false);
    }
  };

  const servers = result ? sortMcpServers(result.servers) : [];
  const busy = loading || reloadingAll;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className={s.dialog} aria-describedby={undefined}>
          <div className={s.head}>
            <Dialog.Title asChild>
              <h2 className={s.title}>MCP 服务器</h2>
            </Dialog.Title>
            <div className={s.headActions}>
              {result?.reconnect === "all" ? (
                <Button size="sm" variant="outline" onClick={() => void reloadAll()} disabled={busy}>
                  {reloadingAll ? "重新加载中…" : "重新加载 MCP"}
                </Button>
              ) : null}
              <Button size="sm" variant="outline" onClick={() => void load()} disabled={busy}>
                {loading && result ? "刷新中…" : "刷新"}
              </Button>
              <Dialog.Close asChild>
                <IconButton aria-label="关闭">
                  <X size={16} aria-hidden="true" />
                </IconButton>
              </Dialog.Close>
            </div>
          </div>
          {result?.reconnect === "all" ? (
            <p className={s.note}>Codex 会重新读取 MCP 配置，并在下一轮对话时重新连接</p>
          ) : null}
          <div className={s.body}>
            {error ? <p className={s.error} role="alert">{error}</p> : null}
            {!result && loading ? <LoadingState label="正在读取 MCP 状态…" /> : null}
            {result && servers.length === 0 ? <p className={s.empty}>未配置 MCP 服务器</p> : null}
            {servers.length > 0 ? (
              <ul className={s.list}>
                {servers.map((server) => {
                  const meta = STATUS_META[server.status];
                  const pending = reconnecting[server.name] === true;
                  const rowError = rowErrors[server.name];
                  return (
                    <li key={server.name} className={s.row} data-status={server.status}>
                      <div className={s.rowMain}>
                        <div className={s.rowHead}>
                          <span className={s.name}>{server.name}</span>
                          <Badge tone={meta.tone} size="sm">{meta.label}</Badge>
                          {typeof server.toolCount === "number" ? (
                            <span className={s.meta}>{server.toolCount} 个工具</span>
                          ) : null}
                          {server.scope ? <span className={s.meta}>{server.scope}</span> : null}
                        </div>
                        {server.error ? <p className={s.rowError}>{server.error}</p> : null}
                        {rowError ? <p className={s.rowError} role="alert">{rowError}</p> : null}
                      </div>
                      {result?.reconnect === "server" && server.status !== "disabled" ? (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => void reconnectServer(server.name)}
                          disabled={pending || busy}
                          aria-label={pending ? `正在重连 ${server.name}` : `重连 ${server.name}`}
                        >
                          {pending ? "重连中…" : "重连"}
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
