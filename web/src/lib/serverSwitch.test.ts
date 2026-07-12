// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { apiBase, apiUrl, clearApiBase, setApiBase, wsUrl } from "./base";
import {
  createInvokeCredentialVault,
  refreshDesktopSession,
  type DesktopCredential,
  type DesktopCredentialVault,
  type DesktopInvoker,
} from "./desktopCredentials";
import {
  addCustomServerProfile,
  loadActiveServerOrigin,
  saveActiveServerOrigin,
  type ServerProfileStorage,
} from "./serverProfiles";
import {
  activateDesktopServerWithAccessToken,
  beginDesktopServerAdd,
  beginDesktopServerPairing,
  cancelDesktopServerPairing,
  completeDesktopServerPairing,
  DesktopServerAuthorizationRequiredError,
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
  test("commits an already-restored access token without refreshing credentials again", () => {
    let runtimeOrigin = "https://agentparty.leeguoo.com";
    const result = activateDesktopServerWithAccessToken(
      "https://party.example.com",
      "interactive-access",
      storage,
      (origin) => { runtimeOrigin = origin; },
    );

    expect(result).toEqual({ origin: "https://party.example.com", accessToken: "interactive-access" });
    expect(loadActiveServerOrigin(storage)).toBe("https://party.example.com");
    expect(runtimeOrigin).toBe("https://party.example.com");
  });

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

  test("preserves target origin when a noninteractive Keychain read requires authorization", async () => {
    let caught: unknown;
    try {
      await switchActiveDesktopServer("https://party.example.com", storage, {
        vaultForOrigin: () => ({
          read: async () => { throw new Error("desktop_keychain_authorization_required"); },
          authorize: async () => null,
          write: async () => {},
          writeInteractive: async () => {},
          delete: async () => {},
          deleteInteractive: async () => {},
        }),
        restore: (targetVault, origin) => refreshDesktopSession(targetVault, [origin], async () => {
          throw new Error("fetch must not run before Keychain authorization");
        }),
        setRuntimeBase: setApiBase,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DesktopServerAuthorizationRequiredError);
    expect((caught as DesktopServerAuthorizationRequiredError).origin).toBe("https://party.example.com");
    expect(loadActiveServerOrigin(storage)).toBe("https://agentparty.leeguoo.com");
    expect(apiBase()).toBe("https://agentparty.leeguoo.com");
  });

  test("persists an already-rotated credential interactively without a second refresh", async () => {
    let refreshCalls = 0;
    let interactiveCredential: DesktopCredential | null = null;
    const targetVault: DesktopCredentialVault = {
      read: async () => ({
        refreshToken: "refresh-old",
        deviceSecret: "device-secret",
        serverOrigin: "https://party.example.com",
        sessionId: "session-1",
      }),
      authorize: async () => null,
      write: async () => { throw new Error("desktop_keychain_authorization_required"); },
      writeInteractive: async (credential) => { interactiveCredential = credential; },
      delete: async () => {},
      deleteInteractive: async () => {},
    };
    let caught: unknown;
    try {
      await switchActiveDesktopServer("https://party.example.com", storage, {
        vaultForOrigin: () => targetVault,
        restore: (nextVault, origin) => refreshDesktopSession(nextVault, [origin], async () => {
          refreshCalls += 1;
          return new Response(JSON.stringify({
            access_token: "private-access",
            refresh_token: "refresh-rotated",
            expires_in: 600,
            session_id: "session-1",
          }), { status: 200, headers: { "content-type": "application/json" } });
        }),
        setRuntimeBase: setApiBase,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DesktopServerAuthorizationRequiredError);
    expect((caught as DesktopServerAuthorizationRequiredError).origin).toBe("https://party.example.com");
    expect(await (caught as DesktopServerAuthorizationRequiredError).authorize(async () => {
      throw new Error("read authorization fallback must not run");
    })).toBe("private-access");
    expect(refreshCalls).toBe(1);
    expect(interactiveCredential).toEqual({
      refreshToken: "refresh-rotated",
      deviceSecret: "device-secret",
      serverOrigin: "https://party.example.com",
      sessionId: "session-1",
    });
    expect(loadActiveServerOrigin(storage)).toBe("https://agentparty.leeguoo.com");
    expect(apiBase()).toBe("https://agentparty.leeguoo.com");
  });

  test("keeps generic restore failures ordinary and preserves their identity", async () => {
    const failure = new TypeError("offline");
    let caught: unknown;
    try {
      await switchActiveDesktopServer("https://party.example.com", storage, {
        vaultForOrigin: () => vault,
        restore: async () => { throw failure; },
        setRuntimeBase: setApiBase,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(loadActiveServerOrigin(storage)).toBe("https://agentparty.leeguoo.com");
    expect(apiBase()).toBe("https://agentparty.leeguoo.com");
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

  test("switching to a private deployment and back preserves the original server session", async () => {
    const prod = "https://agentparty.leeguoo.com";
    const priv = "https://party.example.com";

    // 真实的按 origin 分槽的凭据金库（复用 desktop_credential_* 命令的语义），
    // 配上真实的 refreshDesktopSession，端到端验证往返切换不丢原会话。
    const slots = new Map<string, string>();
    const invoke: DesktopInvoker = async <T>(command: string, args?: Record<string, unknown>) => {
      const origin = String(args?.origin);
      if (command === "desktop_credential_write") slots.set(origin, String(args?.credential));
      if (command === "desktop_credential_delete") slots.delete(origin);
      return (command === "desktop_credential_read" ? slots.get(origin) ?? null : null) as T;
    };
    const vaultForOrigin = (origin: string) => createInvokeCredentialVault(origin, invoke);
    await vaultForOrigin(prod).write({ refreshToken: "prod-r0", deviceSecret: "prod-secret", serverOrigin: prod, sessionId: "prod-session" });
    await vaultForOrigin(priv).write({ refreshToken: "priv-r0", deviceSecret: "priv-secret", serverOrigin: priv, sessionId: "priv-session" });

    const rotations: Record<string, string[]> = { [prod]: ["prod-r1"], [priv]: ["priv-r1"] };
    const refreshed: string[] = [];
    const fetcher = async (url: string | URL | Request) => {
      const origin = new URL(String(url)).origin;
      refreshed.push(origin);
      const next = rotations[origin]!.shift()!;
      return new Response(
        JSON.stringify({ access_token: `${origin}#access`, refresh_token: next, expires_in: 600, session_id: `${origin}#session` }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const dependencies = {
      vaultForOrigin,
      restore: (vault: DesktopCredentialVault, origin: string) => refreshDesktopSession(vault, [origin], fetcher),
      setRuntimeBase: setApiBase,
    };

    // 起始在生产（beforeEach 已设为活跃），切到私有部署。
    const toPrivate = await switchActiveDesktopServer(priv, storage, dependencies);
    expect(toPrivate.origin).toBe(priv);
    expect(apiBase()).toBe(priv);
    // 只轮换了目标（私有）槽；生产会话原封未动，没有被清或被覆盖。
    expect(refreshed).toEqual([priv]);
    expect(JSON.parse(slots.get(prod)!)).toMatchObject({ refreshToken: "prod-r0", serverOrigin: prod });

    // 再切回生产：生产会话仍在（本次轮换到 prod-r1），私有会话也没在往返里丢。
    const toProduction = await switchActiveDesktopServer(prod, storage, dependencies);
    expect(toProduction.origin).toBe(prod);
    expect(toProduction.accessToken).toBe(`${prod}#access`);
    expect(apiBase()).toBe(prod);
    expect(refreshed).toEqual([priv, prod]);
    expect(JSON.parse(slots.get(prod)!)).toMatchObject({ refreshToken: "prod-r1", serverOrigin: prod });
    expect(JSON.parse(slots.get(priv)!)).toMatchObject({ refreshToken: "priv-r1", serverOrigin: priv });
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
