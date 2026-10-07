// Date-gated shutdown (2026-10-31): AGENTPARTY_SHUTDOWN_AT flips the whole Worker to 410 responses
// at an instant, with no scheduled job. Before the instant nothing may change; an empty/invalid value
// must fail open. Mutation self-check: replacing the gate in src/index.ts with `if (false)` turns the
// "after the instant" cases red (verified when this file was written).
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { isShutdownActive, parseShutdownAt, SHUTDOWN_MESSAGE } from "../src/shutdown";
import { api, createChannel, seedToken, uniq } from "./helpers";

const mutableEnv = env as unknown as Record<string, unknown>;

function setShutdownAt(value: string | undefined): void {
  if (value === undefined) delete mutableEnv.AGENTPARTY_SHUTDOWN_AT;
  else mutableEnv.AGENTPARTY_SHUTDOWN_AT = value;
}

afterEach(() => setShutdownAt(undefined));

const EXPECTED_JSON = {
  error: "agentparty_shut_down",
  message:
    "Agent Party shut down on 2026-10-31. Move to open-cross-session: https://github.com/leeguooooo/open-cross-session — remove the local install: https://github.com/leeguooooo/agentparty/blob/main/docs/uninstall.md",
};

async function normalApiRoundTrip(): Promise<void> {
  const { token } = await seedToken("agent", uniq("tok"));
  const slug = await createChannel(token);
  const res = await api(`/api/channels/${slug}/messages?since=0&limit=1`, token);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).not.toBe("no-store");
}

describe("parseShutdownAt / isShutdownActive", () => {
  it("parses ISO timestamps, 'now', and rejects junk", () => {
    expect(parseShutdownAt("2026-10-31T00:00:00+08:00")).toBe(Date.parse("2026-10-30T16:00:00Z"));
    expect(parseShutdownAt("now")).toBe(Number.NEGATIVE_INFINITY);
    expect(parseShutdownAt(" NOW ")).toBe(Number.NEGATIVE_INFINITY);
    for (const junk of [undefined, "", "   ", "tomorrow", "1", "2026-13-45T99:00:00Z"]) {
      expect(parseShutdownAt(junk)).toBeNull();
    }
  });

  it("is active exactly from the instant on", () => {
    const at = Date.parse("2026-10-31T00:00:00+08:00");
    expect(isShutdownActive("2026-10-31T00:00:00+08:00", at - 1)).toBe(false);
    expect(isShutdownActive("2026-10-31T00:00:00+08:00", at)).toBe(true);
    expect(isShutdownActive("now", 0)).toBe(true);
    expect(isShutdownActive("", at + 1e12)).toBe(false);
    expect(isShutdownActive("garbage", at + 1e12)).toBe(false);
  });
});

describe("before the shutdown instant", () => {
  it("serves the API normally when the instant is in the future", async () => {
    setShutdownAt("2999-01-01T00:00:00Z");
    await normalApiRoundTrip();
    const version = await SELF.fetch("http://ap.test/api/version");
    expect(version.status).toBe(200);
  });

  it("an empty value means normal service", async () => {
    setShutdownAt("");
    await normalApiRoundTrip();
  });

  it("an unparsable value fails open to normal service", async () => {
    setShutdownAt("not-a-date");
    await normalApiRoundTrip();
  });

  it("non-API paths still go to the static assets, not a shutdown page", async () => {
    setShutdownAt("2999-01-01T00:00:00Z");
    const res = await SELF.fetch("http://ap.test/");
    expect(res.status).not.toBe(410);
    expect(await res.text()).not.toContain("open-cross-session");
  });
});

describe("at/after the shutdown instant", () => {
  it("/api/* returns 410 with the shutdown JSON and no-store", async () => {
    setShutdownAt("2020-01-01T00:00:00Z");
    const { token } = await seedToken("agent", uniq("tok"));
    for (const path of ["/api/version", "/api/channels", "/openapi.json"]) {
      const res = await api(path, token);
      expect(res.status, path).toBe(410);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expect(await res.json(), path).toEqual(EXPECTED_JSON);
    }
    expect(EXPECTED_JSON.message).toBe(SHUTDOWN_MESSAGE);
  });

  it("'now' forces it early", async () => {
    setShutdownAt("now");
    const res = await SELF.fetch("http://ap.test/api/version");
    expect(res.status).toBe(410);
  });

  it("a WebSocket upgrade gets 410 instead of 101", async () => {
    setShutdownAt("now");
    const res = await SELF.fetch("http://ap.test/api/channels/anything/ws", {
      headers: { upgrade: "websocket", authorization: "Bearer x" },
    });
    expect(res.status).toBe(410);
    expect(res.webSocket).toBeFalsy();
    expect(await res.json()).toEqual(EXPECTED_JSON);
  });

  it("desktop CORS preflight succeeds so the desktop UI can read the 410", async () => {
    setShutdownAt("now");
    const pre = await SELF.fetch("http://ap.test/api/me", {
      method: "OPTIONS",
      headers: { origin: "tauri://localhost", "access-control-request-method": "GET" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
    const res = await SELF.fetch("http://ap.test/api/me", { headers: { origin: "tauri://localhost" } });
    expect(res.status).toBe(410);
    expect(res.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
  });

  it("/install.sh returns a shell script that prints the notice and exits 1", async () => {
    setShutdownAt("now");
    for (const path of ["/install.sh", "/install-desktop.sh"]) {
      const res = await SELF.fetch(`http://ap.test${path}`);
      expect(res.status, path).toBe(410);
      expect(res.headers.get("content-type"), path).toContain("text/x-shellscript");
      const body = await res.text();
      expect(body.startsWith("#!/bin/sh\n"), path).toBe(true);
      expect(body, path).toContain(">&2");
      expect(body, path).toContain("exit 1");
      expect(body, path).toContain("open-cross-session");
    }
    const ps1 = await SELF.fetch("http://ap.test/install.ps1");
    expect(ps1.status).toBe(410);
    const ps1Body = await ps1.text();
    expect(ps1Body).toContain("exit 1");
    expect(ps1Body).toContain("open-cross-session");
  });

  it("/llms.txt is a plain-text notice; robots.txt disallows everything", async () => {
    setShutdownAt("now");
    const llms = await SELF.fetch("http://ap.test/llms.txt");
    expect(llms.status).toBe(410);
    expect(llms.headers.get("content-type")).toContain("text/plain");
    expect(await llms.text()).toContain("open-cross-session");
    const robots = await SELF.fetch("http://ap.test/robots.txt");
    expect(robots.status).toBe(200);
    expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it("every other path (/, SPA routes, docs) is a self-contained bilingual 410 HTML page", async () => {
    setShutdownAt("now");
    for (const path of ["/", "/c/some-channel", "/docs/", "/join/abc"]) {
      const res = await SELF.fetch(`http://ap.test${path}`);
      expect(res.status, path).toBe(410);
      expect(res.headers.get("content-type"), path).toContain("text/html");
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      const html = await res.text();
      expect(html, path).toContain("open-cross-session");
      expect(html, path).toContain("2026-10-31");
      expect(html, path).toContain("关停");
      expect(html, path).toContain("docs/uninstall.md");
      expect(html, path).toContain("docs/uninstall.zh.md");
      expect(html, path).not.toMatch(/<(script|link)\b/i);
    }
  });

  it("does not touch stored data: the channel is still there once the gate is lifted", async () => {
    const { token } = await seedToken("agent", uniq("tok"));
    const slug = await createChannel(token);
    setShutdownAt("now");
    expect((await api(`/api/channels/${slug}`, token)).status).toBe(410);
    setShutdownAt("2999-01-01T00:00:00Z");
    const res = await api(`/api/channels/${slug}/messages?since=0&limit=1`, token);
    expect(res.status).toBe(200);
  });
});
