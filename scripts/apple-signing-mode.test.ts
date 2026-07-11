import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveAppleSigningMode, writeAppleSigningOutputs } from "./apple-signing-mode";

const certificate = {
  APPLE_CERTIFICATE: "certificate",
  APPLE_CERTIFICATE_PASSWORD: "certificate-password",
  KEYCHAIN_PASSWORD: "keychain-password",
};
const appleId = {
  APPLE_ID: "release@example.com",
  APPLE_PASSWORD: "app-password",
  APPLE_TEAM_ID: "TEAM123456",
};
const apiKey = {
  APPLE_API_ISSUER: "12345678-1234-1234-1234-1234567890ab",
  APPLE_API_KEY: "KEY1234567",
  APPLE_API_KEY_P8_BASE64: "cHJpdmF0ZS1rZXk=",
};

describe("Apple desktop signing mode", () => {
  test("accepts either complete notarization credential set", () => {
    expect(resolveAppleSigningMode({ ...certificate, ...appleId })).toEqual({
      enabled: true,
      authMode: "apple-id",
      missingCertificateFields: [],
    });
    expect(resolveAppleSigningMode({ ...certificate, ...apiKey })).toEqual({
      enabled: true,
      authMode: "api-key",
      missingCertificateFields: [],
    });
  });

  test("prefers the non-interactive API key when both modes are complete", () => {
    expect(resolveAppleSigningMode({ ...certificate, ...appleId, ...apiKey }).authMode).toBe("api-key");
  });

  test("falls back to an honest preview for missing or partial credentials", () => {
    expect(resolveAppleSigningMode({})).toEqual({
      enabled: false,
      authMode: "none",
      missingCertificateFields: ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "KEYCHAIN_PASSWORD"],
    });
    expect(resolveAppleSigningMode({ ...certificate, APPLE_ID: "partial" })).toEqual({
      enabled: false,
      authMode: "none",
      missingCertificateFields: [],
    });
  });

  test("fails closed when production notarization is required", () => {
    expect(() => resolveAppleSigningMode({ DESKTOP_REQUIRE_NOTARIZATION: "true", ...certificate })).toThrow(
      "notarization requires either a complete Apple ID or App Store Connect API-key credential set",
    );
    expect(() => resolveAppleSigningMode({ DESKTOP_REQUIRE_NOTARIZATION: "invalid" })).toThrow(
      "DESKTOP_REQUIRE_NOTARIZATION must be true or false",
    );
  });

  test("rejects complete but malformed Apple identifiers", () => {
    expect(() => resolveAppleSigningMode({ ...certificate, ...apiKey, APPLE_API_ISSUER: "not-a-uuid" })).toThrow(
      "APPLE_API_ISSUER must be a UUID",
    );
    expect(() => resolveAppleSigningMode({ ...certificate, ...apiKey, APPLE_API_KEY: "../bad" })).toThrow(
      "APPLE_API_KEY must be a 10-character key ID",
    );
    expect(() => resolveAppleSigningMode({ ...certificate, ...appleId, APPLE_TEAM_ID: "short" })).toThrow(
      "APPLE_TEAM_ID must be a 10-character team ID",
    );
  });

  test("writes only non-secret mode outputs for following workflow steps", () => {
    const directory = mkdtempSync(join(tmpdir(), "apple-signing-mode-"));
    try {
      const output = join(directory, "github-output");
      writeAppleSigningOutputs(output, {
        enabled: true,
        authMode: "api-key",
        missingCertificateFields: [],
      });
      expect(readFileSync(output, "utf8")).toBe("enabled=true\nauth_mode=api-key\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
