import { useCallback, useEffect, useState } from "react";
import { replaceOverlayEntry } from "./overlay-history";
import { parseRoute, routeHash, type MobileRoute } from "./route";

/** hash 路由：返回当前路由与 navigate（push）/ back（Android 返回键同款 history.back） */
export function useHashRoute() {
  const [route, setRoute] = useState<MobileRoute>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = useCallback((next: MobileRoute, options: { replace?: boolean } = {}) => {
    const hash = routeHash(next);
    if (options.replace) {
      window.history.replaceState(null, "", hash);
      setRoute(next);
    } else if (replaceOverlayEntry(hash)) {
      setRoute(next);
    } else {
      window.location.hash = hash;
    }
  }, []);

  const back = useCallback(
    (fallback: MobileRoute) => {
      if (window.history.length > 1) window.history.back();
      else navigate(fallback, { replace: true });
    },
    [navigate],
  );

  return { route, navigate, back };
}
