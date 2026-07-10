// #126：OIDC 静默续期的跨标签互斥。
//
// refresh_token 是一次性的、会轮换：两个标签同时拿同一个 refresh_token 去换 token，
// 先到的成功并让后到的那个作废（IdP 返回 invalid_grant），后到的标签 hardLogout →
// 而 session 存在共享的 localStorage 里、clearToken 会连 SESSION_KEY 一起删 →
// **所有标签集体被踢回登录页**。
//
// App.tsx 原本的 refreshInFlight 是 per-tab 的 useRef，注释写着「全局只跑一枚在途 promise」，
// 但它只在单个标签页内去重。所有标签又按 expiresAt-60s 这个绝对时刻同时触发，必然撞上。
//
// 修法：navigator.locks 做跨标签互斥；拿到锁后**重读 session**——很可能别的标签已经续好了，
// 此时直接复用新 token，一次网络请求都不发。

const LOCK_NAME = "agentparty:oidc-refresh";

/** 距过期还有 SKEW_SEC 以上就算「新鲜」——用于判断别的标签是否已经续过期。 */
const SKEW_SEC = 30;

export function sessionStillFresh(
  sess: { accessToken?: string | null; expiresAt?: number | null } | null,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (sess?.accessToken == null || sess.expiresAt == null) return false;
  return sess.expiresAt - SKEW_SEC > nowSec;
}

export interface RefreshLockDeps<T> {
  /** 拿到锁之后重读一次会话；若它已经是新鲜的（别的标签续过了），返回它，不再发请求。 */
  readFresh: () => T | null;
  /** 真正去 IdP 换 token。只有拿到锁、且 readFresh 判定仍需续期时才会调用。 */
  refresh: () => Promise<T>;
}

/**
 * 在跨标签锁内执行续期。navigator.locks 不可用（老浏览器 / 非安全上下文）时降级为直接执行——
 * 降级后的行为与修复前一致，不会更糟。
 */
export async function withRefreshLock<T>(deps: RefreshLockDeps<T>, locks: LockManager | undefined = navigator.locks): Promise<T> {
  if (!locks) {
    const fresh = deps.readFresh();
    return fresh ?? (await deps.refresh());
  }
  return locks.request(LOCK_NAME, async () => {
    // 关键：拿到锁之后才读。等锁期间别的标签很可能已经完成续期并写回 localStorage。
    const fresh = deps.readFresh();
    if (fresh !== null) return fresh;
    return deps.refresh();
  });
}
