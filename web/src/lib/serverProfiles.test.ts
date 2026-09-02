// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import {
  OFFICIAL_SERVER_PROFILES,
  addCustomServerProfile,
  isLeeguoooooDeployment,
  loadActiveServerOrigin,
  loadServerProfiles,
  normalizeServerOrigin,
  probeServerProfile,
  saveActiveServerOrigin,
  type ServerProfileStorage,
} from "./serverProfiles";

function memoryStorage(): ServerProfileStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

describe("server origin validation", () => {
  test("accepts HTTPS and loopback HTTP as a normalized origin", () => {
    expect(normalizeServerOrigin("https://party.example.com/")).toBe("https://party.example.com");
    expect(normalizeServerOrigin("http://localhost:8787/")).toBe("http://localhost:8787");
    expect(normalizeServerOrigin("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(normalizeServerOrigin("http://[::1]:8787")).toBe("http://[::1]:8787");
  });

  test("accepts plain HTTP on private-network hosts (intranet self-hosting)", () => {
    for (const [input, origin] of [
      ["http://10.240.40.226:8790", "http://10.240.40.226:8790"],
      ["http://192.168.0.197:8787/", "http://192.168.0.197:8787"],
      ["http://172.31.5.5", "http://172.31.5.5"],
      ["http://169.254.1.1:80", "http://169.254.1.1"],
      ["http://100.100.1.1:8787", "http://100.100.1.1:8787"],
      ["http://[fd12:3456::1]:8787", "http://[fd12:3456::1]:8787"],
      ["http://[fe80::1]:8787", "http://[fe80::1]:8787"],
      ["http://agentparty:8787", "http://agentparty:8787"],
      ["http://nas.local:8787", "http://nas.local:8787"],
      ["http://party.corp.internal", "http://party.corp.internal"],
      ["http://ap.lan:8787", "http://ap.lan:8787"],
    ] as const) {
      expect(normalizeServerOrigin(input)).toBe(origin);
    }
  });

  test("rejects public HTTP, userinfo, and any path/query/fragment", () => {
    for (const input of [
      "http://party.example.com",
      "http://8.8.8.8:8787",
      "http://172.32.0.1",
      "http://100.128.0.1",
      "http://[2001:db8::1]",
      "http://evil.notlocal",
      "http://x.local.example.com",
      "https://user:pass@party.example.com",
      "https://party.example.com/api",
      "https://party.example.com?tenant=a",
      "https://party.example.com/#pair",
      "ftp://party.example.com",
    ]) {
      expect(normalizeServerOrigin(input)).toBeNull();
    }
  });
});

describe("server profiles", () => {
  test("names the shared deployments by owner and recognizes membership billing scope", () => {
    expect(OFFICIAL_SERVER_PROFILES.map((profile) => profile.label)).toEqual([
      "leeguooooo",
      "xdreamstart",
    ]);
    expect(isLeeguoooooDeployment("https://agentparty.leeguoo.com")).toBe(true);
    expect(isLeeguoooooDeployment("https://agentparty.pwtk-dev.work")).toBe(false);
    expect(isLeeguoooooDeployment("https://private.example.com")).toBe(false);
  });

  test("always includes official prod/test and stores only custom label/origin", () => {
    const storage = memoryStorage();
    const snapshots: string[] = [];
    const profiles = addCustomServerProfile(storage, {
      label: "Team Party",
      origin: "https://party.example.com",
    }, (mutatedStorage) => {
      snapshots.push(mutatedStorage.getItem("ap_server_profiles_v1") ?? "missing");
    });

    expect(profiles.slice(0, 2)).toEqual(OFFICIAL_SERVER_PROFILES);
    expect(profiles.at(-1)).toEqual({
      id: "custom:https://party.example.com",
      label: "Team Party",
      origin: "https://party.example.com",
      kind: "custom",
    });
    const persisted = [...storage.values.values()].join("\n");
    expect(persisted).toContain("party.example.com");
    expect(persisted).not.toMatch(/refresh|device.secret|access.token/i);
    expect(loadServerProfiles(storage)).toEqual(profiles);
    expect(snapshots).toEqual([
      '[{"label":"Team Party","origin":"https://party.example.com"}]',
    ]);
  });

  test("persists an active origin only when it belongs to a profile", () => {
    const storage = memoryStorage();
    const snapshots: string[] = [];
    addCustomServerProfile(storage, { label: "Team", origin: "https://party.example.com" }, () => {});
    saveActiveServerOrigin(storage, "https://party.example.com", (mutatedStorage) => {
      snapshots.push(mutatedStorage.getItem("ap_active_server_origin_v1") ?? "missing");
    });
    expect(loadActiveServerOrigin(storage)).toBe("https://party.example.com");
    expect(snapshots).toEqual(["https://party.example.com"]);

    expect(() => saveActiveServerOrigin(storage, "https://unknown.example.com")).toThrow();
    expect(loadActiveServerOrigin(storage)).toBe("https://party.example.com");
  });
});

describe("server probing", () => {
  test("requires health and config and returns displayable auth providers", async () => {
    const calls: Array<{ url: string; redirect?: RequestRedirect }> = [];
    const result = await probeServerProfile("https://party.example.com", async (input, init) => {
      const url = String(input);
      calls.push({ url, redirect: init?.redirect });
      if (url.endsWith("/api/health")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        oidc: null,
        auth: {
          providers: [{
            id: "lark",
            kind: "lark",
            label: "Sign in with Lark",
            client_id: "public-client",
            authorize_url: "https://open.larksuite.com/open-apis/authen/v1/authorize",
            scope: "contact:user.base:readonly",
          }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    expect(calls).toEqual([
      { url: "https://party.example.com/api/health", redirect: "manual" },
      { url: "https://party.example.com/api/config", redirect: "manual" },
    ]);
    expect(result.origin).toBe("https://party.example.com");
    expect(result.providers.map((provider) => provider.label)).toEqual(["Sign in with Lark"]);
  });

  test("rejects a redirect to a different origin", async () => {
    await expect(probeServerProfile("https://party.example.com", async () => new Response(null, {
      status: 302,
      headers: { location: "https://evil.example/api/health" },
    }))).rejects.toThrow("redirect");
  });

  test("reports missing providers without inventing a desktop provider secret", async () => {
    const result = await probeServerProfile("https://party.example.com", async (input) => (
      String(input).endsWith("/api/health")
        ? new Response("{}", { status: 200 })
        : new Response(JSON.stringify({ oidc: null, auth: { providers: [] } }), { status: 200 })
    ));
    expect(result.providers).toEqual([]);
  });
});
