// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { apiBase, apiUrl, clearApiBase, setApiBase, wsUrl } from "./base";
import type { DesktopCredentialVault } from "./desktopCredentials";
import {
  addCustomServerProfile,
  loadActiveServerOrigin,
  saveActiveServerOrigin,
  type ServerProfileStorage,
} from "./serverProfiles";
import {
  beginDesktopServerAdd,
  beginDesktopServerPairing,
  cancelDesktopServerPairing,
  completeDesktopServerPairing,
  DesktopServerNotPairedError,
  initialDesktopServerPairingFlow,
  switchActiveDesktopServer,
} from "./serverSwitch";

let values: Map<string, string>;
let storage: ServerProfileStorage;

beforeEach(() => {
  values = new Map();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } });
  storage = globalThis.localStorage;
  addCustomServerProfile(storage, { label: "Private", origin: "https://party.example.com" });
  saveActiveServerOrigin(storage, "https://agentparty.leeguoo.com");
  setApiBase("https://agentparty.leeguoo.com");
});

afterEach(() => {
  clearApiBase();
  Reflect.deleteProperty(globalThis, "localStorage");
});

const vault = {} as DesktopCredentialVault;

describe("atomic desktop server switching", () => {
  test("restores the target session before committing active API and WS base", async () => {
    const order: string[] = [];
    const result = await switchActiveDesktopServer("https://party.example.com", storage, {
      vaultForOrigin: (origin) => {
        order.push(`vault:${origin}`);
        return vault;
      },
      restore: async (_vault, origin) => {
        order.push(`restore:${origin}:${apiBase()}`);
        return "private-access";
      },
      setRuntimeBase: (origin) => {
        order.push(`base:${origin}`);
        setApiBase(origin);
      },
    });

    expect(result).toEqual({ origin: "https://party.example.com", accessToken: "private-access" });
    expect(order).toEqual([
      "vault:https://party.example.com",
      "restore:https://party.example.com:https://agentparty.leeguoo.com",
      "base:https://party.example.com",
    ]);
    expect(loadActiveServerOrigin(storage)).toBe("https://party.example.com");
    expect(apiUrl("/api/channels")).toBe("https://party.example.com/api/channels");
    expect(wsUrl("/api/channels/general/ws")).toBe("wss://party.example.com/api/channels/general/ws");
  });

  test("keeps the current connection intact when target restore fails", async () => {
    await expect(switchActiveDesktopServer("https://party.example.com", storage, {
      vaultForOrigin: () => vault,
      restore: async () => { throw new Error("target refresh failed"); },
      setRuntimeBase: setApiBase,
    })).rejects.toThrow("target refresh failed");

    expect(loadActiveServerOrigin(storage)).toBe("https://agentparty.leeguoo.com");
    expect(apiBase()).toBe("https://agentparty.leeguoo.com");
    expect(apiUrl("/api/me")).toBe("https://agentparty.leeguoo.com/api/me");
  });

  test("rejects switching to a server that has no device session", async () => {
    try {
      await switchActiveDesktopServer("https://party.example.com", storage, {
        vaultForOrigin: () => vault,
        restore: async () => null,
        setRuntimeBase: setApiBase,
      });
      throw new Error("expected unpaired switch to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DesktopServerNotPairedError);
      expect((error as DesktopServerNotPairedError).origin).toBe("https://party.example.com");
    }
    expect(apiBase()).toBe("https://agentparty.leeguoo.com");
  });

  test("keeps paired-server switching as one restore-and-commit action", async () => {
    let restores = 0;
    let commits = 0;
    await switchActiveDesktopServer("https://party.example.com", storage, {
      vaultForOrigin: () => vault,
      restore: async () => {
        restores += 1;
        return "private-access";
      },
      setRuntimeBase: (origin) => {
        commits += 1;
        setApiBase(origin);
      },
    });
    expect(restores).toBe(1);
    expect(commits).toBe(1);
  });
});

describe("logged-in add and pair flow", () => {
  const currentOrigin = "https://agentparty.leeguoo.com";
  const targetOrigin = "https://private.example.com";

  test("moves from the logged-in add view into pairing for the probed target", () => {
    const adding = beginDesktopServerAdd(initialDesktopServerPairingFlow(currentOrigin));
    const pairing = beginDesktopServerPairing(adding, targetOrigin);

    expect(adding).toEqual({ phase: "adding", activeOrigin: currentOrigin, targetOrigin: null });
    expect(pairing).toEqual({ phase: "pairing", activeOrigin: currentOrigin, targetOrigin });
  });

  test("cancel or pairing failure returns to the old origin without credential deletion", () => {
    let oldCredentialDeletes = 0;
    const pairing = beginDesktopServerPairing(
      beginDesktopServerAdd(initialDesktopServerPairingFlow(currentOrigin)),
      targetOrigin,
    );

    const cancelled = cancelDesktopServerPairing(pairing);
    const failed = cancelDesktopServerPairing(pairing);

    expect(cancelled).toEqual({ phase: "connected", activeOrigin: currentOrigin, targetOrigin: null });
    expect(failed).toEqual(cancelled);
    expect(oldCredentialDeletes).toBe(0);
  });

  test("commits the target origin only after pairing succeeds", () => {
    const pairing = beginDesktopServerPairing(
      beginDesktopServerAdd(initialDesktopServerPairingFlow(currentOrigin)),
      targetOrigin,
    );
    expect(pairing.activeOrigin).toBe(currentOrigin);
    expect(completeDesktopServerPairing(pairing)).toEqual({
      phase: "connected",
      activeOrigin: targetOrigin,
      targetOrigin: null,
    });
  });
});
