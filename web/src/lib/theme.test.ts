// @ts-expect-error Bun executes this test; the web tsconfig only loads Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyStoredTheme, applyTheme, DEFAULT_THEME, readStoredTheme, SUPPORTED_THEMES } from "./theme";

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

let attribute: string | null = null;

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
  attribute = null;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      documentElement: {
        setAttribute: (name: string, value: string) => { if (name === "data-theme") attribute = value; },
      },
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
  Reflect.deleteProperty(globalThis, "document");
});

describe("theme persistence + application", () => {
  test("defaults to doodle when nothing stored", () => {
    expect(DEFAULT_THEME).toBe("doodle");
    expect(readStoredTheme()).toBe("doodle");
  });

  test("reads a stored midnight theme", () => {
    localStorage.setItem("ap_theme", "midnight");
    expect(readStoredTheme()).toBe("midnight");
  });

  test("falls back to default for an unknown stored value", () => {
    localStorage.setItem("ap_theme", "banana");
    expect(readStoredTheme()).toBe("doodle");
  });

  test("applyTheme sets the data-theme attribute and persists", () => {
    applyTheme("midnight");
    expect(attribute).toBe("midnight");
    expect(localStorage.getItem("ap_theme")).toBe("midnight");
    applyTheme("doodle");
    expect(attribute).toBe("doodle");
    expect(localStorage.getItem("ap_theme")).toBe("doodle");
  });

  test("applyStoredTheme applies whatever was persisted", () => {
    localStorage.setItem("ap_theme", "midnight");
    applyStoredTheme();
    expect(attribute).toBe("midnight");
  });

  test("exposes exactly the two shipped themes", () => {
    expect(SUPPORTED_THEMES.map((theme) => theme.code)).toEqual(["doodle", "midnight"]);
  });
});
