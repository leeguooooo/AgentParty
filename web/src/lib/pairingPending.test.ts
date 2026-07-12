// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import {
  clearPendingPairing,
  readPendingPairing,
  rememberPendingPairing,
} from "./pairingPending";

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

describe("pending desktop pairing route", () => {
  test("survives an account switch and clears only after the pairing decision completes", () => {
    const storage = memoryStorage();
    rememberPendingPairing(storage, {
      code: "AB12C-DE34F",
      serverOrigin: "https://agentparty.leeguoo.com",
    });

    expect(readPendingPairing(storage)).toEqual({
      code: "AB12C-DE34F",
      routePending: true,
      serverOrigin: "https://agentparty.leeguoo.com",
    });

    clearPendingPairing(storage);
    expect(readPendingPairing(storage)).toEqual({
      code: null,
      routePending: false,
      serverOrigin: null,
    });
  });

  test("does not overwrite an existing code or server when only refreshing the route marker", () => {
    const storage = memoryStorage();
    rememberPendingPairing(storage, {
      code: "AB12C-DE34F",
      serverOrigin: "https://agentparty.leeguoo.com",
    });
    rememberPendingPairing(storage, {});

    expect(readPendingPairing(storage)).toMatchObject({
      code: "AB12C-DE34F",
      routePending: true,
      serverOrigin: "https://agentparty.leeguoo.com",
    });
  });

  test("updates or explicitly clears a remembered code without losing the server", () => {
    const storage = memoryStorage();
    rememberPendingPairing(storage, {
      code: "AB12C-DE34F",
      serverOrigin: "https://agentparty.leeguoo.com",
    });

    rememberPendingPairing(storage, { code: "FG56H-JK78L" });
    expect(readPendingPairing(storage)).toEqual({
      code: "FG56H-JK78L",
      routePending: true,
      serverOrigin: "https://agentparty.leeguoo.com",
    });

    rememberPendingPairing(storage, { code: null });
    expect(readPendingPairing(storage)).toEqual({
      code: null,
      routePending: true,
      serverOrigin: "https://agentparty.leeguoo.com",
    });
  });
});
