// #126：OIDC 静默续期的跨标签互斥。
import { describe, expect, test } from "bun:test";
import { sessionStillFresh, withRefreshLock } from "./refreshLock";

// 极简 LockManager：串行化同名锁，模拟浏览器跨标签行为
function fakeLocks(): LockManager {
  const queues = new Map<string, Promise<unknown>>();
  return {
    request: ((name: string, cb: () => Promise<unknown>) => {
      const prev = queues.get(name) ?? Promise.resolve();
      const next = prev.then(() => cb());
      // 无论成败都让后来者继续排队
      queues.set(name, next.catch(() => undefined));
      return next;
    }) as LockManager["request"],
    query: async () => ({ held: [], pending: [] }),
  } as LockManager;
}

interface Sess {
  accessToken: string;
  expiresAt: number;
}

const NOW = 1_000_000;

describe("sessionStillFresh", () => {
  test("fresh when more than the skew window remains", () => {
    expect(sessionStillFresh({ accessToken: "a", expiresAt: NOW + 60 }, NOW)).toBe(true);
  });
  test("not fresh inside the skew window or past expiry", () => {
    expect(sessionStillFresh({ accessToken: "a", expiresAt: NOW + 10 }, NOW)).toBe(false);
    expect(sessionStillFresh({ accessToken: "a", expiresAt: NOW - 1 }, NOW)).toBe(false);
  });
  test("not fresh without a token or expiry", () => {
    expect(sessionStillFresh(null, NOW)).toBe(false);
    expect(sessionStillFresh({ accessToken: "a", expiresAt: null }, NOW)).toBe(false);
    expect(sessionStillFresh({ accessToken: null, expiresAt: NOW + 60 }, NOW)).toBe(false);
  });
});

describe("withRefreshLock (#126)", () => {
  test("two tabs racing on expiry: only ONE hits the IdP, the other reuses the fresh session", async () => {
    const locks = fakeLocks();
    // 共享的「localStorage」
    let stored: Sess | null = { accessToken: "old", expiresAt: NOW - 1 };
    let idpCalls = 0;

    const deps = () => ({
      readFresh: () => (sessionStillFresh(stored, NOW) ? stored : null),
      refresh: async () => {
        idpCalls += 1;
        // 真实 IdP：refresh_token 一次性，第二次调用会 invalid_grant
        if (idpCalls > 1) throw new Error("invalid_grant");
        await Promise.resolve();
        stored = { accessToken: `new-${idpCalls}`, expiresAt: NOW + 600 };
        return stored;
      },
    });

    const [a, b] = await Promise.all([withRefreshLock(deps(), locks), withRefreshLock(deps(), locks)]);

    // 关键：只发了一次 IdP 请求，第二个标签复用了新会话
    expect(idpCalls).toBe(1);
    expect(a.accessToken).toBe("new-1");
    expect(b.accessToken).toBe("new-1");
  });

  test("without the lock the second tab burns the rotated refresh_token (this is the bug)", async () => {
    let stored: Sess | null = { accessToken: "old", expiresAt: NOW - 1 };
    let idpCalls = 0;
    const refresh = async () => {
      idpCalls += 1;
      if (idpCalls > 1) throw new Error("invalid_grant");
      await Promise.resolve();
      stored = { accessToken: `new-${idpCalls}`, expiresAt: NOW + 600 };
      return stored;
    };
    // 修复前的行为：两个标签各自直接 refresh，没有互斥
    const results = await Promise.allSettled([refresh(), refresh()]);
    expect(idpCalls).toBe(2);
    expect(results[1]!.status).toBe("rejected"); // 后到的被 IdP 作废 → 该标签 hardLogout → 清共享 session
  });

  test("degrades gracefully when navigator.locks is unavailable", async () => {
    let idpCalls = 0;
    const got = await withRefreshLock<Sess>(
      {
        readFresh: () => null,
        refresh: async () => {
          idpCalls += 1;
          return { accessToken: "x", expiresAt: NOW + 600 };
        },
      },
      undefined,
    );
    expect(idpCalls).toBe(1);
    expect(got.accessToken).toBe("x");
  });

  test("a caller that arrives after the winner never calls the IdP at all", async () => {
    const locks = fakeLocks();
    let idpCalls = 0;
    const fresh: Sess = { accessToken: "already-fresh", expiresAt: NOW + 600 };
    const got = await withRefreshLock<Sess>(
      {
        readFresh: () => (sessionStillFresh(fresh, NOW) ? fresh : null),
        refresh: async () => {
          idpCalls += 1;
          return fresh;
        },
      },
      locks,
    );
    expect(idpCalls).toBe(0);
    expect(got.accessToken).toBe("already-fresh");
  });
});
