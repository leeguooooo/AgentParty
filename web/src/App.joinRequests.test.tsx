// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "./i18n/locale";

let latestChannelProps: Record<string, unknown> | null = null;

mock.module("./pages/Channel", () => ({
  ChannelPage: (props: Record<string, unknown>) => {
    latestChannelProps = props;
    return <div data-channel-token={String(props.token)} data-share-mode={String(props.shareMode)} />;
  },
}));
mock.module("dompurify", () => ({ default: { addHook: () => {}, sanitize: (value: string) => value } }));

const { App } = await import("./App");

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

let renderer: ReactTestRenderer | null = null;
let joinRequestState: "pending" | "approved" = "pending";
let joinPosts: Array<{ authorization: string | null; body: unknown; url: string }> = [];

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  latestChannelProps = null;
  joinRequestState = "pending";
  joinPosts = [];
  const humanSession = {
    accessToken: "ap_human_access",
    refreshToken: "human-refresh",
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memoryStorage({ ap_token: "ap_human_access", ap_oidc_session: JSON.stringify(humanSession), ap_onboarded: "1" }),
  });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: memoryStorage() });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { pathname: "/c/private-room", search: "?t=ap_watch_secret", href: "https://example.test/c/private-room?t=ap_watch_secret", origin: "https://example.test", hash: "" },
  });
  const events = new EventTarget();
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    value: {
      pushState: (_state: unknown, _unused: string, path: string) => { location.pathname = path.split("?")[0] ?? path; },
      replaceState: (_state: unknown, _unused: string, path: string) => {
        const url = new URL(path, location.origin);
        location.pathname = url.pathname;
        location.search = url.search;
        location.href = url.href;
      },
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location,
      history,
      innerWidth: 1200,
      innerHeight: 800,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} },
  });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("authorization");
      if (url.endsWith("/api/config")) return Response.json({ providers: [] });
      if (url.endsWith("/api/channels/private-room/join-requests") && init?.method === "POST") {
        joinPosts.push({ authorization: auth, body: JSON.parse(String(init.body)), url });
        return Response.json({ request: { id: 7, state: joinRequestState } });
      }
      if (url.endsWith("/api/channels/private-room/join-requests/me")) {
        return Response.json({ request: { id: 7, state: joinRequestState } });
      }
      if (url.endsWith("/api/channels")) {
        return Response.json({ channels: [{ slug: "private-room", mode: "normal", visibility: "private", can_moderate: false }] });
      }
      if (url.endsWith("/api/me")) {
        return Response.json(auth === "Bearer ap_watch_secret"
          ? { name: "watcher", email: null, kind: "human", role: "readonly", owner: null, handle: null, display_name: null, avatar_url: null, avatar_thumb: null, provider: null, tenant_key: null }
          : { name: "human", email: "human@example.test", kind: "human", role: "human", owner: null, handle: "human", display_name: "Human", avatar_url: null, avatar_thumb: null, provider: "oidc", tenant_key: null });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });
});

afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
});

test("uses a temporary human credential for requests while ChannelPage keeps the watch credential", async () => {
  await act(async () => {
    renderer = create(<LocaleProvider><App /></LocaleProvider>);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(latestChannelProps?.token).toBe("ap_watch_secret");
  expect(latestChannelProps?.shareMode).toBe(true);

  await act(async () => {
    await (latestChannelProps?.onRequestJoin as () => Promise<void>)();
  });

  expect(joinPosts).toEqual([{
    authorization: "Bearer ap_human_access",
    body: { watch_token: "ap_watch_secret" },
    url: "/api/channels/private-room/join-requests",
  }]);
  expect(latestChannelProps?.token).toBe("ap_watch_secret");
  expect(latestChannelProps?.shareMode).toBe(true);
  expect(localStorage.getItem("ap_token")).toBe("ap_human_access");
  expect([...Array(localStorage.length)].map((_, i) => localStorage.getItem(localStorage.key(i)!)).join("|")).not.toContain("ap_watch_secret");

  joinRequestState = "approved";
  await act(async () => {
    await (latestChannelProps?.onRefreshJoinRequest as () => Promise<void>)();
  });
  expect(latestChannelProps?.token).toBe("ap_watch_secret");

  await act(async () => {
    await (latestChannelProps?.onEnterApprovedChannel as () => Promise<void>)();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(latestChannelProps?.token).toBe("ap_human_access");
  expect(latestChannelProps?.shareMode).toBe(false);
});

test("uses TokenGate and auto-submits after pasted human login when no human session exists", async () => {
  localStorage.removeItem("ap_token");
  localStorage.removeItem("ap_oidc_session");
  await act(async () => {
    renderer = create(<LocaleProvider><App /></LocaleProvider>);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => { await (latestChannelProps?.onRequestJoin as () => Promise<void>)(); });

  const input = renderer!.root.findByProps({ id: "ap-token" });
  await act(async () => input.props.onChange({ target: { value: "ap_pasted_human" } }));
  await act(async () => {
    renderer!.root.findByProps({ className: "gate-form" }).props.onSubmit({ preventDefault() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(joinPosts).toEqual([{ authorization: "Bearer ap_pasted_human", body: { watch_token: "ap_watch_secret" }, url: "/api/channels/private-room/join-requests" }]);
  expect(localStorage.getItem("ap_token")).toBe("ap_pasted_human");
  expect([...Array(localStorage.length)].map((_, i) => localStorage.getItem(localStorage.key(i)!)).join("|")).not.toContain("ap_watch_secret");
  expect(location.search).not.toContain("ap_watch_secret");
});
