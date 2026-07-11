import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface ReleaseVersionPaths {
  cliPackagePath: string;
  desktopPackagePath: string;
  desktopCargoPath: string;
  desktopCargoLockPath: string;
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
  desktopCargoPath: resolve(import.meta.dir, "../desktop/src-tauri/Cargo.toml"),
  desktopCargoLockPath: resolve(import.meta.dir, "../desktop/src-tauri/Cargo.lock"),
};

export function validateVersion(version: string): string {
  if (!SEMVER.test(version)) throw new Error(`Invalid semantic version: ${version}`);
  return version;
}

export function compareVersionPrecedence(left: string, right: string): number {
  const parse = (version: string) => {
    validateVersion(version);
    const match = version.match(SEMVER)!;
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4]?.split(".") ?? null,
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.prerelease === null || b.prerelease === null) {
    if (a.prerelease === b.prerelease) return 0;
    return a.prerelease === null ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined || bv === undefined) return av === undefined ? -1 : 1;
    if (av === bv) continue;
    const an = /^\d+$/.test(av);
    const bn = /^\d+$/.test(bv);
    if (an && bn) return Number(av) < Number(bv) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return av < bv ? -1 : 1;
  }
  return 0;
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
  const rustVersion = readCargoPackageVersion(paths.desktopCargoPath, fs).version;
  const rustLockVersion = readCargoLockPackageVersion(paths.desktopCargoLockPath, fs).version;
  validateVersion(cliVersion);
  validateVersion(desktopVersion);
  validateVersion(rustVersion);
  validateVersion(rustLockVersion);
  if (cliVersion !== desktopVersion || cliVersion !== rustVersion || cliVersion !== rustLockVersion) {
    throw new Error(
      `Version mismatch: cli/package.json is ${cliVersion}, desktop/package.json is ${desktopVersion}, desktop/src-tauri/Cargo.toml is ${rustVersion}, desktop/src-tauri/Cargo.lock is ${rustLockVersion}`,
    );
  }
  return cliVersion;
}

function readCargoLockPackageVersion(
  path: string,
  fs: ReleaseVersionFileSystem,
): { source: string; version: string; replace(next: string): string } {
  const source = fs.readFile(path);
  const lines = source.split(/(?<=\n)/);
  let packageStart = -1;
  let packageName: string | null = null;
  let versionLine = -1;
  let version = "";
  let matches = 0;
  let matchedVersionLine = -1;
  let matchedVersion = "";

  const finishPackage = () => {
    if (packageStart === -1 || packageName !== "agentparty-desktop") return;
    if (versionLine === -1) throw new Error(`Cargo lock package has no version: ${path}`);
    matches += 1;
    matchedVersionLine = versionLine;
    matchedVersion = version;
  };

  for (let index = 0; index <= lines.length; index += 1) {
    const line = lines[index] ?? "[[package]]\n";
    if (/^\s*\[\[package]]\s*(?:\r?\n)?$/.test(line)) {
      finishPackage();
      packageStart = index;
      packageName = null;
      versionLine = -1;
      version = "";
      continue;
    }
    if (packageStart === -1) continue;
    const nameMatch = line.match(/^\s*name\s*=\s*"([^"]+)"\s*(?:\r?\n)?$/);
    if (nameMatch !== null) packageName = nameMatch[1];
    const versionMatch = line.match(/^\s*version\s*=\s*"([^"]+)"\s*(?:\r?\n)?$/);
    if (versionMatch !== null) {
      versionLine = index;
      version = versionMatch[1];
    }
  }
  if (matches !== 1) throw new Error(`Cargo lock must contain one agentparty-desktop package: ${path}`);
  return {
    source,
    version: matchedVersion,
    replace(next) {
      lines[matchedVersionLine] = lines[matchedVersionLine].replace(/"[^"]+"/, `"${next}"`);
      return lines.join("");
    },
  };
}

function readCargoPackageVersion(
  path: string,
  fs: ReleaseVersionFileSystem,
): { source: string; version: string; replace(next: string): string } {
  const source = fs.readFile(path);
  const lines = source.split(/(?<=\n)/);
  let inPackage = false;
  let versionLine = -1;
  let version = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const section = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?(?:\r?\n)?$/);
    if (section !== null) {
      inPackage = section[1].trim() === "package";
      continue;
    }
    if (!inPackage) continue;
    const match = line.match(/^(\s*version\s*=\s*)"([^"]+)"(\s*(?:#.*)?(?:\r?\n)?)$/);
    if (match === null) continue;
    if (versionLine !== -1) throw new Error(`Cargo package has multiple versions: ${path}`);
    versionLine = index;
    version = match[2];
  }
  if (versionLine === -1) throw new Error(`Cargo package has no version: ${path}`);
  return {
    source,
    version,
    replace(next) {
      const line = lines[versionLine];
      lines[versionLine] = line.replace(/^(\s*version\s*=\s*)"[^"]+"/, `$1"${next}"`);
      return lines.join("");
    },
  };
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
  const rust = readCargoPackageVersion(paths.desktopCargoPath, fs);
  const rustLock = readCargoLockPackageVersion(paths.desktopCargoLockPath, fs);
  cli.packageJson.version = version;
  desktop.packageJson.version = version;

  const updates = [
    { path: paths.cliPackagePath, source: cli.source, contents: JSON.stringify(cli.packageJson, null, 2) + "\n", temporary: temporaryPath(paths.cliPackagePath), committed: false },
    { path: paths.desktopPackagePath, source: desktop.source, contents: JSON.stringify(desktop.packageJson, null, 2) + "\n", temporary: temporaryPath(paths.desktopPackagePath), committed: false },
    { path: paths.desktopCargoPath, source: rust.source, contents: rust.replace(version), temporary: temporaryPath(paths.desktopCargoPath), committed: false },
    { path: paths.desktopCargoLockPath, source: rustLock.source, contents: rustLock.replace(version), temporary: temporaryPath(paths.desktopCargoLockPath), committed: false },
  ];

  try {
    for (const update of updates) fs.writeFile(update.temporary, update.contents);
    for (const update of updates) {
      fs.rename(update.temporary, update.path);
      update.committed = true;
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const update of updates.filter((candidate) => candidate.committed).reverse()) {
      const rollbackTemporary = temporaryPath(update.path);
      try {
        fs.writeFile(rollbackTemporary, update.source);
        fs.rename(rollbackTemporary, update.path);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      } finally {
        try {
          fs.unlink(rollbackTemporary);
        } catch {
          // The rollback temporary file was renamed or never created.
        }
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "Version update failed and rollback was incomplete", { cause: error });
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
  if (arguments_[0] === "--check-not-older-than") {
    if (arguments_.length !== 3) {
      throw new Error("Usage: bun scripts/release-version.ts --check-not-older-than <baseline> <candidate>");
    }
    const [baseline, candidate] = arguments_.slice(1).map(validateVersion);
    if (compareVersionPrecedence(candidate, baseline) < 0) {
      throw new Error(`Release version regression: candidate ${candidate} is older than ${baseline}`);
    }
    return candidate;
  }
  if (arguments_[0] === "--check") {
    if (arguments_.length !== 2) throw new Error("Usage: bun scripts/release-version.ts --check <version>");
    const expected = validateVersion(arguments_[1]);
    const current = readConsistentVersion(paths);
    if (current !== expected) throw new Error(`Release version mismatch: expected ${expected}, found ${current}`);
    return current;
  }
  if (arguments_.length !== 1) throw new Error("Usage: bun scripts/release-version.ts <version>");
  const previousVersion = readConsistentVersion(paths);
  if (compareVersionPrecedence(arguments_[0], previousVersion) <= 0) {
    throw new Error(`Release version must advance: current ${previousVersion}, requested ${arguments_[0]}`);
  }
  syncVersion(arguments_[0], paths);
  return previousVersion;
}

if (import.meta.main) {
  try {
    const previousVersion = runReleaseVersionCli(process.argv.slice(2));
    if (process.argv[2] === "--check" || process.argv[2] === "--check-not-older-than") console.log(`Release version contract ok: ${previousVersion}`);
    else console.log(`Synchronized ${previousVersion} -> ${process.argv[2]}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
