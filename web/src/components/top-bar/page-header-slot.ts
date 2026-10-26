import { atom } from "jotai";

/** 外壳主区标题行里留给页面的挂载点；页面的 TopBar 通过 portal 渲染进来。 */
export const pageHeaderSlotAtom = atom<HTMLElement | null>(null);
