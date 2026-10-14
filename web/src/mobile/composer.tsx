// 手机端输入区：发送 / 运行中插话（provider 支持 steer）/ 取消，以及图片附件（拍照 / 相册，最多 4 张，可预览可删除）。
// 撤回按钮在消息气泡上（MessageTimeline 的 retract 操作）。
import { useRef, useState } from "react";
import { IMAGE_LIMITS, type DraftImage } from "./image-attachments";
import s from "./mobile.module.css";

export interface MobileComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** 本轮进行中 */
  busy: boolean;
  connected: boolean;
  /** provider 支持运行中插话（capabilities.steer） */
  steerSupported: boolean;
  onSend: () => void;
  onSteer: () => void;
  onCancel: () => void;
  /** 已选图片（缺省 = 不显示图片入口） */
  images?: DraftImage[];
  /** 正在压缩图片 */
  imagesBusy?: boolean;
  onAddImages?: (files: File[]) => void;
  onRemoveImage?: (id: string) => void;
}

export function MobileComposer({
  value,
  onChange,
  busy,
  connected,
  steerSupported,
  onSend,
  onSteer,
  onCancel,
  images = [],
  imagesBusy = false,
  onAddImages,
  onRemoveImage,
}: MobileComposerProps) {
  const canType = connected && (!busy || steerSupported);
  const empty = !value.trim() && images.length === 0;
  const sendBlocked = empty || !connected || imagesBusy;
  const [menuOpen, setMenuOpen] = useState(false);
  const cameraInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);
  const imagesFull = images.length >= IMAGE_LIMITS.maxCount;
  const placeholder = !connected
    ? "未连接电脑"
    : busy
      ? steerSupported
        ? "运行中，可插话"
        : "运行中，可取消"
      : "给 Agent 发消息";

  const pick = (input: HTMLInputElement | null) => {
    setMenuOpen(false);
    input?.click();
  };
  const onFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length > 0) onAddImages?.(files);
  };

  return (
    <form
      className={s.inputBar}
      onSubmit={(event) => {
        event.preventDefault();
        if (sendBlocked) return;
        if (busy) {
          if (steerSupported) onSteer();
        } else {
          onSend();
        }
      }}
    >
      {images.length > 0 || imagesBusy ? (
        <ul className={s.imageStrip} aria-label="已选图片">
          {images.map((image) => (
            <li key={image.id} className={s.imageThumb}>
              <img src={image.previewUrl} alt={image.name} />
              <button
                type="button"
                className={s.imageRemove}
                aria-label={`移除图片 ${image.name}`}
                onClick={() => onRemoveImage?.(image.id)}
              >
                ×
              </button>
            </li>
          ))}
          {imagesBusy ? <li className={s.imageBusy}>压缩中…</li> : null}
        </ul>
      ) : null}
      {onAddImages ? (
        <div className={s.imageMenuWrap}>
          <button
            type="button"
            className={s.secondaryButton}
            disabled={!canType || imagesFull || imagesBusy}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={imagesFull ? `最多 ${IMAGE_LIMITS.maxCount} 张` : undefined}
            onClick={() => setMenuOpen((open) => !open)}
          >
            图片
          </button>
          {menuOpen ? (
            <div className={s.imageMenu} role="menu">
              <button type="button" role="menuitem" className={s.secondaryButton} onClick={() => pick(cameraInput.current)}>
                拍照
              </button>
              <button type="button" role="menuitem" className={s.secondaryButton} onClick={() => pick(galleryInput.current)}>
                相册
              </button>
            </div>
          ) : null}
          <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden aria-label="拍照" onChange={onFiles} />
          <input ref={galleryInput} type="file" accept="image/*" multiple hidden aria-label="从相册选择" onChange={onFiles} />
        </div>
      ) : null}
      <textarea
        className={s.textarea}
        value={value}
        rows={1}
        disabled={!canType}
        placeholder={placeholder}
        aria-label="消息输入框"
        onChange={(event) => onChange(event.target.value)}
      />
      {busy ? (
        <div className={s.inputActions}>
          {steerSupported ? (
            <button type="submit" className={s.primaryButton} disabled={sendBlocked}>
              插话
            </button>
          ) : null}
          <button type="button" className={s.dangerButton} onClick={onCancel} disabled={!connected}>
            取消
          </button>
        </div>
      ) : (
        <button type="submit" className={s.primaryButton} disabled={sendBlocked}>
          发送
        </button>
      )}
    </form>
  );
}
