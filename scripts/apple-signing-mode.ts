#!/usr/bin/env bun

import { appendFileSync } from "node:fs";

const CERTIFICATE_FIELDS = ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "KEYCHAIN_PASSWORD"] as const;
const APPLE_ID_FIELDS = ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"] as const;
const API_KEY_FIELDS = ["APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_KEY_P8_BASE64"] as const;

export type AppleNotarizationAuthMode = "none" | "apple-id" | "api-key";

export interface AppleSigningResolution {
  enabled: boolean;
  authMode: AppleNotarizationAuthMode;
  missingCertificateFields: string[];
}

type SigningEnvironment = Record<string, string | undefined>;

function complete(environment: SigningEnvironment, fields: readonly string[]): boolean {
  return fields.every((field) => (environment[field] ?? "").length > 0);
}

export function resolveAppleSigningMode(environment: SigningEnvironment): AppleSigningResolution {
  const requireNotarization = environment.DESKTOP_REQUIRE_NOTARIZATION ?? "false";
  if (requireNotarization !== "true" && requireNotarization !== "false") {
    throw new Error("DESKTOP_REQUIRE_NOTARIZATION must be true or false");
  }
  const missingCertificateFields = CERTIFICATE_FIELDS.filter((field) => !environment[field]);
  const apiKeyComplete = complete(environment, API_KEY_FIELDS);
  const appleIdComplete = complete(environment, APPLE_ID_FIELDS);
  if (apiKeyComplete) {
    if (!/^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/.test(environment.APPLE_API_ISSUER ?? "")) {
      throw new Error("APPLE_API_ISSUER must be a UUID");
    }
    if (!/^[A-Z0-9]{10}$/.test(environment.APPLE_API_KEY ?? "")) {
      throw new Error("APPLE_API_KEY must be a 10-character key ID");
    }
  }
  if (appleIdComplete && !/^[A-Z0-9]{10}$/.test(environment.APPLE_TEAM_ID ?? "")) {
    throw new Error("APPLE_TEAM_ID must be a 10-character team ID");
  }
  const authMode: AppleNotarizationAuthMode = apiKeyComplete
    ? "api-key"
    : appleIdComplete
      ? "apple-id"
      : "none";
  const enabled = missingCertificateFields.length === 0 && authMode !== "none";
  if (!enabled && requireNotarization === "true") {
    const certificate = missingCertificateFields.length === 0 ? "none" : missingCertificateFields.join(", ");
    throw new Error(
      `Apple signing is required; missing: certificate fields ${certificate}; `
      + "notarization requires either a complete Apple ID or App Store Connect API-key credential set",
    );
  }
  return { enabled, authMode: enabled ? authMode : "none", missingCertificateFields };
}

export function writeAppleSigningOutputs(
  outputPath: string,
  resolution: AppleSigningResolution,
): void {
  appendFileSync(
    outputPath,
    `enabled=${resolution.enabled}\nauth_mode=${resolution.authMode}\n`,
    { encoding: "utf8" },
  );
}

function main(environment: SigningEnvironment): void {
  const outputPath = environment.GITHUB_OUTPUT;
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required");
  const resolution = resolveAppleSigningMode(environment);
  writeAppleSigningOutputs(outputPath, resolution);
  if (!resolution.enabled) {
    console.warn("::warning::Apple signing or notarization authentication is unavailable; publishing an unnotarized desktop preview");
  }
}

if (import.meta.main) {
  try {
    main(process.env);
  } catch (error) {
    console.error(`resolve-apple-signing: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
