// 通用图片查看器：全屏遮罩 + 适配 / 100% 切换 + 多图切换。
import { useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, WheelEvent } from "react";
import { ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut } from "lucide-react";
import { Dialog, IconButton } from "@agentdeck/shared-ui";
import s from "./image-lightbox.module.css";

export interface LightboxImage {
  src: string;
  name: string;
}

interface ImageLightboxProps {
  images: readonly LightboxImage[];
  /** 初始显示的图片下标 */
  startIndex?: number;
  onClose: () => void;
}

export function ImageLightbox({ images, startIndex = 0, onClose }: ImageLightboxProps) {
  const [index, setIndex] = useState(() => Math.min(Math.max(startIndex, 0), Math.max(images.length - 1, 0)));
  const [actual, setActual] = useState(false);
  const [sizes, setSizes] = useState<Record<string, string>>({});
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  const image = images[index];
  if (!image) return null;
  const multi = images.length > 1;

  const go = (delta: number) => {
    if (!multi) return;
    setIndex((current) => (current + delta + images.length) % images.length);
    setActual(false);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      go(1);
    }
  };

  const onWheel = (event: WheelEvent) => {
    if (event.deltaY < 0) setActual(true);
    else if (event.deltaY > 0) setActual(false);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const stage = stageRef.current;
    if (!actual || !stage) return;
    dragRef.current = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const stage = stageRef.current;
    if (!drag || !stage) return;
    stage.scrollLeft = drag.left - (event.clientX - drag.x);
    stage.scrollTop = drag.top - (event.clientY - drag.y);
  };
  const endDrag = () => {
    dragRef.current = null;
  };

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.content} aria-describedby={undefined} onKeyDown={onKeyDown}>
          <Dialog.Title className={s.srOnly}>图片预览：{image.name}</Dialog.Title>
          <div
            ref={stageRef}
            className={s.stage}
            data-actual={actual}
            onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerLeave={endDrag}
          >
            <img
              key={image.src}
              className={s.image}
              src={image.src}
              alt={image.name}
              draggable={false}
              data-actual={actual}
              onDoubleClick={() => setActual((value) => !value)}
              onLoad={(event) => {
                const { naturalWidth, naturalHeight } = event.currentTarget;
                if (naturalWidth && naturalHeight) {
                  setSizes((current) => ({ ...current, [image.src]: `${naturalWidth}×${naturalHeight}` }));
                }
              }}
            />
          </div>
          <Dialog.Close asChild>
            <IconButton className={s.close} aria-label="关闭">
              <X size={16} aria-hidden="true" />
            </IconButton>
          </Dialog.Close>
          {multi ? (
            <>
              <IconButton className={s.prev} aria-label="上一张" onClick={() => go(-1)}>
                <ChevronLeft size={20} aria-hidden="true" />
              </IconButton>
              <IconButton className={s.next} aria-label="下一张" onClick={() => go(1)}>
                <ChevronRight size={20} aria-hidden="true" />
              </IconButton>
            </>
          ) : null}
          <div className={s.footer}>
            <span className={s.name} title={image.name}>{image.name}</span>
            {sizes[image.src] ? <span className={s.meta}>{sizes[image.src]}</span> : null}
            {multi ? <span className={s.meta} data-testid="lightbox-counter">{index + 1} / {images.length}</span> : null}
            <IconButton
              aria-label={actual ? "适配窗口" : "原始尺寸"}
              onClick={() => setActual((value) => !value)}
            >
              {actual ? <ZoomOut size={16} aria-hidden="true" /> : <ZoomIn size={16} aria-hidden="true" />}
            </IconButton>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
