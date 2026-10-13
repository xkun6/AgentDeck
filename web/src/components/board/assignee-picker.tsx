// 看板任务 / 默认指派的「Agent + 模型 + 模式」选择：复用新建会话的 AgentSessionPicker，
// 但选择状态由调用方持有（不写入新建会话的记忆）。思考强度不属于指派，目录里去掉。
import { useMemo } from "react";
import type { BoardAssignee } from "@agentdeck/protocol";
import { AgentSessionPicker } from "@/components/composer/agent-session-picker";
import { useAgentCatalog, useAgentProviders } from "@/hooks/use-agent-catalog";
import { humanizeSidecarError } from "@/hooks/use-agent-session";
import s from "./board-panels.module.css";

interface AssigneePickerProps {
  value: BoardAssignee | null;
  onChange: (next: BoardAssignee | null) => void;
  /** 目录（模型 / 模式）按该项目目录取 */
  cwd: string;
  /** 允许「使用看板默认指派」（value 为 null）；默认指派本身不允许 */
  allowInherit?: boolean;
}

export function AssigneePicker({ value, onChange, cwd, allowInherit = false }: AssigneePickerProps) {
  const providersQuery = useAgentProviders();
  const providers = providersQuery.data ?? null;
  const provider = value?.provider ?? null;
  const catalogQuery = useAgentCatalog(provider, cwd);
  const catalog = useMemo(() => {
    const data = catalogQuery.data;
    if (!data) return null;
    return {
      modes: data.modes,
      models: data.models.map(({ thinkingOptions: _thinking, ...model }) => model),
    };
  }, [catalogQuery.data]);

  const pickerPart = (
    <AgentSessionPicker
      selection={{ provider, model: value?.model ?? null, modeId: value?.modeId ?? null }}
      onChange={(next) =>
        onChange(
          next.provider
            ? {
                provider: next.provider,
                ...(next.model ? { model: next.model } : {}),
                ...(next.modeId ? { modeId: next.modeId } : {}),
              }
            : null,
        )
      }
      providers={providers}
      providersError={providersQuery.error ? humanizeSidecarError(providersQuery.error) : undefined}
      catalog={catalog}
      catalogLoading={catalogQuery.isLoading}
      catalogError={catalogQuery.error ? humanizeSidecarError(catalogQuery.error) : undefined}
    />
  );

  if (!allowInherit) {
    return pickerPart;
  }
  return (
    <div className={s.assignee}>
      <label className={s.check}>
        <input
          type="checkbox"
          checked={value === null}
          onChange={(event) => {
            if (event.target.checked) {
              onChange(null);
            } else {
              const first = providers?.find((item) => item.available) ?? providers?.[0];
              onChange(first ? { provider: first.id } : null);
            }
          }}
        />
        <span>使用看板默认指派</span>
      </label>
      {value ? pickerPart : null}
    </div>
  );
}
