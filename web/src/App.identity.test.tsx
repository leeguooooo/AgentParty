// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "./i18n/locale";

mock.module("dompurify", () => ({
  default: {
    addHook: () => {},
    sanitize: (value: string) => value,
  },
}));

const { App } = await import("./App");

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

function jwt(sub: string, generation = 1): string {
  const encode = (value: string) => btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode('{"alg":"none"}')}.${encode(JSON.stringify({ sub, generation }))}.sig`;
}

function session(accessToken: string, refreshToken: string, expiresAt: number) {
  return {
    accessToken,
    refreshToken,
    expiresAt,
    identity: JSON.parse(atob(accessToken.split(".")[1]!)) as { sub: string },
  };
}

function storedSession(
  accessToken: string,
  refreshToken: string,
  expiresAt = Math.floor(Date.now() / 1000) - 60,
) {
  const value = session(accessToken, refreshToken, expiresAt);
  return JSON.stringify({ ...value, identity: value.identity.sub });
}

function authHeader(init?: RequestInit): string | null {
  return new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? null;
}

function meResponse() {
  return new Response(JSON.stringify({
    name: "human-a",
    email: "a@example.com",
    kind: "human",
    handle: "human-a",
    display_name: "Human A",
    avatar_url: null,
    avatar_thumb: null,
    provider: "oidc",
    tenant_key: null,
    role: "human",
    owner: null,
  }), { status: 200 });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

let renderer: ReactTestRenderer | null = null;
const globalKeys = [
  "IS_REACT_ACT_ENVIRONMENT",
  "localStorage",
  "sessionStorage",
  "location",
  "history",
  "window",
  "document",
  "navigator",
  "fetch",
] as const;
const originalGlobals = new Map(
  globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: memoryStorage() });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { pathname: "/", search: "", origin: "https://party.example", href: "https://party.example/" },
  });
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    value: { pushState: () => {}, replaceState: () => {} },
  });
  const windowEvents = new EventTarget();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: globalThis.location,
      history: globalThis.history,
      innerWidth: 1200,
      innerHeight: 800,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      addEventListener: windowEvents.addEventListener.bind(windowEvents),
      removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    },
  });
  const documentEvents = new EventTarget();
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      visibilityState: "visible",
      addEventListener: documentEvents.addEventListener.bind(documentEvents),
      removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
    },
  });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "test" } });
});

afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
  for (const key of globalKeys) {
    const descriptor = originalGlobals.get(key);
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, descriptor);
  }
});

describe("App OIDC session identity wiring", () => {
  test("foreign shared session is neither adopted nor refreshed nor cleared", async () => {
    const tokenA = jwt("user-a");
    const tokenB = jwt("user-b");
    localStorage.setItem("ap_token", tokenA);
    localStorage.setItem("ap_oidc_session", storedSession(tokenA, "refresh-a"));

    const firstChannels = deferredResponse();
    const channelTokens: Array<string | null> = [];
    let refreshCalls = 0;
    let lockRequests = 0;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        platform: "test",
        locks: {
          request: async (_name: string, callback: () => Promise<unknown>) => {
            lockRequests += 1;
            return callback();
          },
        },
      },
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/config")) {
          return new Response(JSON.stringify({ oidc: { issuer: "https://idp.example", client_id: "web" } }));
        }
        if (url.endsWith("/api/channels")) {
          channelTokens.push(authHeader(init));
          return firstChannels.promise;
        }
        if (url.endsWith("/api/me")) return meResponse();
        if (url === "https://idp.example/token") {
          refreshCalls += 1;
          throw new Error("foreign refresh token must not be used");
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });

    await act(async () => {
      renderer = create(<LocaleProvider><App /></LocaleProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    localStorage.setItem("ap_token", tokenB);
    const foreignSession = storedSession(tokenB, "refresh-b");
    localStorage.setItem("ap_oidc_session", foreignSession);
    await act(async () => {
      firstChannels.resolve(new Response("unauthorized", { status: 401 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(channelTokens).toEqual([tokenA]);
    expect(refreshCalls).toBe(0);
    expect(lockRequests).toBe(0);
    expect(localStorage.getItem("ap_token")).toBe(tokenB);
    expect(localStorage.getItem("ap_oidc_session")).toBe(foreignSession);
  });

  test("session switched to a foreign identity while waiting for the lock is not adopted or refreshed", async () => {
    const tokenA = jwt("user-a");
    const tokenB = jwt("user-b");
    localStorage.setItem("ap_token", tokenA);
    localStorage.setItem("ap_oidc_session", storedSession(tokenA, "refresh-a"));

    let releaseLock!: () => void;
    let lockRequests = 0;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        platform: "test",
        locks: {
          request: (_name: string, callback: () => Promise<unknown>) => {
            lockRequests += 1;
            return new Promise((resolve, reject) => {
              releaseLock = () => { void callback().then(resolve, reject); };
            });
          },
        },
      },
    });

    const firstChannels = deferredResponse();
    const channelTokens: Array<string | null> = [];
    let refreshCalls = 0;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/config")) {
          return new Response(JSON.stringify({ oidc: { issuer: "https://idp.example", client_id: "web" } }));
        }
        if (url.endsWith("/api/channels")) {
          channelTokens.push(authHeader(init));
          return firstChannels.promise;
        }
        if (url.endsWith("/api/me")) return meResponse();
        if (url === "https://idp.example/token") {
          refreshCalls += 1;
          throw new Error("foreign refresh token must not be used");
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });

    await act(async () => {
      renderer = create(<LocaleProvider><App /></LocaleProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      firstChannels.resolve(new Response("unauthorized", { status: 401 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(lockRequests).toBe(1);

    localStorage.setItem("ap_token", tokenB);
    const foreignSession = storedSession(
      tokenB,
      "refresh-b",
      Math.floor(Date.now() / 1000) + 600,
    );
    localStorage.setItem("ap_oidc_session", foreignSession);
    await act(async () => {
      releaseLock();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(channelTokens).toEqual([tokenA]);
    expect(refreshCalls).toBe(0);
    expect(localStorage.getItem("ap_token")).toBe(tokenB);
    expect(localStorage.getItem("ap_oidc_session")).toBe(foreignSession);
  });

  test("same-identity session refreshes and adopts the rotated credentials", async () => {
    const tokenA = jwt("user-a");
    const refreshedA = jwt("user-a", 2);
    localStorage.setItem("ap_token", tokenA);
    localStorage.setItem("ap_oidc_session", storedSession(tokenA, "refresh-a"));

    const firstChannels = deferredResponse();
    const channelTokens: Array<string | null> = [];
    let refreshCalls = 0;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/config")) {
          return new Response(JSON.stringify({ oidc: { issuer: "https://idp.example", client_id: "web" } }));
        }
        if (url.endsWith("/api/channels")) {
          channelTokens.push(authHeader(init));
          return channelTokens.length === 1 ? firstChannels.promise : new Response('{"channels":[]}');
        }
        if (url.endsWith("/api/me")) return meResponse();
        if (url === "https://idp.example/token") {
          refreshCalls += 1;
          return new Response(JSON.stringify({
            access_token: refreshedA,
            refresh_token: "refresh-a-rotated",
            expires_in: 600,
          }));
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });

    await act(async () => {
      renderer = create(<LocaleProvider><App /></LocaleProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      firstChannels.resolve(new Response("unauthorized", { status: 401 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(refreshCalls).toBe(1);
    expect(channelTokens).toEqual([tokenA, refreshedA]);
    expect(JSON.parse(localStorage.getItem("ap_oidc_session") ?? "null")).toMatchObject({
      accessToken: refreshedA,
      refreshToken: "refresh-a-rotated",
      identity: "user-a",
    });
  });
});
