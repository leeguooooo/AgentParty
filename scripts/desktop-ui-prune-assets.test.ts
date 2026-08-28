import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_MANIFEST,
  DEFAULT_KEEP,
  GITHUB_RELEASE_ASSET_LIMIT,
  compareSemver,
  parsePruneArguments,
  planDesktopUiAssetPrune,
  runDesktopUiPruneCli,
  versionedAssetVersion,
  type ReleaseAsset,
} from "./desktop-ui-prune-assets";

const SUFFIXES = ["json", "tar.gz", "tar.gz.sha256", "tar.gz.sig"] as const;

function versionAssets(version: string, firstId: number): ReleaseAsset[] {
  return SUFFIXES.map((suffix, index) => ({
    id: firstId + index,
    name: `agentparty-desktop-ui-v${version}.${suffix}`,
  }));
}

/** 250 published versions × 4 files = exactly the GitHub per-release asset ceiling. */
function fullRelease(): { assets: ReleaseAsset[]; versions: string[] } {
  const versions = Array.from({ length: 250 }, (_, index) => `0.0.${index + 1}`);
  const assets = versions.flatMap((version, index) => versionAssets(version, 1000 + index * 4));
  // GitHub returns assets sorted by name, which is lexicographic (v0.0.10 before v0.0.2).
  assets.sort((left, right) => (left.name < right.name ? -1 : 1));
  expect(assets).toHaveLength(GITHUB_RELEASE_ASSET_LIMIT);
  return { assets, versions };
}

function versionsOf(assets: ReleaseAsset[]): Set<string> {
  return new Set(assets.map((asset) => versionedAssetVersion(asset.name)).filter((v): v is string => v !== null));
}

describe("desktop UI release asset pruning", () => {
  test("keeps KEEP=60 versions by default", () => {
    expect(DEFAULT_KEEP).toBe(60);
  });

  test("a full 1000-asset release keeps the 60 newest versions and deletes the 190 oldest", () => {
    const { assets, versions } = fullRelease();
    const plan = planDesktopUiAssetPrune({ assets: [...assets, { id: 1, name: CURRENT_MANIFEST }] });

    expect(plan.keep).toBe(60);
    expect(plan.retainedVersions).toEqual(versions.slice(-60).reverse());
    expect(plan.retainedVersions[0]).toBe("0.0.250");
    expect(plan.retainedVersions[59]).toBe("0.0.191");
    expect(plan.prunedVersions).toHaveLength(190);
    expect(plan.deletions).toHaveLength(760);
    expect(versionsOf(plan.deletions)).toEqual(new Set(versions.slice(0, 190)));
    for (const version of plan.retainedVersions) {
      expect(plan.deletions.some((asset) => asset.name.startsWith(`agentparty-desktop-ui-v${version}.`))).toBe(false);
    }
    expect(plan.deletions.map((asset) => asset.name)).not.toContain(CURRENT_MANIFEST);
    expect(plan.protectedAssets).toEqual([{ id: 1, name: CURRENT_MANIFEST }]);
    // Every retained version keeps its whole four-file set; the release ends at 240 + manifest.
    const remaining = assets.length + 1 - plan.deletions.length;
    expect(remaining).toBe(60 * 4 + 1);
  });

  test("orders versions by semver, not lexicographically", () => {
    expect(compareSemver("0.0.9", "0.0.10")).toBeLessThan(0);
    expect(compareSemver("0.0.10", "0.0.9")).toBeGreaterThan(0);
    expect(compareSemver("0.0.100", "0.0.99")).toBeGreaterThan(0);
    expect(compareSemver("0.1.0", "0.0.999")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0-rc.2", "1.0.0-rc.10")).toBeLessThan(0);
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
    expect(compareSemver("0.0.5", "0.0.5")).toBe(0);
    expect(() => compareSemver("v1", "1.0.0")).toThrow("Invalid semantic version");

    const assets = ["0.0.9", "0.0.10", "0.0.100", "0.0.2", "0.0.11"].flatMap((v, i) => versionAssets(v, i * 4));
    const plan = planDesktopUiAssetPrune({ assets, keep: 2 });
    expect(plan.retainedVersions).toEqual(["0.0.100", "0.0.11"]);
    expect(plan.prunedVersions).toEqual(["0.0.10", "0.0.9", "0.0.2"]);
    // A lexicographic sort would have kept v0.0.9 and pruned v0.0.100 / v0.0.11.
    expect(plan.deletions.map((asset) => asset.name)).toContain("agentparty-desktop-ui-v0.0.9.tar.gz");
    expect(plan.deletions.map((asset) => asset.name)).not.toContain("agentparty-desktop-ui-v0.0.100.tar.gz");
  });

  test("never deletes desktop-ui.json or assets outside the versioned naming scheme", () => {
    const foreign: ReleaseAsset[] = [
      { id: 1, name: CURRENT_MANIFEST },
      { id: 2, name: "desktop-ui.json.sig" },
      { id: 3, name: "agentparty-desktop-ui-latest.tar.gz" },
      { id: 4, name: "agentparty-desktop-ui-v0.0.1.zip" },
      { id: 5, name: "agentparty-desktop-ui-v01.0.0.tar.gz" },
      { id: 6, name: "agentparty-desktop-ui-vabc.tar.gz" },
      { id: 7, name: "AgentParty-0.2.100-aarch64.dmg" },
      { id: 8, name: "notes-agentparty-desktop-ui-v0.0.1.tar.gz" },
      { id: 9, name: "agentparty-desktop-ui-v0.0.1.tar.gz.bak" },
    ];
    for (const asset of foreign) expect(versionedAssetVersion(asset.name)).toBeNull();
    expect(versionedAssetVersion("agentparty-desktop-ui-v0.0.1.tar.gz.sha256")).toBe("0.0.1");
    expect(versionedAssetVersion("agentparty-desktop-ui-v1.2.3-rc.1.json")).toBe("1.2.3-rc.1");

    const versioned = ["0.0.1", "0.0.2", "0.0.3"].flatMap((v, i) => versionAssets(v, 100 + i * 4));
    const plan = planDesktopUiAssetPrune({ assets: [...foreign, ...versioned], keep: 1 });
    expect(plan.retainedVersions).toEqual(["0.0.3"]);
    expect(plan.deletions).toHaveLength(8);
    expect(plan.deletions.map((asset) => asset.id).every((id) => id >= 100)).toBe(true);
    expect(plan.protectedAssets).toEqual(foreign);
  });

  test("reserves a slot for an incoming version that is not on the release yet", () => {
    const assets = ["0.0.1", "0.0.2", "0.0.3", "0.0.4"].flatMap((v, i) => versionAssets(v, i * 4));
    const plan = planDesktopUiAssetPrune({ assets, keep: 3, incoming: "0.0.5" });
    expect(plan.retainedVersions).toEqual(["0.0.5", "0.0.4", "0.0.3"]);
    expect(plan.prunedVersions).toEqual(["0.0.2", "0.0.1"]);
    expect(plan.deletions).toHaveLength(8);
  });

  test("counts an incoming version that already exists on the release only once", () => {
    const assets = ["0.0.1", "0.0.2", "0.0.3", "0.0.4"].flatMap((v, i) => versionAssets(v, i * 4));
    const plan = planDesktopUiAssetPrune({ assets, keep: 3, incoming: "0.0.4" });
    expect(plan.retainedVersions).toEqual(["0.0.4", "0.0.3", "0.0.2"]);
    expect(plan.prunedVersions).toEqual(["0.0.1"]);
    expect(plan.deletions.map((asset) => asset.name)).toEqual(versionAssets("0.0.1", 0).map((asset) => asset.name));
  });

  test("an incoming version older than the retained window is never a reason to keep newer ones out", () => {
    const assets = ["0.0.10", "0.0.11", "0.0.12"].flatMap((v, i) => versionAssets(v, i * 4));
    const plan = planDesktopUiAssetPrune({ assets, keep: 2, incoming: "0.0.3" });
    expect(plan.retainedVersions).toEqual(["0.0.12", "0.0.11"]);
    expect(plan.prunedVersions).toEqual(["0.0.10", "0.0.3"]);
    expect(plan.deletions).toHaveLength(4);
  });

  test("deletes nothing when KEEP exceeds the number of versions", () => {
    const assets = ["0.0.1", "0.0.2", "0.0.3"].flatMap((v, i) => versionAssets(v, i * 4));
    expect(planDesktopUiAssetPrune({ assets, keep: 3 }).deletions).toEqual([]);
    expect(planDesktopUiAssetPrune({ assets, keep: 60 }).deletions).toEqual([]);
    expect(planDesktopUiAssetPrune({ assets, keep: 3, incoming: "0.0.4" }).deletions).toHaveLength(4);
    expect(planDesktopUiAssetPrune({ assets: [], keep: 60 }).deletions).toEqual([]);
    expect(planDesktopUiAssetPrune({ assets: [{ id: 1, name: CURRENT_MANIFEST }] }).deletions).toEqual([]);
  });

  test("keeps a partial four-file set together with its version", () => {
    const partial = versionAssets("0.0.2", 10).slice(0, 2);
    const assets = [...versionAssets("0.0.1", 0), ...partial, ...versionAssets("0.0.3", 20)];
    const plan = planDesktopUiAssetPrune({ assets, keep: 2 });
    expect(plan.retainedVersions).toEqual(["0.0.3", "0.0.2"]);
    expect(plan.deletions.map((asset) => asset.id)).toEqual([0, 1, 2, 3]);
  });

  test("rejects invalid keep counts, versions, and assets", () => {
    const assets = versionAssets("0.0.1", 0);
    expect(() => planDesktopUiAssetPrune({ assets, keep: 0 })).toThrow("Invalid keep count");
    expect(() => planDesktopUiAssetPrune({ assets, keep: 1.5 })).toThrow("Invalid keep count");
    expect(() => planDesktopUiAssetPrune({ assets, incoming: "v0.0.2" })).toThrow("Invalid semantic version");
    expect(() => planDesktopUiAssetPrune({ assets: [{ id: 1.5, name: "x" }] })).toThrow("Invalid release asset");
  });

  test("CLI parses --keep, --incoming, --dry-run and refuses to delete without --repo", () => {
    expect(parsePruneArguments(["--repo", "leeguooooo/AgentParty", "--keep", "60", "--incoming", "0.0.480"])).toEqual({
      repo: "leeguooooo/AgentParty",
      assetsPath: null,
      keep: 60,
      incoming: "0.0.480",
      dryRun: false,
    });
    expect(parsePruneArguments(["--assets", "-", "--dry-run"]).dryRun).toBe(true);
    expect(parsePruneArguments(["--repo", "o/r"]).keep).toBe(DEFAULT_KEEP);
    expect(() => parsePruneArguments([])).toThrow("Usage");
    expect(() => parsePruneArguments(["--assets", "-"])).toThrow("--repo is required to delete assets");
    expect(() => parsePruneArguments(["--repo", "o/r", "--keep", "0"])).toThrow("Invalid keep count");
    expect(() => parsePruneArguments(["--repo", "o/r", "--keep", "-1"])).toThrow();
    expect(() => parsePruneArguments(["--repo", "o/r", "--incoming", "latest"])).toThrow("Invalid semantic version");
    expect(() => parsePruneArguments(["--repo", "o/r", "--repo", "o/r"])).toThrow("Usage");
    expect(() => parsePruneArguments(["--repo", "../../x"])).toThrow("Invalid repository");
    expect(() => parsePruneArguments(["--repo", "o/r", "--bogus", "1"])).toThrow("Usage");
  });

  test("CLI --dry-run prints the deletion list and retained count without deleting", () => {
    const dir = mkdtempSync(join(tmpdir(), "desktop-ui-prune-"));
    const assetsPath = join(dir, "assets.json");
    const { assets } = fullRelease();
    writeFileSync(assetsPath, JSON.stringify({ assets: [...assets, { id: 1, name: CURRENT_MANIFEST }] }));
    const lines: string[] = [];
    const plan = runDesktopUiPruneCli(
      ["--assets", assetsPath, "--keep", "60", "--incoming", "0.0.251", "--dry-run"],
      (line) => lines.push(line),
    );
    expect(plan.deletions).toHaveLength(764);
    expect(lines[0]).toContain("1001 assets across 251 versions");
    expect(lines[0]).toContain("keeping 60 versions including incoming v0.0.251");
    expect(lines[1]).toBe("pruning 191 versions (764 assets), v0.0.1 .. v0.0.191:");
    expect(lines.filter((line) => line.startsWith("  would delete "))).toHaveLength(764);
    expect(lines.some((line) => line.includes(CURRENT_MANIFEST) && line.includes("delete"))).toBe(false);
    expect(lines[lines.length - 1]).toBe(
      "would retain 60 versions; protected assets: desktop-ui.json; 1001 assets remain on the release",
    );
  });

  test("CLI reports nothing to prune for a small release", () => {
    const dir = mkdtempSync(join(tmpdir(), "desktop-ui-prune-"));
    const assetsPath = join(dir, "assets.json");
    writeFileSync(assetsPath, JSON.stringify(versionAssets("0.0.1", 0)));
    const lines: string[] = [];
    const plan = runDesktopUiPruneCli(["--assets", assetsPath, "--dry-run"], (line) => lines.push(line));
    expect(plan.deletions).toEqual([]);
    expect(lines).toContain("nothing to prune");
  });
});
