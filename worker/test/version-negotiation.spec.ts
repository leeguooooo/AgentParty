import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  CLIENT_TOO_OLD_HEADER,
  CLIENT_VERSION_HEADER,
  DEFAULT_MIN_CLIENT_VERSION,
  MIN_CLIENT_VERSION_HEADER,
  clientTooOldNotice,
  compareClientVersions,
  evaluateClientVersion,
  isEnforced,
  resolveMinClientVersion,
} from "../src/client-version";

// #137 发布兼容——版本协商的纯逻辑（min-version 判定、enforce 解析、结构化信号形状）。
describe("client version negotiation logic (issue #137)", () => {
  it("compares semver by numeric X.Y.Z segments", () => {
    expect(compareClientVersions("0.2.1", "0.2.0")).toBe(1);
    expect(compareClientVersions("0.2.0", "0.2.1")).toBe(-1);
    expect(compareClientVersions("0.2.0", "0.2.0")).toBe(0);
    expect(compareClientVersions("1.0.0", "0.9.9")).toBe(1);
    // 预发行后缀被忽略，只看前三段
    expect(compareClientVersions("0.2.0-beta.1", "0.2.0")).toBe(0);
  });

  it("flags a below-min client as too_old", () => {
    const v = evaluateClientVersion("0.1.0", "0.2.0");
    expect(v.status).toBe("too_old");
    expect(v.client_version).toBe("0.1.0");
    expect(v.min_client_version).toBe("0.2.0");
  });

  it("leaves an at/above-min client unaffected (ok)", () => {
    expect(evaluateClientVersion("0.2.0", "0.2.0").status).toBe("ok");
    expect(evaluateClientVersion("0.2.94", "0.2.0").status).toBe("ok");
  });

  it("treats a missing or malformed version header as unknown (legacy), never too_old", () => {
    expect(evaluateClientVersion(undefined, "0.2.0").status).toBe("unknown");
    expect(evaluateClientVersion(null, "0.2.0").status).toBe("unknown");
    expect(evaluateClientVersion("", "0.2.0").status).toBe("unknown");
    expect(evaluateClientVersion(" 1.2.3", "0.2.0").status).toBe("unknown");
    expect(evaluateClientVersion("x".repeat(65), "0.2.0").status).toBe("unknown");
  });

  it("parses the enforce flag from common truthy strings only", () => {
    for (const on of ["1", "true", "TRUE", "yes", "on"]) expect(isEnforced(on)).toBe(true);
    for (const off of ["0", "false", "no", "off", "", undefined, null]) expect(isEnforced(off)).toBe(false);
  });

  it("resolves the min version from env, falling back to the default on absent/invalid input", () => {
    expect(resolveMinClientVersion("0.5.0")).toBe("0.5.0");
    expect(resolveMinClientVersion(undefined)).toBe(DEFAULT_MIN_CLIENT_VERSION);
    expect(resolveMinClientVersion("")).toBe(DEFAULT_MIN_CLIENT_VERSION);
    expect(resolveMinClientVersion(" not a version ")).toBe(DEFAULT_MIN_CLIENT_VERSION);
  });

  it("builds a structured client_too_old notice mirroring the cli_upgrade ask-user flow", () => {
    const notice = clientTooOldNotice(evaluateClientVersion("0.1.0", "0.2.0"));
    expect(notice.error.code).toBe("client_too_old");
    expect(notice.action_required).toBe("ask_user");
    expect(notice.min_client_version).toBe("0.2.0");
    expect(notice.client_version).toBe("0.1.0");
    expect(notice.command).toContain("install.sh");
  });
});

// #137——/api/version 端点 + REST 层 min-version 护栏（默认建言：低版本照常放行，只加信号头）。
describe("version endpoint and advisory guardrail (issue #137)", () => {
  it("exposes server version/commit + declared min client version, uncached", async () => {
    const res = await SELF.fetch("http://ap.test/api/version");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      version: "dev",
      commit: "unknown",
      deployed_at: null,
      min_client_version: DEFAULT_MIN_CLIENT_VERSION,
      min_client_enforced: false,
    });
  });

  it("never guards /api/version itself, so an old client can always learn it is old", async () => {
    const res = await SELF.fetch("http://ap.test/api/version", {
      headers: { [CLIENT_VERSION_HEADER]: "0.0.1" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(CLIENT_TOO_OLD_HEADER)).toBeNull();
  });

  it("advises (does not reject) a below-min client, tagging the response and advertising the floor", async () => {
    const res = await SELF.fetch("http://ap.test/api/config", {
      headers: { [CLIENT_VERSION_HEADER]: "0.1.0" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(CLIENT_TOO_OLD_HEADER)).toBe("1");
    expect(res.headers.get(MIN_CLIENT_VERSION_HEADER)).toBe(DEFAULT_MIN_CLIENT_VERSION);
  });

  it("leaves an at/above-min client unflagged", async () => {
    const res = await SELF.fetch("http://ap.test/api/config", {
      headers: { [CLIENT_VERSION_HEADER]: "9.9.9" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get(CLIENT_TOO_OLD_HEADER)).toBeNull();
    expect(res.headers.get(MIN_CLIENT_VERSION_HEADER)).toBe(DEFAULT_MIN_CLIENT_VERSION);
  });

  it("keeps a no-version (legacy) client working and unflagged", async () => {
    const res = await SELF.fetch("http://ap.test/api/config");
    expect(res.status).toBe(200);
    expect(res.headers.get(CLIENT_TOO_OLD_HEADER)).toBeNull();
  });
});
