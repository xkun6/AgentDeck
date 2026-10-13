// 全局屏蔽 WebView 自带的浏览器右键菜单。
// 放行：可编辑元素、非空文本选区（保留复制等原生能力）、已被自定义菜单处理的事件；开发模式不屏蔽。
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest("input, textarea, [contenteditable]:not([contenteditable='false'])") !== null;
}

export function handleNativeContextMenu(event: MouseEvent): void {
  if (event.defaultPrevented) return;
  if (isEditableTarget(event.target)) return;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.toString().length > 0) return;
  event.preventDefault();
}

export function installNativeContextMenuBlocker(): () => void {
  if (import.meta.env.DEV) return () => {};
  document.addEventListener("contextmenu", handleNativeContextMenu);
  return () => document.removeEventListener("contextmenu", handleNativeContextMenu);
}
