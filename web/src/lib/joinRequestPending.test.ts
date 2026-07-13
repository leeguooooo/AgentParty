// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearPendingJoinRequest,
  readJoinRequestTarget,
  readPendingJoinRequest,
  rememberJoinRequestTarget,
  savePendingJoinRequest,
} from "./joinRequestPending";

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

let session: Storage;

beforeEach(() => {
  session = memoryStorage();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: session });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new Proxy({}, { get: () => { throw new Error("join request flow must not touch localStorage"); } }),
  });
});

describe("pending watch-token join request storage", () => {
  test("keeps the slug, application note, and TTL without copying the watch credential", () => {
    session.setItem("ap_share_token", "ap_watch_secret");
    savePendingJoinRequest({ slug: "private-room", note: "  release testing  " }, 1_000);

    expect(readPendingJoinRequest(1_001)).toEqual({ slug: "private-room", note: "release testing", expiresAt: 901_000 });
    expect(session.getItem("ap_pending_join_request")).toBe('{"slug":"private-room","note":"release testing","expiresAt":901000}');
    expect(session.getItem("ap_pending_join_request")).not.toContain("ap_watch_secret");
  });

  test("reads legacy pending markers as an empty optional note", () => {
    session.setItem("ap_pending_join_request", '{"slug":"private-room","expiresAt":901000}');
    expect(readPendingJoinRequest(1_001)).toEqual({ slug: "private-room", note: "", expiresAt: 901_000 });
  });

  test("drops malformed and expired pending values", () => {
    session.setItem("ap_pending_join_request", '{"slug":"../bad","expiresAt":2000}');
    expect(readPendingJoinRequest()).toBeNull();
    expect(session.getItem("ap_pending_join_request")).toBeNull();

    savePendingJoinRequest({ slug: "valid-room" }, 1_000);
    expect(readPendingJoinRequest(901_001)).toBeNull();

    expect(() => savePendingJoinRequest({ slug: "valid-room", note: "x".repeat(2001) }, 1_000)).toThrow();
  });

  test("clearing the marker leaves the existing share credential alone", () => {
    session.setItem("ap_share_token", "ap_watch_secret");
    savePendingJoinRequest({ slug: "private-room" }, 1_000);
    rememberJoinRequestTarget("private-room");
    clearPendingJoinRequest();

    expect(readPendingJoinRequest()).toBeNull();
    expect(readJoinRequestTarget()).toBe("private-room");
    expect(session.getItem("ap_share_token")).toBe("ap_watch_secret");
  });
});
