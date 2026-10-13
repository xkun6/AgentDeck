// 「文件快照」设置页（design.md 4.24，高级设置下）：开关、maxFiles / maxFileBytes、各工作目录占用与清理。
// 与 sidecar 通信只走 use-agent-session。
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { Button } from "@agentdeck/shared-ui";
import type { SidecarSettings, SidecarSettingsPatch } from "@agentdeck/protocol";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { formatSnapshotBytes } from "@/lib/snapshots";
import { useConfirm } from "@/lib/use-confirm";
import { sidecarConnectionAtom } from "@/stores/agents";
import settingsStyles from "./settings.module.css";
import s from "./snapshot-settings.module.css";

const SETTINGS_KEY = ["agentdeck", "sidecar-settings"] as const;
const STORAGE_KEY = ["agentdeck", "snapshot-storage"] as const;
const MB = 1024 * 1024;

function Row({ label, sub, right }: { label: string; sub?: string; right: ReactNode }) {
  return (
    <div className={settingsStyles.row}>
      <div className={settingsStyles.rowLeft}>
        <div className={settingsStyles.rowLabel}>{label}</div>
        {sub ? <div className={settingsStyles.rowSub}>{sub}</div> : null}
      </div>
      <div className={settingsStyles.rowRight}>{right}</div>
    </div>
  );
}

/** 数字输入：失焦或回车时提交；非法值（非正整数）还原并提示 */
function NumberField({
  label,
  value,
  unit,
  onCommit,
  onInvalid,
}: {
  label: string;
  value: number;
  unit: string;
  onCommit: (value: number) => void;
  onInvalid: () => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const parsed = Number(text);
    if (!Number.isInteger(parsed) || parsed < 1) {
      setText(String(value));
      onInvalid();
      return;
    }
    if (parsed !== value) onCommit(parsed);
  };
  return (
    <span className={s.numberField}>
      <input
        className={s.numberInput}
        type="text"
        inputMode="numeric"
        aria-label={label}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
      <span className={s.unit}>{unit}</span>
    </span>
  );
}

export function SnapshotSettingsSection({ showHeading = true }: { showHeading?: boolean }) {
  const actions = useAgentSession();
  const queryClient = useQueryClient();
  const { confirm } = useConfirm();
  const connected = useAtomValue(sidecarConnectionAtom) === "open";
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => actions.getSidecarSettings(),
    enabled: connected,
    retry: false,
  });
  const storage = useQuery({
    queryKey: STORAGE_KEY,
    queryFn: () => actions.snapshotStorage(),
    enabled: connected,
    retry: false,
  });

  const save = useMutation({
    mutationFn: (patch: SidecarSettingsPatch) => actions.setSidecarSettings(patch),
    onSuccess: (next: SidecarSettings) => {
      queryClient.setQueryData(SETTINGS_KEY, next);
      setMessage(null);
    },
    onError: (error) => setMessage({ tone: "error", text: `保存失败：${humanizeSidecarError(error)}` }),
  });

  const prune = useMutation({
    mutationFn: (cwd: string) => actions.pruneSnapshots(cwd),
    onSuccess: () => {
      setMessage({ tone: "ok", text: "已清理该工作目录的快照。" });
      void queryClient.invalidateQueries({ queryKey: STORAGE_KEY });
      void queryClient.invalidateQueries({ queryKey: ["agentdeck", "snapshots"] });
    },
    onError: (error) => setMessage({ tone: "error", text: `清理失败：${humanizeSidecarError(error)}` }),
  });

  const onPrune = async (cwd: string) => {
    const confirmed = await confirm({
      title: "清理文件快照",
      body: `将删除「${cwd}」的全部文件快照，之后无法再回滚到这些快照之前的状态。工作目录里的文件不受影响。`,
      confirmLabel: "清理",
      danger: true,
    });
    if (confirmed) prune.mutate(cwd);
  };

  const current = settings.data?.snapshots;
  const toggleOptions = [
    { value: "off", label: "关闭" },
    { value: "on", label: "开启" },
  ];

  return (
    <div>
      {showHeading ? <h2 className={settingsStyles.heading}>文件快照</h2> : null}
      {!connected ? (
        <p className={settingsStyles.desc}>Agent 服务未连接，暂时无法读取或修改文件快照设置。</p>
      ) : settings.error ? (
        <p className={settingsStyles.desc} role="alert">
          读取设置失败：{humanizeSidecarError(settings.error)}
        </p>
      ) : null}
      {current ? (
        <>
          <Row
            label="按回合自动快照"
            sub="每个回合开始与结束时，用独立的影子仓库记录工作目录的文件状态，可查看回合改动并回滚。不修改工作目录自己的 git 仓库。"
            right={
              <div className={settingsStyles.radioGroup}>
                {toggleOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={settingsStyles.radioBtn}
                    data-active={(option.value === "on") === current.enabled}
                    onClick={() => save.mutate({ snapshots: { enabled: option.value === "on" } })}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            }
          />
          <Row
            label="文件数上限"
            sub="快照前的候选文件（新增、修改、删除）超过该数量时，本回合跳过快照。"
            right={
              <NumberField
                label="文件数上限"
                value={current.maxFiles}
                unit="个"
                onCommit={(maxFiles) => save.mutate({ snapshots: { maxFiles } })}
                onInvalid={() => setMessage({ tone: "error", text: "文件数上限需为正整数。" })}
              />
            }
          />
          <Row
            label="单文件大小上限"
            sub="超过该大小的文件不纳入快照。"
            right={
              <NumberField
                label="单文件大小上限"
                value={Math.max(1, Math.round(current.maxFileBytes / MB))}
                unit="MB"
                onCommit={(mb) => save.mutate({ snapshots: { maxFileBytes: mb * MB } })}
                onInvalid={() => setMessage({ tone: "error", text: "单文件大小上限需为正整数（MB）。" })}
              />
            }
          />
        </>
      ) : null}

      {message ? (
        <p className={s.message} data-tone={message.tone} role={message.tone === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}

      <h3 className={s.subheading}>各工作目录占用</h3>
      {storage.data && storage.data.length > 0 ? (
        <ul className={s.storageList}>
          {storage.data.map((repo) => (
            <li key={repo.cwd} className={s.storageRow}>
              <span className={s.storagePath} title={repo.cwd}>
                {repo.cwd}
              </span>
              <span className={s.storageSize}>{formatSnapshotBytes(repo.bytes)}</span>
              <Button size="xs" variant="outline" tone="danger" onClick={() => void onPrune(repo.cwd)} disabled={prune.isPending}>
                清理
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={settingsStyles.desc}>{storage.isLoading ? "正在读取…" : "还没有占用空间的快照。"}</p>
      )}
    </div>
  );
}
