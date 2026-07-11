import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertDeveloperIdSubject,
  buildSecretPlan,
  parseProvisionOptions,
  publishSecretPlan,
} from "./configure-apple-release";

function fixtures() {
  const directory = mkdtempSync(join(tmpdir(), "apple-release-"));
  const certificate = join(directory, "developer-id.p12");
  const apiKey = join(directory, "AuthKey_KEY1234567.p8");
  writeFileSync(certificate, "p12-bytes", { mode: 0o600 });
  writeFileSync(apiKey, "-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----\n", { mode: 0o600 });
  chmodSync(certificate, 0o600);
  chmodSync(apiKey, 0o600);
  return { directory, certificate, apiKey };
}

describe("configure Apple release credentials", () => {
  test("accepts only explicit repository and authentication mode", () => {
    expect(parseProvisionOptions(["--repo", "leeguooooo/AgentParty", "--mode", "api-key", "--dry-run"])).toEqual({
      repo: "leeguooooo/AgentParty",
      environment: "release",
      mode: "api-key",
      dryRun: true,
    });
    expect(() => parseProvisionOptions(["--repo", "bad", "--mode", "api-key"])).toThrow("owner/name");
    expect(() => parseProvisionOptions(["--repo", "o/r", "--mode", "password-in-argv"])).toThrow("--mode");
  });

  test("builds a validated API-key plan from private files and environment values", () => {
    const fixture = fixtures();
    try {
      const plan = buildSecretPlan(
        { repo: "leeguooooo/AgentParty", environment: "release", mode: "api-key", dryRun: true },
        {
          AGENTPARTY_APPLE_CERTIFICATE_PATH: fixture.certificate,
          AGENTPARTY_APPLE_CERTIFICATE_PASSWORD: "cert-password",
          AGENTPARTY_APPLE_API_ISSUER: "12345678-1234-1234-1234-1234567890ab",
          AGENTPARTY_APPLE_API_KEY: "KEY1234567",
          AGENTPARTY_APPLE_API_KEY_PATH: fixture.apiKey,
        },
        "generated-keychain-password",
      );
      expect([...plan.secrets.keys()]).toEqual([
        "APPLE_CERTIFICATE",
        "APPLE_CERTIFICATE_PASSWORD",
        "KEYCHAIN_PASSWORD",
        "APPLE_API_ISSUER",
        "APPLE_API_KEY",
        "APPLE_API_KEY_P8_BASE64",
      ]);
      expect(plan.removeSecrets).toEqual(["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"]);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  test("rejects public credential files and non-p8 API keys", () => {
    const fixture = fixtures();
    try {
      chmodSync(fixture.certificate, 0o644);
      expect(() => buildSecretPlan(
        { repo: "o/r", environment: "release", mode: "api-key", dryRun: true },
        {
          AGENTPARTY_APPLE_CERTIFICATE_PATH: fixture.certificate,
          AGENTPARTY_APPLE_CERTIFICATE_PASSWORD: "password",
          AGENTPARTY_APPLE_API_ISSUER: "12345678-1234-1234-1234-1234567890ab",
          AGENTPARTY_APPLE_API_KEY: "KEY1234567",
          AGENTPARTY_APPLE_API_KEY_PATH: fixture.apiKey,
        },
      )).toThrow("must not be group- or world-readable");
      chmodSync(fixture.certificate, 0o600);
      writeFileSync(fixture.apiKey, "not a private key", { mode: 0o600 });
      expect(() => buildSecretPlan(
        { repo: "o/r", environment: "release", mode: "api-key", dryRun: true },
        {
          AGENTPARTY_APPLE_CERTIFICATE_PATH: fixture.certificate,
          AGENTPARTY_APPLE_CERTIFICATE_PASSWORD: "password",
          AGENTPARTY_APPLE_API_ISSUER: "12345678-1234-1234-1234-1234567890ab",
          AGENTPARTY_APPLE_API_KEY: "KEY1234567",
          AGENTPARTY_APPLE_API_KEY_PATH: fixture.apiKey,
        },
      )).toThrow("is not a p8 private key");
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  test("uploads secrets only over stdin and never places payloads in argv", () => {
    const secret = "private-value-that-must-not-enter-argv";
    const calls: Array<{ command: string; args: string[]; input?: string }> = [];
    publishSecretPlan({
      options: { repo: "o/r", environment: "release", mode: "apple-id", dryRun: false },
      secrets: new Map([["APPLE_PASSWORD", secret]]),
      removeSecrets: ["APPLE_API_KEY"],
    }, (request) => {
      calls.push(request);
      return { stdout: request.args[0] === "secret" && request.args[1] === "list" ? "APPLE_API_KEY\tdate\n" : "" };
    });
    expect(calls.some((call) => call.input === secret)).toBe(true);
    expect(calls.flatMap((call) => call.args)).not.toContain(secret);
    expect(calls.some((call) => call.args.includes("delete") && call.args.includes("APPLE_API_KEY"))).toBe(true);
  });

  test("accepts only a Developer ID Application certificate subject", () => {
    expect(() => assertDeveloperIdSubject("subject=CN=Developer ID Application: AgentParty Inc. (TEAM123456)")).not.toThrow();
    expect(() => assertDeveloperIdSubject("subject=CN=Apple Development: Person (TEAM123456)")).toThrow(
      "not a Developer ID Application",
    );
  });
});
