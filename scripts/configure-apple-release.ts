#!/usr/bin/env bun

import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { resolveAppleSigningMode } from "./apple-signing-mode";

export type ProvisionMode = "api-key" | "apple-id";

export interface ProvisionOptions {
  repo: string;
  environment: string;
  mode: ProvisionMode;
  dryRun: boolean;
}

export interface SecretPlan {
  options: ProvisionOptions;
  secrets: Map<string, string>;
  removeSecrets: string[];
}

type ProvisionEnvironment = Record<string, string | undefined>;

interface CommandRequest {
  command: string;
  args: string[];
  input?: string;
  env?: Record<string, string>;
}

type CommandRunner = (request: CommandRequest) => { stdout: string };

function requireValue(argv: readonly string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export function parseProvisionOptions(argv: readonly string[]): ProvisionOptions {
  const values = new Map<string, string>();
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--dry-run") {
      if (dryRun) throw new Error("--dry-run may only be provided once");
      dryRun = true;
      continue;
    }
    if (!["--repo", "--environment", "--mode"].includes(name)) throw new Error(`unknown argument: ${name}`);
    if (values.has(name)) throw new Error(`${name} may only be provided once`);
    values.set(name, requireValue(argv, index, name));
    index += 1;
  }
  const repo = values.get("--repo");
  const environment = values.get("--environment") ?? "release";
  const mode = values.get("--mode");
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("--repo must be owner/name");
  if (!/^[A-Za-z0-9_.-]+$/.test(environment)) throw new Error("--environment is invalid");
  if (mode !== "api-key" && mode !== "apple-id") throw new Error("--mode must be api-key or apple-id");
  return { repo, environment, mode, dryRun };
}

function required(environment: ProvisionEnvironment, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function privateFile(path: string, label: string, maximumBytes: number): Buffer {
  const metadata = statSync(path);
  if (!metadata.isFile() || metadata.size === 0 || metadata.size > maximumBytes) {
    throw new Error(`${label} file is missing, empty, or too large`);
  }
  if ((metadata.mode & 0o077) !== 0) throw new Error(`${label} file must not be group- or world-readable`);
  return readFileSync(path);
}

export function assertDeveloperIdSubject(subject: string): void {
  if (!/Developer ID Application: .+ \([A-Z0-9]{10}\)/.test(subject)) {
    throw new Error("certificate is not a Developer ID Application identity");
  }
}

export function buildSecretPlan(
  options: ProvisionOptions,
  environment: ProvisionEnvironment,
  keychainPassword = randomBytes(32).toString("base64url"),
): SecretPlan {
  const certificate = privateFile(
    required(environment, "AGENTPARTY_APPLE_CERTIFICATE_PATH"),
    "Developer ID certificate",
    1024 * 1024,
  );
  const certificatePassword = required(environment, "AGENTPARTY_APPLE_CERTIFICATE_PASSWORD");
  const secrets = new Map<string, string>([
    ["APPLE_CERTIFICATE", certificate.toString("base64")],
    ["APPLE_CERTIFICATE_PASSWORD", certificatePassword],
    ["KEYCHAIN_PASSWORD", keychainPassword],
  ]);
  const resolverEnvironment: ProvisionEnvironment = {
    DESKTOP_REQUIRE_NOTARIZATION: "true",
    APPLE_CERTIFICATE: "configured",
    APPLE_CERTIFICATE_PASSWORD: certificatePassword,
    KEYCHAIN_PASSWORD: keychainPassword,
  };
  let removeSecrets: string[];
  if (options.mode === "api-key") {
    const issuer = required(environment, "AGENTPARTY_APPLE_API_ISSUER");
    const key = required(environment, "AGENTPARTY_APPLE_API_KEY");
    const privateKey = privateFile(
      required(environment, "AGENTPARTY_APPLE_API_KEY_PATH"),
      "App Store Connect API key",
      32 * 1024,
    );
    const privateKeyText = privateKey.toString("utf8");
    if (!privateKeyText.includes("-----BEGIN PRIVATE KEY-----") || !privateKeyText.includes("-----END PRIVATE KEY-----")) {
      throw new Error("App Store Connect API key is not a p8 private key");
    }
    secrets.set("APPLE_API_ISSUER", issuer);
    secrets.set("APPLE_API_KEY", key);
    secrets.set("APPLE_API_KEY_P8_BASE64", privateKey.toString("base64"));
    Object.assign(resolverEnvironment, {
      APPLE_API_ISSUER: issuer,
      APPLE_API_KEY: key,
      APPLE_API_KEY_P8_BASE64: "configured",
    });
    removeSecrets = ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"];
  } else {
    const appleId = required(environment, "AGENTPARTY_APPLE_ID");
    const password = required(environment, "AGENTPARTY_APPLE_PASSWORD");
    const teamId = required(environment, "AGENTPARTY_APPLE_TEAM_ID");
    secrets.set("APPLE_ID", appleId);
    secrets.set("APPLE_PASSWORD", password);
    secrets.set("APPLE_TEAM_ID", teamId);
    Object.assign(resolverEnvironment, { APPLE_ID: appleId, APPLE_PASSWORD: password, APPLE_TEAM_ID: teamId });
    removeSecrets = ["APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_KEY_P8_BASE64"];
  }
  const resolution = resolveAppleSigningMode(resolverEnvironment);
  if (!resolution.enabled || resolution.authMode !== options.mode) throw new Error("Apple signing credential plan is incomplete");
  return { options, secrets, removeSecrets };
}

export function publishSecretPlan(plan: SecretPlan, runner: CommandRunner): void {
  const base = ["-R", plan.options.repo, "--env", plan.options.environment];
  const listed = runner({ command: "gh", args: ["secret", "list", ...base] }).stdout;
  const existing = new Set(listed.split("\n").map((line) => line.split(/\s+/)[0]).filter(Boolean));
  for (const [name, payload] of plan.secrets) {
    runner({ command: "gh", args: ["secret", "set", name, ...base], input: payload });
  }
  for (const name of plan.removeSecrets) {
    if (existing.has(name)) runner({ command: "gh", args: ["secret", "delete", name, ...base] });
  }
  runner({
    command: "gh",
    args: ["variable", "set", "DESKTOP_REQUIRE_NOTARIZATION", "-R", plan.options.repo, "--body", "true"],
  });
}

function nativeRunner(request: CommandRequest): { stdout: string } {
  const result = spawnSync(request.command, request.args, {
    encoding: "utf8",
    input: request.input,
    env: request.env === undefined ? process.env : { ...process.env, ...request.env },
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${request.command} ${request.args.slice(0, 2).join(" ")} failed`);
  return { stdout: result.stdout };
}

function validateCertificate(plan: SecretPlan, environment: ProvisionEnvironment): void {
  const certificatePath = required(environment, "AGENTPARTY_APPLE_CERTIFICATE_PATH");
  const password = required(environment, "AGENTPARTY_APPLE_CERTIFICATE_PASSWORD");
  const pem = nativeRunner({
    command: "openssl",
    args: ["pkcs12", "-in", certificatePath, "-clcerts", "-nokeys", "-passin", "env:AP_CERT_PASSWORD"],
    env: { AP_CERT_PASSWORD: password },
  }).stdout;
  const subject = nativeRunner({
    command: "openssl",
    args: ["x509", "-noout", "-subject"],
    input: pem,
  }).stdout;
  assertDeveloperIdSubject(subject);
  if (plan.secrets.size !== 6) throw new Error("Apple signing credential plan must contain exactly six secrets");
}

function main(argv: readonly string[], environment: ProvisionEnvironment): void {
  const options = parseProvisionOptions(argv);
  const plan = buildSecretPlan(options, environment);
  validateCertificate(plan, environment);
  if (options.dryRun) {
    console.log(`validated ${options.mode} Apple release credentials for ${options.repo}/${options.environment}`);
    console.log(`would configure: ${[...plan.secrets.keys()].join(", ")}`);
    return;
  }
  publishSecretPlan(plan, nativeRunner);
  console.log(`configured ${options.mode} Apple release credentials for ${options.repo}/${options.environment}`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(`configure-apple-release: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
