import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Prunes old versioned Desktop UI assets from the fixed `desktop-ui` GitHub Release so the
 * channel never reaches GitHub's hard limit of 1000 assets per release (issue #974).
 *
 * Only `agentparty-desktop-ui-v<semver>.(json|tar.gz|tar.gz.sha256|tar.gz.sig)` are ever
 * candidates. `desktop-ui.json` (the current manifest) and any asset whose name does not
 * match that pattern are never deleted.
 */

export const RELEASE_TAG = "desktop-ui";
export const CURRENT_MANIFEST = "desktop-ui.json";
export const DEFAULT_KEEP = 60;
export const GITHUB_RELEASE_ASSET_LIMIT = 1000;

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const VERSIONED_ASSET = /^agentparty-desktop-ui-v(.+?)\.(json|tar\.gz|tar\.gz\.sha256|tar\.gz\.sig)$/;
const SAFE_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const usage = "Usage: bun scripts/desktop-ui-prune-assets.ts (--repo <owner/repo> | --assets <assets.json|->) [--keep <n>] [--incoming <semver>] [--dry-run]";

export interface ReleaseAsset {
  id: number;
  name: string;
}

export interface DesktopUiPruneInput {
  assets: ReleaseAsset[];
  /** Number of versions to keep, counting `incoming`. Defaults to {@link DEFAULT_KEEP}. */
  keep?: number;
  /** Version about to be uploaded; reserves a slot even when it is not on the release yet. */
  incoming?: string | null;
}

export interface DesktopUiPrunePlan {
  keep: number;
  /** Versions retained on the release, newest first (includes `incoming` when given). */
  retainedVersions: string[];
  /** Versions whose assets are deleted, newest first. */
  prunedVersions: string[];
  /** Assets to delete, ordered by pruned version (newest first) then by name. */
  deletions: ReleaseAsset[];
  /** Assets left untouched because they are not a versioned Desktop UI asset. */
  protectedAssets: ReleaseAsset[];
}

interface ParsedVersion {
  release: [number, number, number];
  prerelease: (string | number)[] | null;
}

function parseVersion(version: string): ParsedVersion | null {
  const match = SEMVER.exec(version);
  if (!match) return null;
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined
      ? null
      : match[4].split(".").map((part) => (/^(0|[1-9]\d*)$/.test(part) ? Number(part) : part)),
  };
}

function comparePrereleaseIdentifier(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "number") return -1;
  if (typeof right === "number") return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Semantic version ordering (numeric components, prerelease < release). Never lexicographic. */
export function compareSemver(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a) throw new Error(`Invalid semantic version: ${left}`);
  if (!b) throw new Error(`Invalid semantic version: ${right}`);
  for (let index = 0; index < 3; index += 1) {
    if (a.release[index] !== b.release[index]) return a.release[index] - b.release[index];
  }
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  const length = Math.min(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const order = comparePrereleaseIdentifier(a.prerelease[index], b.prerelease[index]);
    if (order !== 0) return order;
  }
  return a.prerelease.length - b.prerelease.length;
}

/** Returns the semver of a versioned Desktop UI asset name, or null for anything else. */
export function versionedAssetVersion(name: string): string | null {
  if (name === CURRENT_MANIFEST) return null;
  const match = VERSIONED_ASSET.exec(name);
  if (!match || !SEMVER.test(match[1])) return null;
  return match[1];
}

export function planDesktopUiAssetPrune(input: DesktopUiPruneInput): DesktopUiPrunePlan {
  const keep = input.keep ?? DEFAULT_KEEP;
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`Invalid keep count: ${String(keep)}`);
  if (input.incoming != null && !SEMVER.test(input.incoming)) {
    throw new Error(`Invalid semantic version: ${input.incoming}`);
  }
  const byVersion = new Map<string, ReleaseAsset[]>();
  const protectedAssets: ReleaseAsset[] = [];
  for (const asset of input.assets) {
    if (!Number.isInteger(asset.id) || typeof asset.name !== "string") {
      throw new Error(`Invalid release asset: ${JSON.stringify(asset)}`);
    }
    const version = versionedAssetVersion(asset.name);
    if (version === null) {
      protectedAssets.push(asset);
      continue;
    }
    const group = byVersion.get(version) ?? [];
    group.push(asset);
    byVersion.set(version, group);
  }
  if (input.incoming != null && !byVersion.has(input.incoming)) byVersion.set(input.incoming, []);
  const versions = [...byVersion.keys()].sort((left, right) => compareSemver(right, left));
  const retainedVersions = versions.slice(0, keep);
  const prunedVersions = versions.slice(keep);
  const deletions = prunedVersions.flatMap((version) =>
    [...(byVersion.get(version) ?? [])].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
  );
  return { keep, retainedVersions, prunedVersions, deletions, protectedAssets };
}

function gh(arguments_: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("gh", arguments_, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
}

export function parseReleaseAssets(text: string): ReleaseAsset[] {
  const parsed: unknown = JSON.parse(text);
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>).assets)
      ? (parsed as { assets: unknown[] }).assets
      : null;
  if (list === null) throw new Error("Expected a JSON array of assets or a release object with an assets array");
  return list.map((entry) => {
    const record = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    if (!Number.isInteger(record.id) || typeof record.name !== "string") {
      throw new Error(`Invalid release asset: ${JSON.stringify(entry)}`);
    }
    return { id: record.id as number, name: record.name };
  });
}

/** Lists every asset on the fixed release; an absent release counts as zero assets. */
function fetchReleaseAssets(repo: string): ReleaseAsset[] {
  const release = gh(["api", `/repos/${repo}/releases/tags/${RELEASE_TAG}`, "--jq", ".id"]);
  if (!release.ok) {
    if (/HTTP 404/.test(release.stderr)) return [];
    throw new Error(`Failed to resolve release ${RELEASE_TAG} on ${repo}: ${release.stderr.trim()}`);
  }
  const releaseId = release.stdout.trim();
  if (!/^\d+$/.test(releaseId)) throw new Error(`Unexpected release id for ${RELEASE_TAG}: ${releaseId}`);
  const assets = gh([
    "api",
    "--paginate",
    `/repos/${repo}/releases/${releaseId}/assets?per_page=100`,
    "--jq",
    ".[] | {id, name}",
  ]);
  if (!assets.ok) throw new Error(`Failed to list release assets: ${assets.stderr.trim()}`);
  const lines = assets.stdout.split("\n").filter((line) => line.trim().length > 0);
  return parseReleaseAssets(`[${lines.join(",")}]`);
}

function deleteAsset(repo: string, asset: ReleaseAsset): void {
  const result = gh(["api", "-X", "DELETE", `/repos/${repo}/releases/assets/${asset.id}`]);
  if (!result.ok) throw new Error(`Failed to delete asset ${asset.name} (#${asset.id}): ${result.stderr.trim()}`);
}

interface CliOptions {
  repo: string | null;
  assetsPath: string | null;
  keep: number;
  incoming: string | null;
  dryRun: boolean;
}

export function parsePruneArguments(arguments_: string[]): CliOptions {
  const options: CliOptions = { repo: null, assetsPath: null, keep: DEFAULT_KEEP, incoming: null, dryRun: false };
  const seen = new Set<string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    if (seen.has(flag)) throw new Error(usage);
    seen.add(flag);
    if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) throw new Error(usage);
    index += 1;
    switch (flag) {
      case "--repo":
        if (!SAFE_REPOSITORY.test(value)) throw new Error(`Invalid repository: ${value}`);
        options.repo = value;
        break;
      case "--assets":
        options.assetsPath = value;
        break;
      case "--keep":
        if (!/^[1-9]\d*$/.test(value)) throw new Error(`Invalid keep count: ${value}`);
        options.keep = Number(value);
        break;
      case "--incoming":
        if (!SEMVER.test(value)) throw new Error(`Invalid semantic version: ${value}`);
        options.incoming = value;
        break;
      default:
        throw new Error(usage);
    }
  }
  if (options.repo === null && options.assetsPath === null) throw new Error(usage);
  if (options.repo === null && !options.dryRun) {
    throw new Error("--repo is required to delete assets; pass --dry-run to only print the plan");
  }
  return options;
}

export function runDesktopUiPruneCli(
  arguments_: string[],
  log: (line: string) => void = console.log,
): DesktopUiPrunePlan {
  const options = parsePruneArguments(arguments_);
  const assets = options.assetsPath !== null
    ? parseReleaseAssets(readFileSync(options.assetsPath === "-" ? 0 : options.assetsPath, "utf8"))
    : fetchReleaseAssets(options.repo as string);
  const plan = planDesktopUiAssetPrune({ assets, keep: options.keep, incoming: options.incoming });
  const versionCount = plan.retainedVersions.length + plan.prunedVersions.length;
  const incomingNote = options.incoming ? ` including incoming v${options.incoming}` : "";
  log(`${RELEASE_TAG} release has ${assets.length} assets across ${versionCount} versions (GitHub limit ${GITHUB_RELEASE_ASSET_LIMIT}); keeping ${plan.keep} versions${incomingNote}`);
  if (plan.deletions.length === 0) {
    log("nothing to prune");
  } else {
    const oldest = plan.prunedVersions[plan.prunedVersions.length - 1];
    const newest = plan.prunedVersions[0];
    log(`pruning ${plan.prunedVersions.length} versions (${plan.deletions.length} assets), v${oldest} .. v${newest}:`);
    for (const asset of plan.deletions) log(`  ${options.dryRun ? "would delete" : "delete"} ${asset.name} (#${asset.id})`);
  }
  if (!options.dryRun) {
    for (const asset of plan.deletions) deleteAsset(options.repo as string, asset);
  }
  const remaining = assets.length - (options.dryRun ? 0 : plan.deletions.length);
  const protectedNames = plan.protectedAssets.map((asset) => asset.name).join(", ") || "none";
  log(`${options.dryRun ? "would retain" : "retained"} ${plan.retainedVersions.length} versions; protected assets: ${protectedNames}; ${remaining} assets remain on the release`);
  return plan;
}

if (import.meta.main) {
  try {
    runDesktopUiPruneCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
