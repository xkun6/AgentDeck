// 自绘标题栏的窗口控制：只有 tauri-bridge 挂载了 windowControls（无原生标题栏的主窗口）时返回非空。
import { useEffect, useState } from "react";
import type { DesktopWindowControls } from "@/lib/runtime";

export interface WindowControlsState {
  controls: DesktopWindowControls;
  /** 最大化时显示「还原」图标。 */
  maximized: boolean;
}

export function useWindowControls(): WindowControlsState | null {
  const [controls] = useState(() =>
    typeof window === "undefined" ? undefined : window.hermesDesktop?.windowControls,
  );
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!controls) return;
    let active = true;
    const sync = () => {
      controls
        .isMaximized()
        .then((value) => {
          if (active) setMaximized(value);
        })
        .catch(() => {});
    };
    sync();
    const unlisten = controls.onResized(sync);
    return () => {
      active = false;
      unlisten();
    };
  }, [controls]);

  return controls ? { controls, maximized } : null;
}
