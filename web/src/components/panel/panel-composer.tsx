import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { useSearchParams } from "react-router-dom";
import { FolderOpen } from "lucide-react";
import { useCreateAndSendSession, WORKSPACE_REQUIRED_MESSAGE } from "@/hooks/use-create-and-send-session";
import { useAgentSessionSelection } from "@/hooks/use-agent-catalog";
import {
  composerDraftStorageKey,
  forgetComposerDraftByKey,
  readComposerDraftByKey,
  writeComposerDraftByKey,
} from "@/lib/composer-drafts";
import { composerSubmitShortcutHint } from "@/lib/composer-submit-shortcut";
import {
  normalizeWorkspacePath,
  readWorkspacePath,
  rememberWorkspaceProject,
  writeWorkspacePath,
} from "@/lib/workspaces";
import { composerPrefillAtom } from "@/stores/panel";
import { composerSubmitShortcutAtom } from "@/stores/ui";
import { GooseComposer } from "@/components/chat/goose-composer";
import { AgentSessionPicker } from "@/components/composer/agent-session-picker";
import type { ComposerSubmitPayload } from "@/components/chat/composer-types";
import s from "./panel-composer.module.css";

export function PanelComposer() {
  const [searchParams] = useSearchParams();
  const createAndSendSession = useCreateAndSendSession();
  const [sending, setSending] = useState(false);
  const [prefilledDraft, setPrefilledDraft] = useState({ text: "", nonce: 0 });
  const [prefill, setPrefill] = useAtom(composerPrefillAtom);
  const composerSubmitShortcut = useAtomValue(composerSubmitShortcutAtom);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const initialWorkspacePath = normalizeWorkspacePath(searchParams.get("workspace"));
  const [cwd, setCwd] = useState(() => initialWorkspacePath || readWorkspacePath());
  const agent = useAgentSessionSelection(cwd);
  const submitShortcutHint = composerSubmitShortcutHint(composerSubmitShortcut);
  const newTaskDraftKey = useMemo(() => composerDraftStorageKey({ kind: "new" }), []);
  const storedDraft = useMemo(() => readComposerDraftByKey(newTaskDraftKey), [newTaskDraftKey]);
  const composerInitial = prefilledDraft.nonce > 0 ? prefilledDraft.text : storedDraft;

  useEffect(() => {
    if (!initialWorkspacePath) return;
    writeWorkspacePath(initialWorkspacePath);
    rememberWorkspaceProject(initialWorkspacePath);
  }, [initialWorkspacePath]);

  useEffect(() => {
    if (!prefill) return;
    setPrefilledDraft(prefill);
    wrapperRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    // Consume the signal so re-renders don't replay it.
    setPrefill(null);
  }, [prefill, setPrefill]);

  const onSend = useCallback(async (payload: ComposerSubmitPayload) => {
    if (sending) return;
    setSending(true);
    try {
      await createAndSendSession(payload, agent.selection);
      forgetComposerDraftByKey(newTaskDraftKey);
    } catch (err) {
      console.error("新建会话失败：", err);
      throw err;
    } finally {
      setSending(false);
    }
  }, [sending, createAndSendSession, agent.selection, newTaskDraftKey]);

  const onDraftChange = useCallback((text: string) => {
    writeComposerDraftByKey(newTaskDraftKey, text);
  }, [newTaskDraftKey]);

  return (
    <div ref={wrapperRef}>
      <GooseComposer
        key={`${initialWorkspacePath || "default-workspace"}:${newTaskDraftKey ?? "draft"}`}
        onSend={onSend}
        initial={composerInitial}
        initialNonce={prefilledDraft.nonce}
        initialWorkspacePath={initialWorkspacePath}
        onWorkspaceChange={setCwd}
        onDraftChange={onDraftChange}
        placeholder={`描述你想完成的任务，${submitShortcutHint}…`}
        variant="big"
        headerLabel="新任务"
        showMeta={false}
        loading={sending}
        toolbarExtra={
          <AgentSessionPicker
            selection={agent.selection}
            onChange={agent.onChange}
            providers={agent.providers}
            providersError={agent.providersError}
            catalog={agent.catalog}
            catalogLoading={agent.catalogLoading}
            catalogError={agent.catalogError}
            disabled={sending}
          />
        }
      />
      {!cwd ? (
        <p className={s.hint} role="note">
          <FolderOpen className={s.hintIcon} aria-hidden="true" />
          <span>{WORKSPACE_REQUIRED_MESSAGE}（点击输入框工具栏中的工作区按钮选择）</span>
        </p>
      ) : null}
    </div>
  );
}
