// 覆盖层与 Android 返回键：开着的覆盖层共用一条同地址的 history 记录，返回键每次只关最上面一个，页面不动；
// 全部关闭时退掉这条记录，不多占一次返回；覆盖层开着时跳转页面，由新页面顶替这条记录，不在历史中间留下重复项。

interface OverlayEntry {
  dismiss: () => void;
}

/** 开着的覆盖层，后开的在后 */
const stack: OverlayEntry[] = [];
/** 压记录时的地址：退记录前用来判断期间是否已经导航走 */
let entryHash = "";
// 全部关闭后推迟一拍再退 history：下一个覆盖层紧接着打开时（含 StrictMode 的重复 effect）直接复用这条记录，
// 否则异步的 back 会落在新记录之后，把刚打开的覆盖层当成被返回键关掉
let pendingBack: ReturnType<typeof setTimeout> | null = null;
/** 自己发起、还没落地的 back：它们的 popstate 不是用户按了返回键 */
let ownBacks = 0;
let listening = false;

function pushEntry() {
  window.history.pushState(window.history.state, "", window.location.href);
  entryHash = window.location.hash;
}

function cancelPendingBack() {
  if (pendingBack === null) return;
  clearTimeout(pendingBack);
  pendingBack = null;
}

function onPopState() {
  if (ownBacks > 0) {
    ownBacks -= 1;
    return;
  }
  const top = stack.pop();
  if (!top) return;
  // 这条记录已被返回键用掉，下面还有覆盖层就补一条，下一次返回才能关下一个
  if (stack.length > 0) pushEntry();
  top.dismiss();
}

/** 登记一个打开的覆盖层；返回值在它关闭时调用（已被返回键或跳转关掉时不做任何事） */
export function openOverlay(dismiss: () => void): () => void {
  if (!listening) {
    listening = true;
    window.addEventListener("popstate", onPopState);
  }
  if (stack.length === 0) {
    if (pendingBack !== null) cancelPendingBack();
    else pushEntry();
  }
  const entry: OverlayEntry = { dismiss };
  stack.push(entry);
  return () => {
    const index = stack.indexOf(entry);
    if (index < 0) return;
    stack.splice(index, 1);
    if (stack.length > 0) return;
    pendingBack = setTimeout(() => {
      pendingBack = null;
      // 关闭的同时已经导航走了：退 history 会撤销那次导航
      if (window.location.hash === entryHash) {
        ownBacks += 1;
        window.history.back();
      }
    }, 0);
  };
}

/** 跳转页面：覆盖层占着 history 时由新地址顶替那条记录并关掉覆盖层，返回 true；否则不做任何事，返回 false */
export function replaceOverlayEntry(hash: string): boolean {
  if ((stack.length === 0 && pendingBack === null) || hash === window.location.hash) return false;
  window.history.replaceState(null, "", hash);
  cancelPendingBack();
  for (const entry of stack.splice(0)) entry.dismiss();
  return true;
}
