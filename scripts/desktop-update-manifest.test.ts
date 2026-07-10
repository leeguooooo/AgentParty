import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDesktopUpdateManifest, runDesktopUpdateManifestCli } from "./desktop-update-manifest";

const cleanup: string[] = [];

const bundleNames = {
  arm64: "agentparty-desktop-darwin-arm64.app.tar.gz",
  x64: "agentparty-desktop-darwin-x64.app.tar.gz",
} as const;

function makeReleaseDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "agentparty-desktop-update-"));
  cleanup.push(directory);
  for (const [architecture, bundleName] of Object.entries(bundleNames)) {
    writeFileSync(join(directory, bundleName), `${architecture} bundle`);
    writeFileSync(join(directory, `${bundleName}.sig`), `${architecture} signature\n`);
  }
  return directory;
}

function manifestInput(directory = makeReleaseDirectory()) {
  return {
    version: "0.2.83",
    tag: "v0.2.83",
    repo: "leeguooooo/agentparty",
    dir: directory,
    notes: "Desktop maturity release",
    pubDate: "2026-07-10T12:30:45Z",
  };
}

const fixedClock = () => new Date("2026-07-10T12:30:45.678Z");

afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { force: true, recursive: true });
});

describe("buildDesktopUpdateManifest", () => {
  test("builds the Tauri static manifest with release URLs and inline signatures", () => {
    const manifest = buildDesktopUpdateManifest(manifestInput());

    expect(manifest).toEqual({
      version: "0.2.83",
      notes: "Desktop maturity release",
      pub_date: "2026-07-10T12:30:45Z",
      platforms: {
        "darwin-aarch64": {
          url: "https://github.com/leeguooooo/agentparty/releases/download/v0.2.83/agentparty-desktop-darwin-arm64.app.tar.gz",
          signature: "arm64 signature\n",
        },
        "darwin-x86_64": {
          url: "https://github.com/leeguooooo/agentparty/releases/download/v0.2.83/agentparty-desktop-darwin-x64.app.tar.gz",
          signature: "x64 signature\n",
        },
      },
    });
  });

  test("uses an injected clock when no publication date is supplied", () => {
    const { pubDate: _, ...input } = manifestInput();

    expect(buildDesktopUpdateManifest(input, fixedClock).pub_date).toBe("2026-07-10T12:30:45.678Z");
  });

  test("URL-encodes the repository, release tag, and bundle name as URL path segments", () => {
    const manifest = buildDesktopUpdateManifest({
      ...manifestInput(),
      repo: "release team/agent party",
      tag: "desktop v0.2.83+build.7",
    });

    expect(manifest.platforms["darwin-aarch64"].url).toBe(
      "https://github.com/release%20team/agent%20party/releases/download/desktop%20v0.2.83%2Bbuild.7/agentparty-desktop-darwin-arm64.app.tar.gz",
    );
  });

  test("rejects invalid semantic versions and RFC 3339 publication dates", () => {
    expect(() => buildDesktopUpdateManifest({ ...manifestInput(), version: "v0.2.83" })).toThrow(
      "Invalid semantic version: v0.2.83",
    );
    expect(() => buildDesktopUpdateManifest({ ...manifestInput(), pubDate: "2026-07-10" })).toThrow(
      "Invalid RFC 3339 publication date: 2026-07-10",
    );
    expect(() => buildDesktopUpdateManifest({ ...manifestInput(), pubDate: "2026-02-29T00:00:00Z" })).toThrow(
      "Invalid RFC 3339 publication date: 2026-02-29T00:00:00Z",
    );
    expect(() => buildDesktopUpdateManifest({ ...manifestInput(), pubDate: "2026-07-10T12:30:45+24:00" })).toThrow(
      "Invalid RFC 3339 publication date: 2026-07-10T12:30:45+24:00",
    );
    expect(() => buildDesktopUpdateManifest({ ...manifestInput(), pubDate: "2026-07-10T12:30:60Z" })).toThrow(
      "Invalid RFC 3339 publication date: 2026-07-10T12:30:60Z",
    );
  });

  test("accepts RFC 3339 early years, offsets, fractional seconds, and leap seconds", () => {
    for (const pubDate of [
      "0000-01-01T00:00:00Z",
      "0099-12-31T23:59:59-03:30",
      "2026-07-10T12:30:45.123456+09:00",
      "2016-12-31T23:59:60Z",
      "2017-01-01T08:59:60+09:00",
    ]) {
      expect(buildDesktopUpdateManifest({ ...manifestInput(), pubDate }).pub_date).toBe(pubDate);
    }
  });

  test("rejects a missing updater bundle or signature", () => {
    const missingBundle = makeReleaseDirectory();
    unlinkSync(join(missingBundle, bundleNames.arm64));
    expect(() => buildDesktopUpdateManifest(manifestInput(missingBundle))).toThrow(
      `Missing updater bundle: ${bundleNames.arm64}`,
    );

    const missingSignature = makeReleaseDirectory();
    unlinkSync(join(missingSignature, `${bundleNames.x64}.sig`));
    expect(() => buildDesktopUpdateManifest(manifestInput(missingSignature))).toThrow(
      `Missing updater signature: ${bundleNames.x64}.sig`,
    );
  });

  test("rejects an empty updater signature", () => {
    const directory = makeReleaseDirectory();
    writeFileSync(join(directory, `${bundleNames.arm64}.sig`), " \n\t");

    expect(() => buildDesktopUpdateManifest(manifestInput(directory))).toThrow(
      `Empty updater signature: ${bundleNames.arm64}.sig`,
    );

    const nonFileDirectory = makeReleaseDirectory();
    rmSync(join(nonFileDirectory, `${bundleNames.x64}.sig`));
    mkdirSync(join(nonFileDirectory, `${bundleNames.x64}.sig`));
    expect(() => buildDesktopUpdateManifest(manifestInput(nonFileDirectory))).toThrow(
      `Invalid updater signature: ${bundleNames.x64}.sig`,
    );
  });

  test("rejects empty and non-file updater bundles", () => {
    const emptyDirectory = makeReleaseDirectory();
    writeFileSync(join(emptyDirectory, bundleNames.arm64), "");
    expect(() => buildDesktopUpdateManifest(manifestInput(emptyDirectory))).toThrow(
      `Empty updater bundle: ${bundleNames.arm64}`,
    );

    const nonFileDirectory = makeReleaseDirectory();
    rmSync(join(nonFileDirectory, bundleNames.x64));
    mkdirSync(join(nonFileDirectory, bundleNames.x64));
    expect(() => buildDesktopUpdateManifest(manifestInput(nonFileDirectory))).toThrow(
      `Invalid updater bundle: ${bundleNames.x64}`,
    );
  });
});

describe("desktop update manifest CLI", () => {
  test("writes latest.json atomically to the explicit output path", () => {
    const directory = makeReleaseDirectory();
    const output = join(directory, "updates", "latest.json");

    runDesktopUpdateManifestCli([
      "--version", "0.2.83",
      "--tag", "v0.2.83",
      "--repo", "leeguooooo/agentparty",
      "--dir", directory,
      "--output", output,
      "--notes", "Desktop maturity release",
      "--pub-date", "2026-07-10T12:30:45Z",
    ]);

    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(buildDesktopUpdateManifest(manifestInput(directory)));
    expect(readdirSync(join(directory, "updates"))).toEqual(["latest.json"]);
  });

  test("requires every named CLI flag and prints usage", () => {
    expect(() => runDesktopUpdateManifestCli(["--version", "0.2.83"])).toThrow(
      "Usage: bun scripts/desktop-update-manifest.ts --version <semver> --tag <tag> --repo <owner/repo> --dir <bundle-directory> --output <latest.json> --notes <notes> [--pub-date <RFC3339>]",
    );
  });

  test("requires each mandatory CLI flag even when the optional publication date is supplied", () => {
    const directory = makeReleaseDirectory();

    expect(() => runDesktopUpdateManifestCli([
      "--version", "0.2.83",
      "--tag", "v0.2.83",
      "--repo", "leeguooooo/agentparty",
      "--dir", directory,
      "--output", join(directory, "latest.json"),
      "--pub-date", "2026-07-10T12:30:45Z",
    ])).toThrow(
      "Usage: bun scripts/desktop-update-manifest.ts --version <semver> --tag <tag> --repo <owner/repo> --dir <bundle-directory> --output <latest.json> --notes <notes> [--pub-date <RFC3339>]",
    );
  });

  test("uses an injected clock when the CLI publication date flag is omitted", () => {
    const directory = makeReleaseDirectory();
    const output = join(directory, "latest.json");

    runDesktopUpdateManifestCli([
      "--version", "0.2.83",
      "--tag", "v0.2.83",
      "--repo", "leeguooooo/agentparty",
      "--dir", directory,
      "--output", output,
      "--notes", "Desktop maturity release",
    ], fixedClock);

    expect(JSON.parse(readFileSync(output, "utf8")).pub_date).toBe("2026-07-10T12:30:45.678Z");
  });
});
