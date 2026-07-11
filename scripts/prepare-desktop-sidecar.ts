#!/usr/bin/env bun

import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const BUN_TARGETS = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
} as const;

export interface CliOptions {
  target?: string;
}

export function bunTargetForRustTriple(triple: string): string {
  const target = BUN_TARGETS[triple as keyof typeof BUN_TARGETS];
  if (target === undefined) throw new Error(`unsupported Rust host triple: ${triple}`);
  return target;
}

export function parseRustHostTriple(output: string): string {
  const match = output.match(/^host:\s*(\S+)\s*$/m);
  if (match === null) throw new Error("rustc -vV did not report a host triple");
  return match[1];
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  let target: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--target") throw new Error(`unknown argument: ${argument}`);
    const value = argv[++index];
    if (!value) throw new Error("--target requires a Rust host triple");
    if (target !== undefined) throw new Error("--target may only be provided once");
    target = value;
  }
  return { target };
}

export function sidecarOutputPath(repoRoot: string, triple: string): string {
  const extension = triple.includes("windows") ? ".exe" : "";
  return resolve(repoRoot, `desktop/src-tauri/binaries/party-${triple}${extension}`);
}

export function validateArtifactSize(path: string, size: number): void {
  if (size <= 0) throw new Error(`desktop sidecar is empty: ${path}`);
}

function detectRustHostTriple(): string {
  const result = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`rustc -vV failed with exit code ${result.status ?? "unknown"}`);
  }
  return parseRustHostTriple(result.stdout);
}

function main(argv: readonly string[]): void {
  const options = parseCliArgs(argv);
  const repoRoot = resolve(import.meta.dir, "..");
  const rustTriple = options.target ?? detectRustHostTriple();
  const bunTarget = bunTargetForRustTriple(rustTriple);
  const output = sidecarOutputPath(repoRoot, rustTriple);
  const entrypoint = resolve(repoRoot, "cli/src/index.ts");

  mkdirSync(dirname(output), { recursive: true });
  rmSync(output, { force: true });
  const result = spawnSync(
    "bun",
    ["build", "--compile", `--target=${bunTarget}`, entrypoint, "--outfile", output],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Bun sidecar compilation failed with exit code ${result.status ?? "unknown"}`);
  }

  validateArtifactSize(output, statSync(output).size);
  chmodSync(output, 0o755);
  console.log(`desktop sidecar ready: ${output} (${bunTarget})`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`prepare-desktop-sidecar: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
