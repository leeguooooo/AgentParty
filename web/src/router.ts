// 极简 history 路由：/ 与 /c/:slug 两条，导航时保留 ?t=（分享链接直达频道）
import { useCallback, useEffect, useState } from "react";

export function useRoute(): [string, (to: string) => void, (to: string) => void] {
  const [path, setPath] = useState(() => location.pathname);

  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((to: string) => {
    if (to === location.pathname) return;
    history.pushState(null, "", to + location.search);
    setPath(to);
  }, []);

  // 替换当前历史项，落到 to 的整串（含 query）——OIDC 回调后清掉 ?code&state 用
  const replace = useCallback((to: string) => {
    history.replaceState(null, "", to);
    setPath(to.split(/[?#]/)[0] ?? to);
  }, []);

  return [path, navigate, replace];
}

export function matchChannel(path: string): string | null {
  const m = path.match(/^\/c\/([a-z0-9][a-z0-9-]*)\/?$/);
  return m?.[1] ?? null;
}

// 邀请链接落地：/join/<code>（code 为 base64url 随机串）。命中则走兑换流程加入私有频道。
export function matchJoin(path: string): string | null {
  const m = path.match(/^\/join\/([A-Za-z0-9_-]+)\/?$/);
  return m?.[1] ?? null;
}

export function matchPair(path: string): boolean {
  return /^\/pair\/?$/.test(path);
}
