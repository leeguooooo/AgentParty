// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "./i18n/locale";
import { readPendingPairing } from "./lib/pairingPending";

mock.module("./pages/Channel", () => ({ ChannelPage: () => null }));
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
let decisions: Array<{ authorization: string | null; body: unknown }> = [];

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Reflect.deleteProperty(globalThis, "__TAURI_INTERNALS__");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memoryStorage({ ap_token: "ap_agent", ap_onboarded: "1" }),
  });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: memoryStorage() });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: {
      pathname: "/pair",
      search: "?code=AB12C-DE34F",
      href: "https://agentparty.leeguoo.com/pair?code=AB12C-DE34F",
      origin: "https://agentparty.leeguoo.com",
      hash: "",
    },
  });
  const events = new EventTarget();
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    value: {
      pushState: () => {},
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
      focus: () => {},
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} },
  });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  decisions = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("authorization");
      if (url.endsWith("/api/config")) {
        return Response.json({ oidc: { issuer: "https://account.leeguoo.com", client_id: "agentparty-web" } });
      }
      if (url.endsWith("/api/desktop/pairings/inspect")) {
        if (authorization === "Bearer ap_agent") return new Response(null, { status: 403 });
        if (authorization === "Bearer ap_human") {
          return Response.json({
            pairing_id: "pair-1",
            device: { name: "Leo's Mac", platform: "macos", app_version: "0.2.101" },
          });
        }
      }
      if (url.endsWith("/api/desktop/pairings/decision")) {
        decisions.push({ authorization, body: JSON.parse(String(init?.body)) });
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });
});

afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
});

test("preserves the pairing through a human-token switch and clears it after approval", async () => {
  await act(async () => {
    renderer = create(<LocaleProvider><App /></LocaleProvider>);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(renderer!.root.findByProps({ className: "d-btn pair-human-login" })).toBeTruthy();
  await act(async () => renderer!.root.findByProps({ className: "d-btn pair-human-login" }).props.onClick());

  expect(localStorage.getItem("ap_token")).toBeNull();
  expect(readPendingPairing(sessionStorage)).toEqual({
    code: "AB12C-DE34F",
    routePending: true,
    serverOrigin: "https://agentparty.leeguoo.com",
  });
  expect(renderer!.root.findAllByType("button")
    .some((button) => button.children.includes("Sign in with account center"))).toBe(true);
  expect(renderer!.root.findByProps({ id: "ap-token" })).toBeTruthy();

  await act(async () => {
    renderer!.root.findByProps({ id: "ap-token" }).props.onChange({ target: { value: "ap_human" } });
  });
  await act(async () => {
    renderer!.root.findByProps({ className: "gate-form" }).props.onSubmit({ preventDefault() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const approve = renderer!.root.findAllByType("button")
    .find((button) => button.children.includes("Approve this device"));
  expect(approve).toBeTruthy();
  expect(readPendingPairing(sessionStorage).code).toBe("AB12C-DE34F");

  await act(async () => {
    approve!.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(decisions).toEqual([{
    authorization: "Bearer ap_human",
    body: { pairing_id: "pair-1", user_code: "AB12C-DE34F", decision: "approve" },
  }]);
  expect(readPendingPairing(sessionStorage)).toEqual({ code: null, routePending: false, serverOrigin: null });
});
