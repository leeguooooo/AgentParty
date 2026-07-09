import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { apiBase, apiUrl, clearApiBase, setApiBase, wsUrl } from "./base";

beforeEach(() => {
  const values = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
});

afterEach(() => {
  clearApiBase();
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("api base", () => {
  test("defaults to browser-relative URLs", () => {
    clearApiBase();

    expect(apiBase()).toBe("");
    expect(apiUrl("/api/me")).toBe("/api/me");
  });

  test("normalizes and applies a runtime API base", () => {
    setApiBase("https://agentparty.pwtk-dev.work///");

    expect(apiBase()).toBe("https://agentparty.pwtk-dev.work");
    expect(apiUrl("/api/channels")).toBe("https://agentparty.pwtk-dev.work/api/channels");
  });

  test("derives websocket URLs from the configured API base", () => {
    setApiBase("https://agentparty.leeguoo.com");

    expect(wsUrl("/api/channels/demo/ws?t=abc")).toBe("wss://agentparty.leeguoo.com/api/channels/demo/ws?t=abc");
  });
});
