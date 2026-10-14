// 通用图片查看器：全屏遮罩 + 缩放（按钮 / 滚轮 / 双击）+ 拖拽平移 + 多图切换。
import { useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, PointerEvent, WheelEvent } from "react";
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

const ZOOM_STEP = 1.25;
const MAX_ZOOM = 8;

export function ImageLightbox({ images, startIndex = 0, onClose }: ImageLightboxProps) {
  const [index, setIndex] = useState(() => Math.min(Math.max(startIndex, 0), Math.max(images.length - 1, 0)));
  // 相对「适配窗口」显示尺寸的倍数，1 = 适配窗口
  const [zoom, setZoom] = useState(1);
  const [sizes, setSizes] = useState<Record<string, string>>({});
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  // 适配窗口时图片的显示尺寸，放大以它为基准
  const fitRef = useRef<{ width: number; height: number } | null>(null);
  // 缩放前视口中心在内容中的相对位置，缩放后据此恢复滚动，保持所看位置不跳
  const anchorRef = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const draggedRef = useRef(false);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (!stage || !anchor) return;
    stage.scrollLeft = anchor.x * stage.scrollWidth - stage.clientWidth / 2;
    stage.scrollTop = anchor.y * stage.scrollHeight - stage.clientHeight / 2;
  }, [zoom]);

  const image = images[index];
  if (!image) return null;
  const multi = images.length > 1;
  const zoomed = zoom > 1;

  const zoomTo = (next: number) => {
    const clamped = Math.min(Math.max(Math.round(next * 100) / 100, 1), MAX_ZOOM);
    if (clamped === zoom) return;
    const stage = stageRef.current;
    const img = imageRef.current;
    if (!zoomed && img) fitRef.current = { width: img.clientWidth, height: img.clientHeight };
    if (stage && stage.scrollWidth && stage.scrollHeight) {
      anchorRef.current = {
        x: (stage.scrollLeft + stage.clientWidth / 2) / stage.scrollWidth,
        y: (stage.scrollTop + stage.clientHeight / 2) / stage.scrollHeight,
      };
    }
    setZoom(clamped);
  };

  const go = (delta: number) => {
    if (!multi) return;
    setIndex((current) => (current + delta + images.length) % images.length);
    setZoom(1);
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

  // stage 为 overflow: hidden，滚轮只缩放不滚动；平移靠拖拽（程序设置 scrollLeft/Top 仍有效）
  const onWheel = (event: WheelEvent) => {
    if (event.deltaY < 0) zoomTo(zoom * ZOOM_STEP);
    else if (event.deltaY > 0) zoomTo(zoom / ZOOM_STEP);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const stage = stageRef.current;
    draggedRef.current = false;
    if (!zoomed || !stage) return;
    dragRef.current = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop, moved: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const stage = stageRef.current;
    if (!drag || !stage) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    stage.scrollLeft = drag.left - dx;
    stage.scrollTop = drag.top - dy;
  };
  const endDrag = () => {
    if (dragRef.current?.moved) draggedRef.current = true;
    dragRef.current = null;
  };
  // 点空白处关闭；拖拽平移结束时的那次 click 不算
  const onCanvasClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || draggedRef.current) return;
    onClose();
  };

  const fit = fitRef.current;
  const zoomedStyle = zoomed && fit?.width ? { width: fit.width * zoom, height: fit.height * zoom } : undefined;

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.content} aria-describedby={undefined} onKeyDown={onKeyDown}>
          <Dialog.Title className={s.srOnly}>图片预览：{image.name}</Dialog.Title>
          <div
            ref={stageRef}
            className={s.stage}
            data-zoomed={zoomed}
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerLeave={endDrag}
          >
            <div className={s.canvas} onClick={onCanvasClick}>
              <img
                key={image.src}
                ref={imageRef}
                className={s.image}
                src={image.src}
                alt={image.name}
                draggable={false}
                data-zoomed={zoomed}
                style={zoomedStyle}
                onDoubleClick={() => zoomTo(zoomed ? 1 : 2)}
                onLoad={(event) => {
                  const { naturalWidth, naturalHeight } = event.currentTarget;
                  if (naturalWidth && naturalHeight) {
                    setSizes((current) => ({ ...current, [image.src]: `${naturalWidth}×${naturalHeight}` }));
                  }
                }}
              />
            </div>
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
            <IconButton aria-label="缩小" disabled={!zoomed} onClick={() => zoomTo(zoom / ZOOM_STEP)}>
              <ZoomOut size={16} aria-hidden="true" />
            </IconButton>
            <IconButton aria-label="放大" disabled={zoom >= MAX_ZOOM} onClick={() => zoomTo(zoom * ZOOM_STEP)}>
              <ZoomIn size={16} aria-hidden="true" />
            </IconButton>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
