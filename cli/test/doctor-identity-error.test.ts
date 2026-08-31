// #1013：`identity_unavailable` 以前把超时 / 401 / 网络不通挤成一个词，而这三种的处置完全相反。
// 这里钉住分档本身、报告字段，以及 fix_lines 是否对症。
import { describe, expect, test } from "bun:test";
import type { PresenceEntry } from "@agentparty/shared";
import {
  classifyIdentityError,
  claudePluginDoctorFixLines,
  inspectClaudePluginReadiness,
  type ClaudePluginDoctorDependencies,
} from "../src/commands/doctor";
import { RestError } from "../src/rest";

function deps(identity: () => Promise<never>): ClaudePluginDoctorDependencies {
  return {
    claudeVersion: () => "2.1.228 (Claude Code)",
    claudePlugins: () => null,
    inspectBundle: () => ({ valid: true, launcherExecutable: true }),
    resolveAuth: async () => ({
      server: "https://agentparty.example.com",
      token: "private-test-token",
      auth_source: "runtime_config",
      config: { kind: "workspace", path: "/private/config", workspace_id: "workspace" },
      account: { present: false, path: "/private/account" },
    }),
    channel: () => "dev",
    identity,
    presence: async () => [] as PresenceEntry[],
    runtimeTopology: () => undefined,
    runtimePeers: async () => ({ self: "nobody", peers: [] }) as never,
  };
}

const timeoutError = (): never => {
  throw new DOMException("The operation timed out.", "TimeoutError");
};
const unauthorizedError = (): never => {
  throw new RestError(401, "unauthorized", "agent token revoked");
};
const networkError = (): never => {
  throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("dns"), { code: "ENOTFOUND" }) });
};

describe("identity_unavailable classification (#1013)", () => {
  test("classifies timeout, 401, network, and unknown apart", () => {
    expect(classifyIdentityError(new DOMException("timed out", "TimeoutError")).kind).toBe("timeout");
    expect(classifyIdentityError(new DOMException("aborted", "AbortError")).kind).toBe("timeout");
    expect(classifyIdentityError(new RestError(401, "unauthorized", "nope")).kind).toBe("unauthorized");
    expect(classifyIdentityError(new RestError(403, "forbidden", "nope")).kind).toBe("unauthorized");
    expect(classifyIdentityError(new RestError(502, null, "bad gateway")).kind).toBe("network");
    expect(
      classifyIdentityError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })).kind,
    ).toBe("network");
    expect(classifyIdentityError(Object.assign(new Error("boom"), { code: "ENOTFOUND" })).kind).toBe("network");
    expect(classifyIdentityError(new RestError(418, null, "teapot")).kind).toBe("unknown");
    expect(classifyIdentityError(new Error("something else")).kind).toBe("unknown");
  });

  test("scrubs terminal control sequences out of the server's own words", () => {
    const classified = classifyIdentityError(
      new RestError(401, "unauthorized", "\u001b[31mrevoked\u0007\nby owner"),
    );
    expect(classified.kind).toBe("unauthorized");
    expect(classified.message).not.toContain("\u001b");
    expect(classified.message).not.toContain("\u0007");
    expect(classified.message).not.toContain("\n");
    expect(classified.message).toContain("revoked");
  });

  test("the report carries the classification per failure mode", async () => {
    for (const [thrower, expected] of [
      [timeoutError, "timeout"],
      [unauthorizedError, "unauthorized"],
      [networkError, "network"],
    ] as const) {
      const report = await inspectClaudePluginReadiness(undefined, deps(async () => thrower()));
      expect(report.blockers).toContain("identity_unavailable");
      expect(report.auth.identity_error).toBe(expected);
      expect(typeof report.auth.identity_error_message).toBe("string");
    }
  });

  test("a healthy identity leaves the new fields absent (old schema untouched)", async () => {
    const report = await inspectClaudePluginReadiness(undefined, {
      ...deps(async () => timeoutError()),
      identity: async () => ({ name: "a", email: null, kind: "agent", role: "agent", owner: null }),
    });
    expect(report.blockers).not.toContain("identity_unavailable");
    expect(report.auth.identity_error).toBeUndefined();
    expect(report.auth.identity_error_message).toBeUndefined();
  });

  test("fix lines are per-cause, not one generic sentence", () => {
    const base = {
      blockers: ["identity_unavailable" as const],
      plugin: { installed: true, enabled: true, bundle_valid: true, launcher_executable: true },
      runtime_version: "0.2.223",
    };
    const line = (kind: "timeout" | "unauthorized" | "network" | "unknown") =>
      claudePluginDoctorFixLines({ ...base, auth: { identity_error: kind, identity_error_message: "why" } })
        .join("\n");

    expect(line("timeout")).toContain("retry");
    expect(line("unauthorized")).toContain("party init --token");
    expect(line("network")).toContain("network");
    expect(line("unknown")).toContain("auth.identity_error");

    // 四档必须互不相同——否则「分档」等于没做。
    const all = (["timeout", "unauthorized", "network", "unknown"] as const).map(line);
    expect(new Set(all).size).toBe(4);

    // 老调用方不传 auth 也不能崩，落兜底那条。
    expect(claudePluginDoctorFixLines(base).join("\n")).toContain("could not read this agent identity");
  });
});
