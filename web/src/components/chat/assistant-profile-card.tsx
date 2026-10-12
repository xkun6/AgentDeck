// 点击助手头像弹出的资料卡（微信联系人卡形态）：大头像 + 名称 + 身份副行、
// 当前模型信息，底部「发消息 / 更换头像」快捷入口。自定义头像可再次点击，
// 弹出全屏遮罩放大查看（点击遮罩或 Esc 关闭）；未设置头像时显示名称首字。
import { useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useAtomValue } from "jotai";
import { MessageCircle, ImageUp } from "lucide-react";
import { Popover } from "@agentdeck/shared-ui";
import { ASSISTANT_FALLBACK_NAME, assistantAvatarDataUrlAtom } from "@/stores/ui";
import s from "./assistant-profile-card.module.css";

interface AssistantProfileCardProps {
  /** 触发弹层的头像（作为 Popover.Trigger 渲染）。 */
  trigger: React.ReactNode;
  /** 助手显示名（宿主已按自定义名称 → 会话 Agent 名称解析）。 */
  name?: string;
  /** 当前会话使用的模型（可选，展示在信息区）。 */
  model?: string;
}

export function AssistantProfileCard({ trigger, name = ASSISTANT_FALLBACK_NAME, model }: AssistantProfileCardProps) {
  const navigate = useNavigate();
  const avatarUrl = useAtomValue(assistantAvatarDataUrlAtom);
  const [avatarZoomOpen, setAvatarZoomOpen] = useState(false);
  const initial = (Array.from(name.trim())[0] ?? "A").toUpperCase();

  return (
    <Popover.Root onOpenChange={(open) => { if (!open) setAvatarZoomOpen(false); }}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={s.card}
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          role="dialog"
          aria-label={`${name} 资料卡`}
          onEscapeKeyDown={(event) => {
            if (avatarZoomOpen) {
              event.preventDefault();
              setAvatarZoomOpen(false);
            }
          }}
          onInteractOutside={(event) => {
            if (avatarZoomOpen) event.preventDefault();
          }}
        >
          <div className={s.head}>
            {avatarUrl ? (
              <button
                type="button"
                className={s.bigAvatarButton}
                onClick={() => setAvatarZoomOpen(true)}
                aria-label="放大查看头像"
                title="点击放大查看"
              >
                <img className={s.bigAvatar} src={avatarUrl} alt={`${name} 头像`} />
              </button>
            ) : (
              <span className={s.bigAvatarInitial} aria-label={`${name} 头像`}>{initial}</span>
            )}
            <div className={s.headText}>
              <div className={s.name}>{name}</div>
              <div className={s.sub}>编程 Agent</div>
            </div>
          </div>

          {avatarZoomOpen && avatarUrl
            ? createPortal(
                <div
                  className={s.avatarZoomOverlay}
                  role="presentation"
                  onClick={() => setAvatarZoomOpen(false)}
                >
                  <img className={s.avatarZoomImage} src={avatarUrl} alt={`${name} 头像大图`} />
                </div>,
                document.body,
              )
            : null}

          {model ? (
            <>
              <div className={s.divider} />
              <div className={s.infoRow}>
                <span className={s.infoLabel}>模型</span>
                <span className={s.infoValue}>{model}</span>
              </div>
            </>
          ) : null}

          <div className={s.divider} />
          <div className={s.actions}>
            <button type="button" className={s.action} onClick={() => navigate("/")}>
              <MessageCircle size={20} aria-hidden />
              <span>发消息</span>
            </button>
            <button type="button" className={s.action} onClick={() => navigate("/common")}>
              <ImageUp size={20} aria-hidden />
              <span>更换头像</span>
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
