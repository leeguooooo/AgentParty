// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { saveToken, storedToken } from "./api";

let values: Map<string, string>;

beforeEach(() => {
  values = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "__TAURI_INTERNALS__");
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("desktop never persists a pasted party token (#248)", () => {
  test("the browser still persists a pasted token so refresh keeps the session", () => {
    saveToken("ap_pasted_in_browser");
    expect(storedToken()).toBe("ap_pasted_in_browser");
  });

  test("the desktop runtime refuses to write a pasted party token to any persistent store", () => {
    Object.defineProperty(globalThis, "__TAURI_INTERNALS__", { configurable: true, value: {} });

    saveToken("ap_pasted_in_desktop_must_not_persist");

    // 桌面自身的持久化存储里绝不能出现粘贴的 party token（只允许设备码/OIDC 会话）。
    expect(storedToken()).toBeNull();
    expect([...values.values()].join("|")).not.toContain("ap_pasted_in_desktop_must_not_persist");
  });
});
