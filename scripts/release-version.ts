import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface ReleaseVersionPaths {
  cliPackagePath: string;
  desktopPackagePath: string;
}

export interface ReleaseVersionFileSystem {
  readFile(path: string): string;
  writeFile(path: string, data: string): void;
  rename(source: string, destination: string): void;
  unlink(path: string): void;
}

const fileSystem: ReleaseVersionFileSystem = {
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: writeFileSync,
  rename: renameSync,
  unlink: unlinkSync,
};

export const defaultReleaseVersionPaths: ReleaseVersionPaths = {
  cliPackagePath: resolve(import.meta.dir, "../cli/package.json"),
  desktopPackagePath: resolve(import.meta.dir, "../desktop/package.json"),
};

export function validateVersion(version: string): string {
  if (!SEMVER.test(version)) throw new Error(`Invalid semantic version: ${version}`);
  return version;
}

function readPackage(path: string, fs: ReleaseVersionFileSystem): { source: string; packageJson: Record<string, unknown> } {
  const source = fs.readFile(path);
  const packageJson: unknown = JSON.parse(source);
  if (!isPackageJson(packageJson)) {
    throw new Error(`Invalid package JSON: ${path}`);
  }
  if (typeof packageJson.version !== "string") throw new Error(`Package has no version: ${path}`);
  return { source, packageJson };
}

function isPackageJson(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readConsistentVersion(
  paths: ReleaseVersionPaths = defaultReleaseVersionPaths,
  fs: ReleaseVersionFileSystem = fileSystem,
): string {
  const cliVersion = readPackage(paths.cliPackagePath, fs).packageJson.version as string;
  const desktopVersion = readPackage(paths.desktopPackagePath, fs).packageJson.version as string;
  validateVersion(cliVersion);
  validateVersion(desktopVersion);
  if (cliVersion !== desktopVersion) {
    throw new Error(`Version mismatch: cli/package.json is ${cliVersion} but desktop/package.json is ${desktopVersion}`);
  }
  return cliVersion;
}

function temporaryPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
}

export function syncVersion(
  version: string,
  paths: ReleaseVersionPaths = defaultReleaseVersionPaths,
  fs: ReleaseVersionFileSystem = fileSystem,
): void {
  validateVersion(version);
  const cli = readPackage(paths.cliPackagePath, fs);
  const desktop = readPackage(paths.desktopPackagePath, fs);
  cli.packageJson.version = version;
  desktop.packageJson.version = version;

  const updates = [
    { path: paths.cliPackagePath, source: cli.source, contents: JSON.stringify(cli.packageJson, null, 2) + "\n", temporary: temporaryPath(paths.cliPackagePath), committed: false },
    { path: paths.desktopPackagePath, source: desktop.source, contents: JSON.stringify(desktop.packageJson, null, 2) + "\n", temporary: temporaryPath(paths.desktopPackagePath), committed: false },
  ];

  try {
    for (const update of updates) fs.writeFile(update.temporary, update.contents);
    for (const update of updates) {
      fs.rename(update.temporary, update.path);
      update.committed = true;
    }
  } catch (error) {
    for (const update of updates) {
      if (update.committed) fs.writeFile(update.path, update.source);
    }
    throw error;
  } finally {
    for (const update of updates) {
      try {
        fs.unlink(update.temporary);
      } catch {
        // The temporary file was already renamed or could not be created.
      }
    }
  }
}

export function runReleaseVersionCli(
  arguments_: string[],
  paths: ReleaseVersionPaths = defaultReleaseVersionPaths,
): string {
  if (arguments_.length !== 1) throw new Error("Usage: bun scripts/release-version.ts <version>");
  const previousVersion = readConsistentVersion(paths);
  syncVersion(arguments_[0], paths);
  return previousVersion;
}

if (import.meta.main) {
  try {
    const previousVersion = runReleaseVersionCli(process.argv.slice(2));
    console.log(`Synchronized ${previousVersion} -> ${process.argv[2]}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
