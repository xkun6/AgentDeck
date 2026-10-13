// 「并行协作」新建弹窗（design.md 4.27）：多选 Agent（各自模型 / 模式）、任务、工作目录、成员独立 worktree、汇总设置。
// 表单校验与入参构造见 lib/group-display.ts。
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FolderOpen, Plus, X } from "lucide-react";
import { Button, Dialog, Field, IconButton, Select, Textarea } from "@agentdeck/shared-ui";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { useAgentCatalog, useAgentProviders } from "@/hooks/use-agent-catalog";
import { useProviderConfig } from "@/hooks/use-provider-config";
import { useWorktrees } from "@/hooks/use-worktrees";
import { resolveProvider, type AgentSelection } from "@/lib/agent-selection";
import {
  CHAIR_MODE_LABELS,
  GROUP_MEMBERS_MAX,
  GROUP_MEMBERS_MIN,
  NOT_GIT_REPO_MESSAGE,
  buildGroupCreateParams,
  validateGroupForm,
  type GroupFormErrors,
  type GroupFormState,
} from "@/lib/group-display";
import { readWorkspacePath, rememberWorkspaceProject, writeWorkspacePath } from "@/lib/workspaces";
import { AgentSessionPicker } from "@/components/composer/agent-session-picker";
import { WorkspacePickerModal } from "@/components/composer/workspace-picker";
import s from "./group-dialog.module.css";

const EMPTY_SELECTION: AgentSelection = { provider: null, model: null, modeId: null, thinkingOptionId: null };

interface GroupDialogProps {
  open: boolean;
  onClose: () => void;
}

export function GroupDialog({ open, onClose }: GroupDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className={s.dialog} aria-describedby={undefined}>
          {open ? <GroupForm onClose={onClose} /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface MemberPickerProps {
  selection: AgentSelection;
  cwd: string;
  onChange: (next: AgentSelection) => void;
  disabled?: boolean;
}

/** 单个 Agent 的 provider / 模型 / 模式选择：每个成员各自拉取自己的模型目录 */
function MemberPicker({ selection, cwd, onChange, disabled }: MemberPickerProps) {
  const providersQuery = useAgentProviders();
  const providerConfigQuery = useProviderConfig();
  const catalogQuery = useAgentCatalog(selection.provider, cwd);
  return (
    <AgentSessionPicker
      selection={selection}
      onChange={onChange}
      providers={providersQuery.data ?? null}
      providerProfiles={providerConfigQuery.data?.providers ?? null}
      catalog={catalogQuery.data ?? null}
      catalogLoading={catalogQuery.isLoading}
      {...(disabled ? { disabled } : {})}
    />
  );
}

function GroupForm({ onClose }: { onClose: () => void }) {
  const actions = useAgentSession();
  const navigate = useNavigate();
  const { data: providers } = useAgentProviders();
  const [form, setForm] = useState<GroupFormState>(() => ({
    prompt: "",
    cwd: readWorkspacePath(),
    members: [EMPTY_SELECTION, EMPTY_SELECTION],
    perMemberWorktree: false,
    chairMode: "none",
    chair: EMPTY_SELECTION,
  }));
  const [errors, setErrors] = useState<GroupFormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const worktrees = useWorktrees(form.cwd);
  const isGitRepo = Boolean(form.cwd.trim()) && worktrees.isRepo;

  const patch = (value: Partial<GroupFormState>) => setForm((current) => ({ ...current, ...value }));
  const defaultProvider = useMemo(() => resolveProvider(null, providers ?? null), [providers]);

  // provider 列表到达后，给还没选 Agent 的成员 / 汇总一个默认值
  useEffect(() => {
    if (!defaultProvider) return;
    setForm((current) => {
      const fill = (selection: AgentSelection) =>
        selection.provider ? selection : { ...selection, provider: defaultProvider };
      const members = current.members.map(fill);
      const chair = fill(current.chair);
      const unchanged = members.every((member, index) => member === current.members[index]) && chair === current.chair;
      return unchanged ? current : { ...current, members, chair };
    });
  }, [defaultProvider]);

  // 工作目录不是 git 仓库时，已勾选的「独立 worktree」自动取消
  useEffect(() => {
    if (!isGitRepo && form.perMemberWorktree && !worktrees.loading) patch({ perMemberWorktree: false });
  }, [isGitRepo, form.perMemberWorktree, worktrees.loading]);

  const setMember = (index: number, next: AgentSelection) =>
    patch({ members: form.members.map((member, i) => (i === index ? next : member)) });

  const submit = async () => {
    const found = validateGroupForm(form, { isGitRepo });
    setErrors(found);
    setSubmitError(null);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    try {
      const group = await actions.createGroup(buildGroupCreateParams(form));
      rememberWorkspaceProject(form.cwd.trim());
      writeWorkspacePath(form.cwd.trim());
      onClose();
      navigate(`/groups/${encodeURIComponent(group.id)}`);
    } catch (error) {
      setSubmitError(humanizeSidecarError(error));
      setSaving(false);
    }
  };

  return (
    <>
      <div className={s.head}>
        <Dialog.Title asChild>
          <h2 className={s.title}>并行协作</h2>
        </Dialog.Title>
        <Dialog.Close asChild>
          <IconButton aria-label="关闭">
            <X size={16} aria-hidden="true" />
          </IconButton>
        </Dialog.Close>
      </div>
      <div className={s.body}>
        <Field label="任务（所有成员收到同一份提示）" error={errors.prompt} required>
          <Textarea
            aria-label="任务"
            rows={4}
            value={form.prompt}
            invalid={Boolean(errors.prompt)}
            placeholder="描述要让多个 Agent 并行完成的任务"
            onChange={(event) => patch({ prompt: event.target.value })}
          />
        </Field>

        <Field label="工作目录" error={errors.cwd} required>
          <div className={s.cwdRow}>
            <span className={s.cwdPath} data-empty={form.cwd ? undefined : "true"} title={form.cwd}>
              {form.cwd || "尚未选择"}
            </span>
            <Button variant="outline" onClick={() => setPickerOpen(true)}>
              <FolderOpen size={16} aria-hidden="true" />
              选择…
            </Button>
          </div>
        </Field>

        <Field label={`成员（${form.members.length} / ${GROUP_MEMBERS_MAX}）`} error={errors.members} required>
          <ol className={s.memberList}>
            {form.members.map((member, index) => (
              <li key={index} className={s.memberRow} aria-label={`成员 ${index + 1}`}>
                <span className={s.memberIndex}>{index + 1}</span>
                <div className={s.memberPicker}>
                  <MemberPicker
                    selection={member}
                    cwd={form.cwd}
                    onChange={(next) => setMember(index, next)}
                    disabled={saving}
                  />
                </div>
                <IconButton
                  aria-label={`移除成员 ${index + 1}`}
                  disabled={form.members.length <= GROUP_MEMBERS_MIN || saving}
                  onClick={() => patch({ members: form.members.filter((_, i) => i !== index) })}
                >
                  <X size={16} aria-hidden="true" />
                </IconButton>
              </li>
            ))}
          </ol>
          <Button
            variant="outline"
            disabled={form.members.length >= GROUP_MEMBERS_MAX || saving}
            onClick={() =>
              patch({ members: [...form.members, { ...EMPTY_SELECTION, provider: defaultProvider }] })
            }
          >
            <Plus size={16} aria-hidden="true" />
            添加成员
          </Button>
        </Field>

        <Field label="隔离" error={errors.worktree}>
          <label className={s.check}>
            <input
              type="checkbox"
              checked={form.perMemberWorktree}
              disabled={!isGitRepo || saving}
              onChange={(event) => patch({ perMemberWorktree: event.target.checked })}
            />
            每个成员使用独立 git worktree（互不干扰，可分别查看 diff）
          </label>
          {form.cwd.trim() && !isGitRepo && !worktrees.loading ? (
            <p className={s.hint} role="note">{NOT_GIT_REPO_MESSAGE}</p>
          ) : null}
        </Field>

        <Field label="汇总" error={errors.chair}>
          <Select
            aria-label="汇总方式"
            value={form.chairMode}
            onChange={(event) => patch({ chairMode: event.target.value as GroupFormState["chairMode"] })}
          >
            <option value="none">不汇总</option>
            <option value="synthesize">{CHAIR_MODE_LABELS.synthesize}：综合成一个最佳答案</option>
            <option value="review">{CHAIR_MODE_LABELS.review}：给出方案排序与理由</option>
          </Select>
          {form.chairMode !== "none" ? (
            <div className={s.chairPicker}>
              <MemberPicker
                selection={form.chair}
                cwd={form.cwd}
                onChange={(next) => patch({ chair: next })}
                disabled={saving}
              />
            </div>
          ) : null}
        </Field>
      </div>
      <div className={s.foot}>
        {submitError ? <span className={s.footError} role="alert">{submitError}</span> : null}
        <Button variant="outline" onClick={onClose}>取消</Button>
        <Button variant="solid" tone="accent" loading={saving} onClick={() => void submit()}>
          开始并行
        </Button>
      </div>
      {pickerOpen ? (
        <WorkspacePickerModal
          open
          initialPath={form.cwd}
          onCancel={() => setPickerOpen(false)}
          onConfirm={(path) => {
            setPickerOpen(false);
            patch({ cwd: path });
          }}
        />
      ) : null}
    </>
  );
}
