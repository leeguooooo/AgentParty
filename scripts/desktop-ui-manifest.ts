import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { validateDesktopUpdateVersion, validateRfc3339Date } from "./desktop-update-manifest";

const RELEASE_TAG = "desktop-ui";
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA_256 = /^[a-f0-9]{64}$/;
const usage = "Usage: bun scripts/desktop-ui-manifest.ts --version <semver> --ui-abi <1..65535> --min-shell-version <semver> --build-id <id> --published-at <RFC3339> --repo <owner/repo> --archive <archive.tar.gz> --output <payload.json> | --payload <payload.json> --signature <payload.json.sig> --output <manifest.json>";

export interface DesktopUiManifestInput {
  version: string;
  uiAbi: number;
  minShellVersion: string;
  buildId: string;
  publishedAt: string;
  repo: string;
  archive: string;
}

export interface DesktopUiManifest {
  schema: number;
  version: string;
  ui_abi: number;
  min_shell_version: string;
  build_id: string;
  published_at: string;
  archive: {
    name: string;
    url: string;
    sizeBytes: number;
    fileCount: number;
    sha256: string;
    signature: string;
  };
  entrypoint: string;
}

export interface SignedDesktopUiManifest {
  payload: string;
  signature: string;
}

function validateIdentifier(label: string, value: string): string {
  if (!SAFE_IDENTIFIER.test(value)) throw new Error(`Invalid Desktop UI ${label}: ${value}`);
  return value;
}

function validateRepository(repo: string): string {
  const parts = repo.split("/");
  if (parts.length !== 2 || parts.some((part) => !SAFE_IDENTIFIER.test(part))) {
    throw new Error(`Invalid Desktop UI repository: ${repo}`);
  }
  return repo;
}

function readArtifact(path: string, label: string): Buffer {
  if (!existsSync(path)) throw new Error(`Missing Desktop UI ${label}: ${path}`);
  const metadata = statSync(path);
  if (!metadata.isFile() || metadata.size === 0) throw new Error(`Invalid Desktop UI ${label}: ${path}`);
  return readFileSync(path);
}

function inspectArchive(archive: Buffer): { fileCount: number; hasEntrypoint: boolean } {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive);
  } catch {
    throw new Error("Invalid Desktop UI gzip archive");
  }
  let offset = 0;
  let fileCount = 0;
  let hasEntrypoint = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid Desktop UI tar entry size");
    const type = header[156];
    if (type === 0 || type === 0x30) {
      fileCount += 1;
      if (fullName === "index.html") hasEntrypoint = true;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (fileCount === 0) throw new Error("Desktop UI archive contains no files");
  return { fileCount, hasEntrypoint };
}

export function buildDesktopUiManifest(input: DesktopUiManifestInput): DesktopUiManifest {
  try {
    validateDesktopUpdateVersion(input.version);
  } catch {
    throw new Error(`Invalid Desktop UI version: ${input.version}`);
  }
  try {
    validateDesktopUpdateVersion(input.minShellVersion);
  } catch {
    throw new Error(`Invalid Desktop UI minimum shell version: ${input.minShellVersion}`);
  }
  try {
    validateRfc3339Date(input.publishedAt);
  } catch {
    throw new Error(`Invalid Desktop UI publication date: ${input.publishedAt}`);
  }
  if (!Number.isInteger(input.uiAbi) || input.uiAbi < 1 || input.uiAbi > 65535) {
    throw new Error(`Invalid Desktop UI ABI: ${input.uiAbi}`);
  }
  validateIdentifier("build ID", input.buildId);
  const repo = validateRepository(input.repo);

  const archivePath = resolve(input.archive);
  const archiveName = basename(archivePath);
  const expectedName = `agentparty-desktop-ui-v${input.version}.tar.gz`;
  if (archiveName !== expectedName) {
    throw new Error(`Desktop UI archive must use the versioned name: ${expectedName}`);
  }
  const archive = readArtifact(archivePath, "archive");
  const archiveContents = inspectArchive(archive);
  if (!archiveContents.hasEntrypoint) throw new Error("Desktop UI archive is missing index.html");
  const checksumLine = readArtifact(`${archivePath}.sha256`, "checksum").toString("utf8").trim();
  const checksumParts = checksumLine.split(/\s+/);
  const checksumMatch = SHA_256.exec(checksumParts[0] ?? "");
  const actualSha256 = createHash("sha256").update(archive).digest("hex");
  if (!checksumMatch || checksumMatch[0] !== actualSha256) {
    throw new Error("Desktop UI checksum does not match archive");
  }
  if (checksumParts[1] !== archiveName) throw new Error("Desktop UI checksum does not name archive");
  const signature = readArtifact(`${archivePath}.sig`, "signature").toString("utf8");

  return {
    schema: 1,
    version: input.version,
    ui_abi: input.uiAbi,
    min_shell_version: input.minShellVersion,
    build_id: input.buildId,
    published_at: input.publishedAt,
    archive: {
      name: archiveName,
      url: `https://github.com/${repo.split("/").map(encodeURIComponent).join("/")}/releases/download/${RELEASE_TAG}/${encodeURIComponent(archiveName)}`,
      sizeBytes: archive.length,
      fileCount: archiveContents.fileCount,
      sha256: actualSha256,
      signature,
    },
    entrypoint: "index.html",
  };
}

export function buildSignedDesktopUiManifest(
  payload: Buffer,
  signature: string,
): SignedDesktopUiManifest {
  if (payload.length === 0) throw new Error("Empty Desktop UI manifest payload");
  if (signature.trim().length === 0) throw new Error("Empty Desktop UI manifest signature");
  return { payload: payload.toString("base64"), signature };
}

function parseBuildArguments(arguments_: string[]): DesktopUiManifestInput & { output: string } {
  const flags = new Map([
    ["--version", "version"],
    ["--ui-abi", "uiAbi"],
    ["--min-shell-version", "minShellVersion"],
    ["--build-id", "buildId"],
    ["--published-at", "publishedAt"],
    ["--repo", "repo"],
    ["--archive", "archive"],
    ["--output", "output"],
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = flags.get(arguments_[index]);
    const value = arguments_[index + 1];
    if (!key || !value || values.has(key)) throw new Error(usage);
    values.set(key, value);
  }
  if (values.size !== flags.size) throw new Error(usage);
  const parsed = Object.fromEntries(values) as unknown as Omit<DesktopUiManifestInput, "uiAbi"> & {
    uiAbi: string;
    output: string;
  };
  if (!/^(0|[1-9]\d*)$/.test(parsed.uiAbi)) {
    throw new Error(`Invalid Desktop UI ABI: ${parsed.uiAbi}`);
  }
  return { ...parsed, uiAbi: Number(parsed.uiAbi) };
}

function writeManifest(output: string, contents: string): void {
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, contents);
    renameSync(temporary, output);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function runDesktopUiManifestCli(arguments_: string[]): DesktopUiManifest | SignedDesktopUiManifest {
  if (arguments_.includes("--payload") || arguments_.includes("--signature")) {
    if (arguments_.length !== 6) throw new Error(usage);
    const values = new Map<string, string>();
    for (let index = 0; index < arguments_.length; index += 2) {
      const flag = arguments_[index];
      const value = arguments_[index + 1];
      if (!["--payload", "--signature", "--output"].includes(flag) || !value || values.has(flag)) {
        throw new Error(usage);
      }
      values.set(flag, value);
    }
    const payloadPath = values.get("--payload");
    const signaturePath = values.get("--signature");
    const output = values.get("--output");
    if (!payloadPath || !signaturePath || !output) throw new Error(usage);
    const payload = readArtifact(payloadPath, "manifest payload");
    const signature = readArtifact(signaturePath, "manifest signature").toString("utf8");
    const signed = buildSignedDesktopUiManifest(payload, signature);
    writeManifest(output, `${JSON.stringify(signed, null, 2)}\n`);
    return signed;
  }

  const { output, ...input } = parseBuildArguments(arguments_);
  const manifest = buildDesktopUiManifest(input);
  writeManifest(output, JSON.stringify(manifest));
  return manifest;
}

if (import.meta.main) {
  try {
    runDesktopUiManifestCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
