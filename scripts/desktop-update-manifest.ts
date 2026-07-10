import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const RFC_3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;
const usage = "Usage: bun scripts/desktop-update-manifest.ts --version <semver> --tag <tag> --repo <owner/repo> --dir <bundle-directory> --output <latest.json> --notes <notes> [--pub-date <RFC3339>]";

const updaterBundles = {
  "darwin-aarch64": "agentparty-desktop-darwin-arm64.app.tar.gz",
  "darwin-x86_64": "agentparty-desktop-darwin-x64.app.tar.gz",
} as const;

export interface DesktopUpdateManifestInput {
  version: string;
  tag: string;
  repo: string;
  dir: string;
  notes: string;
  pubDate?: string;
}

export interface DesktopUpdateManifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { url: string; signature: string }>;
}

export function validateDesktopUpdateVersion(version: string): string {
  if (!SEMVER.test(version)) throw new Error(`Invalid semantic version: ${version}`);
  return version;
}

export function validateRfc3339Date(pubDate: string): string {
  const match = RFC_3339.exec(pubDate);
  if (!match) throw new Error(`Invalid RFC 3339 publication date: ${pubDate}`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[7];
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const calendarDate = new Date(0);
  calendarDate.setUTCHours(0, 0, 0, 0);
  calendarDate.setUTCFullYear(year, month - 1, day);
  const isValidCalendarDate =
    calendarDate.getUTCFullYear() === year &&
    calendarDate.getUTCMonth() === month - 1 &&
    calendarDate.getUTCDate() === day;
  const isValidTime =
    hour <= 23 &&
    minute <= 59 &&
    second <= 60 &&
    offsetHour <= 23 &&
    offsetMinute <= 59;
  let isValidLeapSecond = true;
  if (second === 60 && isValidCalendarDate && isValidTime) {
    calendarDate.setUTCHours(hour, minute, 59, 0);
    const offsetSign = zone === "Z" || zone.startsWith("+") ? 1 : -1;
    const utc = new Date(calendarDate.getTime() - offsetSign * (offsetHour * 60 + offsetMinute) * 60_000);
    isValidLeapSecond =
      utc.getUTCHours() === 23 &&
      utc.getUTCMinutes() === 59 &&
      utc.getUTCSeconds() === 59 &&
      ((utc.getUTCMonth() === 5 && utc.getUTCDate() === 30) ||
        (utc.getUTCMonth() === 11 && utc.getUTCDate() === 31));
  }
  if (!isValidCalendarDate || !isValidTime || !isValidLeapSecond) {
    throw new Error(`Invalid RFC 3339 publication date: ${pubDate}`);
  }
  return pubDate;
}

function releaseUrl(repo: string, tag: string, bundleName: string): string {
  const repositoryParts = repo.split("/");
  if (repositoryParts.length !== 2 || repositoryParts.some((part) => part.length === 0)) {
    throw new Error(`Invalid repository slug: ${repo}`);
  }
  return `https://github.com/${repositoryParts.map(encodeURIComponent).join("/")}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(bundleName)}`;
}

function readSignature(dir: string, bundleName: string): string {
  const bundlePath = join(dir, bundleName);
  if (!existsSync(bundlePath)) throw new Error(`Missing updater bundle: ${bundleName}`);
  const bundleStat = statSync(bundlePath);
  if (!bundleStat.isFile()) throw new Error(`Invalid updater bundle: ${bundleName}`);
  if (bundleStat.size === 0) throw new Error(`Empty updater bundle: ${bundleName}`);

  const signatureName = `${bundleName}.sig`;
  const signaturePath = join(dir, signatureName);
  if (!existsSync(signaturePath)) throw new Error(`Missing updater signature: ${signatureName}`);
  if (!statSync(signaturePath).isFile()) throw new Error(`Invalid updater signature: ${signatureName}`);
  const signature = readFileSync(signaturePath, "utf8");
  if (signature.trim().length === 0) throw new Error(`Empty updater signature: ${signatureName}`);
  return signature;
}

export function buildDesktopUpdateManifest(
  input: DesktopUpdateManifestInput,
  now: () => Date = () => new Date(),
): DesktopUpdateManifest {
  validateDesktopUpdateVersion(input.version);
  if (input.tag.length === 0) throw new Error("Release tag is required");
  const pubDate = input.pubDate ?? now().toISOString();
  validateRfc3339Date(pubDate);

  const platforms: DesktopUpdateManifest["platforms"] = {};
  for (const [platform, bundleName] of Object.entries(updaterBundles)) {
    platforms[platform] = {
      url: releaseUrl(input.repo, input.tag, bundleName),
      signature: readSignature(input.dir, bundleName),
    };
  }

  return {
    version: input.version,
    notes: input.notes,
    pub_date: pubDate,
    platforms,
  };
}

function parseCliArguments(arguments_: string[]): DesktopUpdateManifestInput & { output: string } {
  const values = new Map<string, string>();
  const flags = new Map([
    ["--version", "version"],
    ["--tag", "tag"],
    ["--repo", "repo"],
    ["--dir", "dir"],
    ["--output", "output"],
    ["--notes", "notes"],
    ["--pub-date", "pubDate"],
  ]);

  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const key = flags.get(flag);
    const value = arguments_[index + 1];
    if (!key || value === undefined || values.has(key)) throw new Error(usage);
    values.set(key, value);
  }

  for (const requiredKey of ["version", "tag", "repo", "dir", "output", "notes"]) {
    if (!values.has(requiredKey)) throw new Error(usage);
  }
  return {
    version: values.get("version")!,
    tag: values.get("tag")!,
    repo: values.get("repo")!,
    dir: values.get("dir")!,
    output: values.get("output")!,
    notes: values.get("notes")!,
    pubDate: values.get("pubDate"),
  };
}

function writeManifestAtomically(output: string, manifest: DesktopUpdateManifest): void {
  mkdirSync(dirname(output), { recursive: true });
  const temporary = join(dirname(output), `.${basename(output)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(manifest, null, 2) + "\n");
    renameSync(temporary, output);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file was renamed or could not be created.
    }
  }
}

export function runDesktopUpdateManifestCli(
  arguments_: string[],
  now: () => Date = () => new Date(),
): DesktopUpdateManifest {
  const { output, ...input } = parseCliArguments(arguments_);
  const manifest = buildDesktopUpdateManifest(input, now);
  writeManifestAtomically(output, manifest);
  return manifest;
}

if (import.meta.main) {
  try {
    runDesktopUpdateManifestCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
