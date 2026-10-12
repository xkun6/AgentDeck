// Windows 11 风格的窗口控制按钮（最小化 / 最大化或还原 / 关闭），用于无原生标题栏的主窗口。
import type { WindowControlsState } from "@/hooks/use-window-controls";
import s from "./window-controls.module.css";

function report(action: string) {
  return (error: unknown) => console.warn(`窗口${action}失败`, error);
}

export function WindowControls({ controls, maximized }: WindowControlsState) {
  const maximizeLabel = maximized ? "还原" : "最大化";
  return (
    <div className={s.controls} role="group" aria-label="窗口控制">
      <button
        type="button"
        className={s.button}
        aria-label="最小化"
        title="最小化"
        onClick={() => void controls.minimize().catch(report("最小化"))}
      >
        <svg className={s.glyph} viewBox="0 0 12 12" aria-hidden="true">
          <path d="M1.5 6.5h9" />
        </svg>
      </button>
      <button
        type="button"
        className={s.button}
        aria-label={maximizeLabel}
        title={maximizeLabel}
        data-maximized={maximized ? "true" : "false"}
        onClick={() => void controls.toggleMaximize().catch(report(maximizeLabel))}
      >
        {maximized ? (
          <svg className={s.glyph} viewBox="0 0 12 12" aria-hidden="true">
            <path d="M1.5 3.5h7v7h-7z" />
            <path d="M3.5 3.5v-2h7v7h-2" />
          </svg>
        ) : (
          <svg className={s.glyph} viewBox="0 0 12 12" aria-hidden="true">
            <path d="M1.5 1.5h9v9h-9z" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className={s.button}
        data-kind="close"
        aria-label="关闭"
        title="关闭"
        onClick={() => void controls.close().catch(report("关闭"))}
      >
        <svg className={s.glyph} viewBox="0 0 12 12" aria-hidden="true">
          <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" />
        </svg>
      </button>
    </div>
  );
}
