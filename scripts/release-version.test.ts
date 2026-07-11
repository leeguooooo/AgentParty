import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  compareVersionPrecedence,
  readConsistentVersion,
  runReleaseVersionCli,
  syncVersion,
  validateVersion,
  type ReleaseVersionFileSystem,
  type ReleaseVersionPaths,
} from "./release-version";

const cleanup: string[] = [];

function makePackages(cliVersion = "0.2.82", desktopVersion = cliVersion): ReleaseVersionPaths {
  const directory = mkdtempSync(join(tmpdir(), "agentparty-release-version-"));
  cleanup.push(directory);
  const paths = {
    cliPackagePath: join(directory, "cli-package.json"),
    desktopPackagePath: join(directory, "desktop-package.json"),
    desktopCargoPath: join(directory, "Cargo.toml"),
    desktopCargoLockPath: join(directory, "Cargo.lock"),
  };
  writeFileSync(paths.cliPackagePath, JSON.stringify({ name: "cli", version: cliVersion }, null, 2) + "\n");
  writeFileSync(paths.desktopPackagePath, JSON.stringify({ name: "desktop", version: desktopVersion }, null, 2) + "\n");
  writeFileSync(paths.desktopCargoPath, `[package]\nname = "agentparty-desktop"\nversion = "${desktopVersion}"\n`);
  writeFileSync(paths.desktopCargoLockPath, `version = 4\n\n[[package]]\nname = "agentparty-desktop"\nversion = "${desktopVersion}"\ndependencies = []\n`);
  return paths;
}

function makeCleanupFiles() {
  const paths = makePackages("0.2.83");
  const directory = join(paths.cliPackagePath, "..");
  const files = {
    ...paths,
    cliBackup: join(directory, "cli-package.backup.json"),
    desktopBackup: join(directory, "desktop-package.backup.json"),
    cargoBackup: join(directory, "Cargo.backup.toml"),
    cargoLockBackup: join(directory, "Cargo.backup.lock"),
    cliBumped: join(directory, "cli-package.bumped.json"),
    desktopBumped: join(directory, "desktop-package.bumped.json"),
    cargoBumped: join(directory, "Cargo.bumped.toml"),
    cargoLockBumped: join(directory, "Cargo.bumped.lock"),
  };
  writeFileSync(files.cliBackup, '{"name":"cli","version":"0.2.82"}\n');
  writeFileSync(files.desktopBackup, '{"name":"desktop","version":"0.2.82"}\n');
  writeFileSync(files.cargoBackup, '[package]\nname = "agentparty-desktop"\nversion = "0.2.82"\n');
  writeFileSync(files.cargoLockBackup, 'version = 4\n\n[[package]]\nname = "agentparty-desktop"\nversion = "0.2.82"\ndependencies = []\n');
  writeFileSync(files.cliBumped, readFileSync(files.cliPackagePath));
  writeFileSync(files.desktopBumped, readFileSync(files.desktopPackagePath));
  writeFileSync(files.cargoBumped, readFileSync(files.desktopCargoPath));
  writeFileSync(files.cargoLockBumped, readFileSync(files.desktopCargoLockPath));
  return files;
}

function runReleaseShell(body: string, environment: Record<string, string> = {}) {
  const result = Bun.spawnSync(["bash", "-c", `source scripts/release.sh\n${body}`], {
    cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function cleanupEnvironment(files: Pick<ReturnType<typeof makeCleanupFiles>,
  "cliPackagePath" | "desktopPackagePath" | "cliBackup" | "desktopBackup" | "cliBumped" | "desktopBumped"
> & Partial<Pick<ReturnType<typeof makeCleanupFiles>,
  "desktopCargoPath" | "desktopCargoLockPath" | "cargoBackup" | "cargoLockBackup" | "cargoBumped" | "cargoLockBumped"
>>): Record<string, string> {
  return {
    TEST_CLI_PACKAGE: files.cliPackagePath,
    TEST_DESKTOP_PACKAGE: files.desktopPackagePath,
    TEST_DESKTOP_CARGO: files.desktopCargoPath ?? "",
    TEST_DESKTOP_CARGO_LOCK: files.desktopCargoLockPath ?? "",
    TEST_CLI_BACKUP: files.cliBackup,
    TEST_DESKTOP_BACKUP: files.desktopBackup,
    TEST_DESKTOP_CARGO_BACKUP: files.cargoBackup ?? "",
    TEST_DESKTOP_CARGO_LOCK_BACKUP: files.cargoLockBackup ?? "",
    TEST_CLI_BUMPED: files.cliBumped,
    TEST_DESKTOP_BUMPED: files.desktopBumped,
    TEST_DESKTOP_CARGO_BUMPED: files.cargoBumped ?? "",
    TEST_DESKTOP_CARGO_LOCK_BUMPED: files.cargoLockBumped ?? "",
  };
}

function runGit(directory: string, args: string[]) {
  execFileSync("git", args, { cwd: directory, stdio: "pipe" });
}

type ReleaseHarnessScenario = "view-error" | "ci-failure" | "snapshot-copy-failure";

function writeExecutable(path: string, body: string) {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}`);
  chmodSync(path, 0o755);
}

function runReleaseHarness(scenario: ReleaseHarnessScenario) {
  const directory = mkdtempSync(join(tmpdir(), "agentparty-release-shell-"));
  cleanup.push(directory);
  const fakeBin = join(directory, "fake-bin");
  const commandLog = join(directory, "commands.log");
  const copyCount = join(directory, "copy-count");
  mkdirSync(join(directory, "scripts"));
  mkdirSync(join(directory, "cli"));
  mkdirSync(join(directory, "desktop"));
  mkdirSync(join(directory, "desktop", "src-tauri"));
  mkdirSync(fakeBin);
  copyFileSync(resolve(import.meta.dir, "release.sh"), join(directory, "scripts", "release.sh"));
  chmodSync(join(directory, "scripts", "release.sh"), 0o755);

  const cliPackage = join(directory, "cli", "package.json");
  const desktopPackage = join(directory, "desktop", "package.json");
  const originalCli = '{"name":"cli","version":"0.2.82"}\n';
  const originalDesktop = '{"name":"desktop","version":"0.2.82"}\n';
  writeFileSync(cliPackage, originalCli);
  writeFileSync(desktopPackage, originalDesktop);
  writeFileSync(join(directory, "desktop", "src-tauri", "Cargo.toml"), '[package]\nname = "agentparty-desktop"\nversion = "0.2.82"\n');
  writeFileSync(join(directory, "desktop", "src-tauri", "Cargo.lock"), 'version = 4\n\n[[package]]\nname = "agentparty-desktop"\nversion = "0.2.82"\n');

  writeExecutable(
    join(fakeBin, "git"),
    `printf 'git %s\\n' "$*" >> "$MOCK_COMMAND_LOG"
case "\${1:-}" in
  status) exit 0 ;;
  rev-parse) exit 1 ;;
  *) exit 0 ;;
esac
`,
  );
  writeExecutable(
    join(fakeBin, "bun"),
    `if [[ "\${1:-}" == "scripts/release-version.ts" ]]; then
  printf '{"name":"cli","version":"%s"}\\n' "$2" > cli/package.json
  printf '{"name":"desktop","version":"%s"}\\n' "$2" > desktop/package.json
  sed "s/version = \\\"0.2.82\\\"/version = \\\"$2\\\"/" desktop/src-tauri/Cargo.toml > desktop/src-tauri/Cargo.toml.next
  mv desktop/src-tauri/Cargo.toml.next desktop/src-tauri/Cargo.toml
  sed "s/version = \\\"0.2.82\\\"/version = \\\"$2\\\"/" desktop/src-tauri/Cargo.lock > desktop/src-tauri/Cargo.lock.next
  mv desktop/src-tauri/Cargo.lock.next desktop/src-tauri/Cargo.lock
  exit 0
fi
[[ "\${1:-} \${2:-}" == "run check" ]]
`,
  );
  writeExecutable(
    join(fakeBin, "gh"),
    `printf 'gh %s\\n' "$*" >> "$MOCK_COMMAND_LOG"
if [[ "\${1:-} \${2:-}" == "run list" ]]; then
  printf '[{"databaseId":4242,"headBranch":"v0.2.83"}]\\n'
  exit 0
fi
if [[ "\${1:-} \${2:-}" == "run view" ]]; then
  if [[ "$MOCK_SCENARIO" == "view-error" ]]; then
    echo "simulated network error" >&2
    exit 1
  fi
  printf '{"status":"completed","conclusion":"failure"}\\n'
  exit 0
fi
if [[ "\${1:-} \${2:-}" == "run watch" ]]; then
  echo "simulated watch error" >&2
  exit 1
fi
echo "unexpected gh command: $*" >&2
exit 64
`,
  );
  writeExecutable(
    join(fakeBin, "cp"),
    `count=0
[[ ! -f "$MOCK_COPY_COUNT" ]] || count=$(<"$MOCK_COPY_COUNT")
count=$((count + 1))
printf '%s\\n' "$count" > "$MOCK_COPY_COUNT"
if [[ "$MOCK_SCENARIO" == "snapshot-copy-failure" && "$count" == "7" ]]; then
  echo "simulated snapshot copy failure" >&2
  exit 73
fi
exec /bin/cp "$@"
`,
  );
  writeExecutable(join(fakeBin, "sleep"), "exit 0\n");

  const result = Bun.spawnSync(["bash", "scripts/release.sh", "0.2.83"], {
    cwd: directory,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      MOCK_COMMAND_LOG: commandLog,
      MOCK_COPY_COUNT: copyCount,
      MOCK_SCENARIO: scenario,
      RELEASE_GH_RETRY_DELAY: "0",
      RELEASE_GH_RETRY_ATTEMPTS: "2",
      RELEASE_RUN_LOOKUP_ATTEMPTS: "2",
      RELEASE_RUN_POLL_ATTEMPTS: "2",
      RELEASE_RUN_POLL_INTERVAL: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    commands: readFileSync(commandLog, "utf8"),
    cliPackage,
    desktopPackage,
    desktopCargo: join(directory, "desktop", "src-tauri", "Cargo.toml"),
    desktopCargoLock: join(directory, "desktop", "src-tauri", "Cargo.lock"),
    originalCli,
    originalDesktop,
    originalCargo: '[package]\nname = "agentparty-desktop"\nversion = "0.2.82"\n',
    originalCargoLock: 'version = 4\n\n[[package]]\nname = "agentparty-desktop"\nversion = "0.2.82"\n',
  };
}

const configureCleanup = `
CLI_PACKAGE="$TEST_CLI_PACKAGE"
DESKTOP_PACKAGE="$TEST_DESKTOP_PACKAGE"
DESKTOP_CARGO="$TEST_DESKTOP_CARGO"
DESKTOP_CARGO_LOCK="$TEST_DESKTOP_CARGO_LOCK"
CLI_PACKAGE_BACKUP="$TEST_CLI_BACKUP"
DESKTOP_PACKAGE_BACKUP="$TEST_DESKTOP_BACKUP"
DESKTOP_CARGO_BACKUP="$TEST_DESKTOP_CARGO_BACKUP"
DESKTOP_CARGO_LOCK_BACKUP="$TEST_DESKTOP_CARGO_LOCK_BACKUP"
CLI_PACKAGE_BUMPED="$TEST_CLI_BUMPED"
DESKTOP_PACKAGE_BUMPED="$TEST_DESKTOP_BUMPED"
DESKTOP_CARGO_BUMPED="$TEST_DESKTOP_CARGO_BUMPED"
DESKTOP_CARGO_LOCK_BUMPED="$TEST_DESKTOP_CARGO_LOCK_BUMPED"
BUMPED_SNAPSHOTS_COMPLETE=1
`;

afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { force: true, recursive: true });
});

describe("release version source", () => {
  test("accepts strict semantic versions and rejects invalid versions", () => {
    expect(validateVersion("0.2.83")).toBe("0.2.83");
    expect(validateVersion("1.0.0-rc.1+build.7")).toBe("1.0.0-rc.1+build.7");
    for (const version of ["1.2", "v1.2.3", "01.2.3", "1.2.3.4", "1.2.3-"]) {
      expect(() => validateVersion(version)).toThrow(`Invalid semantic version: ${version}`);
    }
  });

  test("compares SemVer precedence without treating build metadata as a newer release", () => {
    expect(compareVersionPrecedence("0.2.91", "0.2.90")).toBe(1);
    expect(compareVersionPrecedence("0.2.91-rc.1", "0.2.90")).toBe(1);
    expect(compareVersionPrecedence("0.2.91-rc.2", "0.2.91-rc.10")).toBe(-1);
    expect(compareVersionPrecedence("0.2.90+rebuild.2", "0.2.90+rebuild.1")).toBe(0);
  });

  test("reads the shared version only when CLI and desktop packages agree", () => {
    expect(readConsistentVersion(makePackages())).toBe("0.2.82");
    expect(() => readConsistentVersion(makePackages("0.2.82", "0.2.81"))).toThrow(
      "Version mismatch: cli/package.json is 0.2.82, desktop/package.json is 0.2.81, desktop/src-tauri/Cargo.toml is 0.2.81, desktop/src-tauri/Cargo.lock is 0.2.81",
    );
  });

  test("rejects a stale Rust desktop package version", () => {
    const paths = makePackages();
    writeFileSync(paths.desktopCargoPath, '[package]\nname = "agentparty-desktop"\nversion = "0.1.0"\n');

    expect(() => readConsistentVersion(paths)).toThrow(
      "Version mismatch: cli/package.json is 0.2.82, desktop/package.json is 0.2.82, desktop/src-tauri/Cargo.toml is 0.1.0, desktop/src-tauri/Cargo.lock is 0.2.82",
    );
  });

  test("syncs a valid version to both package files and the Rust manifest", () => {
    const paths = makePackages();

    syncVersion("0.2.83", paths);

    expect(JSON.parse(readFileSync(paths.cliPackagePath, "utf8")).version).toBe("0.2.83");
    expect(JSON.parse(readFileSync(paths.desktopPackagePath, "utf8")).version).toBe("0.2.83");
    expect(readFileSync(paths.desktopCargoPath, "utf8")).toContain('version = "0.2.83"');
    expect(readFileSync(paths.desktopCargoLockPath, "utf8")).toContain('name = "agentparty-desktop"\nversion = "0.2.83"');
  });

  test("does not write either package when the version is invalid", () => {
    const paths = makePackages();
    const before = [readFileSync(paths.cliPackagePath, "utf8"), readFileSync(paths.desktopPackagePath, "utf8")];

    expect(() => syncVersion("0.2", paths)).toThrow("Invalid semantic version: 0.2");

    expect(readFileSync(paths.cliPackagePath, "utf8")).toBe(before[0]);
    expect(readFileSync(paths.desktopPackagePath, "utf8")).toBe(before[1]);
  });

  test("restores both package files when one atomic commit fails", () => {
    const paths = makePackages();
    const before = [readFileSync(paths.cliPackagePath, "utf8"), readFileSync(paths.desktopPackagePath, "utf8")];
    const fileSystem: ReleaseVersionFileSystem = {
      readFile: (path) => readFileSync(path, "utf8"),
      writeFile: writeFileSync,
      rename: (source, destination) => {
        if (destination === paths.desktopPackagePath) throw new Error("desktop rename failed");
        renameSync(source, destination);
      },
      unlink: unlinkSync,
    };

    expect(() => syncVersion("0.2.83", paths, fileSystem)).toThrow("desktop rename failed");

    expect(readFileSync(paths.cliPackagePath, "utf8")).toBe(before[0]);
    expect(readFileSync(paths.desktopPackagePath, "utf8")).toBe(before[1]);
  });

  test("attempts every rollback and preserves the original commit failure", () => {
    const paths = makePackages();
    const before = [
      readFileSync(paths.cliPackagePath, "utf8"),
      readFileSync(paths.desktopPackagePath, "utf8"),
      readFileSync(paths.desktopCargoPath, "utf8"),
      readFileSync(paths.desktopCargoLockPath, "utf8"),
    ];
    let commitRenames = 0;
    let rollbackWrites = 0;
    const fileSystem: ReleaseVersionFileSystem = {
      readFile: (path) => readFileSync(path, "utf8"),
      writeFile: (path, data) => {
        if (path.includes(".tmp") && commitRenames >= 2) {
          rollbackWrites += 1;
          if (rollbackWrites === 1) throw new Error("rollback write failed");
        }
        writeFileSync(path, data);
      },
      rename: (source, destination) => {
        if (destination === paths.desktopCargoPath && commitRenames === 2) {
          throw new Error("third commit rename failed");
        }
        commitRenames += 1;
        renameSync(source, destination);
      },
      unlink: unlinkSync,
    };

    let failure: unknown;
    try {
      syncVersion("0.2.83", paths, fileSystem);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors as Error[];
    expect(errors.map((error) => error.message)).toContain("third commit rename failed");
    expect(errors.map((error) => error.message)).toContain("rollback write failed");
    expect(rollbackWrites).toBe(2);
    expect(readFileSync(paths.cliPackagePath, "utf8")).toBe(before[0]);
    expect(readFileSync(paths.desktopPackagePath, "utf8")).not.toBe(before[1]);
    expect(readFileSync(paths.desktopCargoPath, "utf8")).toBe(before[2]);
    expect(readFileSync(paths.desktopCargoLockPath, "utf8")).toBe(before[3]);
  });

  test("CLI accepts a version argument and rejects extra arguments", () => {
    const paths = makePackages();

    runReleaseVersionCli(["0.2.83"], paths);
    expect(readConsistentVersion(paths)).toBe("0.2.83");
    expect(() => runReleaseVersionCli(["0.2.84", "extra"], paths)).toThrow(
      "Usage: bun scripts/release-version.ts <version>",
    );
  });

  test("CLI release bump rejects equal or lower precedence", () => {
    const paths = makePackages();
    expect(() => runReleaseVersionCli(["0.2.82+rebuild"], paths)).toThrow(
      "Release version must advance: current 0.2.82, requested 0.2.82+rebuild",
    );
    expect(() => runReleaseVersionCli(["0.2.81"], paths)).toThrow(
      "Release version must advance: current 0.2.82, requested 0.2.81",
    );
  });

  test("CI monotonic check allows a rerun of latest but rejects an older tag", () => {
    const paths = makePackages();
    expect(runReleaseVersionCli(["--check-not-older-than", "0.2.90", "0.2.90"], paths)).toBe("0.2.90");
    expect(runReleaseVersionCli(["--check-not-older-than", "0.2.90", "0.2.91-rc.1"], paths)).toBe("0.2.91-rc.1");
    expect(() => runReleaseVersionCli(["--check-not-older-than", "0.2.90", "0.2.89+rebuild"], paths)).toThrow(
      "Release version regression: candidate 0.2.89+rebuild is older than 0.2.90",
    );
  });

  test("CLI check mode validates all release version sources without writing", () => {
    const paths = makePackages();
    const before = [
      readFileSync(paths.cliPackagePath, "utf8"),
      readFileSync(paths.desktopPackagePath, "utf8"),
      readFileSync(paths.desktopCargoPath, "utf8"),
      readFileSync(paths.desktopCargoLockPath, "utf8"),
    ];

    expect(runReleaseVersionCli(["--check", "0.2.82"], paths)).toBe("0.2.82");
    expect(() => runReleaseVersionCli(["--check", "0.2.83"], paths)).toThrow(
      "Release version mismatch: expected 0.2.83, found 0.2.82",
    );
    expect([
      readFileSync(paths.cliPackagePath, "utf8"),
      readFileSync(paths.desktopPackagePath, "utf8"),
      readFileSync(paths.desktopCargoPath, "utf8"),
      readFileSync(paths.desktopCargoLockPath, "utf8"),
    ]).toEqual(before);
  });
});

describe("release shell cleanup", () => {
  test("continues after a failed gate only when SKIP_LOCAL_CHECK is 1", () => {
    const result = runReleaseShell(`
unset SKIP_LOCAL_CHECK
if should_skip_local_check; then exit 11; fi
SKIP_LOCAL_CHECK=1
should_skip_local_check
`);

    expect(result.exitCode).toBe(0);
  });

  test("restores both bumped packages on failure and preserves the exit status", () => {
    const files = makeCleanupFiles();
    const expected = [readFileSync(files.cliBackup, "utf8"), readFileSync(files.desktopBackup, "utf8")];
    const result = runReleaseShell(
      `${configureCleanup}
RESTORE_PENDING=1
set +e
false
cleanup_release_version
`,
      cleanupEnvironment(files),
    );

    expect(result.exitCode).toBe(1);
    expect(readFileSync(files.cliPackagePath, "utf8")).toBe(expected[0]);
    expect(readFileSync(files.desktopPackagePath, "utf8")).toBe(expected[1]);
  });

  test("does not restore packages after release cleanup is disabled", () => {
    const files = makeCleanupFiles();
    const before = [readFileSync(files.cliPackagePath, "utf8"), readFileSync(files.desktopPackagePath, "utf8")];
    const result = runReleaseShell(
      `${configureCleanup}
RESTORE_PENDING=1
disable_release_cleanup
set +e
false
cleanup_release_version
`,
      cleanupEnvironment(files),
    );

    expect(result.exitCode).toBe(1);
    expect(readFileSync(files.cliPackagePath, "utf8")).toBe(before[0]);
    expect(readFileSync(files.desktopPackagePath, "utf8")).toBe(before[1]);
  });

  test("refuses to overwrite package files changed after the bump", () => {
    const files = makeCleanupFiles();
    const userEdit = '{"name":"cli","version":"user-edit"}\n';
    writeFileSync(files.cliPackagePath, userEdit);
    const desktopBefore = readFileSync(files.desktopPackagePath, "utf8");
    const result = runReleaseShell(
      `${configureCleanup}
RESTORE_PENDING=1
set +e
false
cleanup_release_version
`,
      cleanupEnvironment(files),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("package 内容在 bump 后被修改，未自动恢复");
    expect(readFileSync(files.cliPackagePath, "utf8")).toBe(userEdit);
    expect(readFileSync(files.desktopPackagePath, "utf8")).toBe(desktopBefore);
  });

  test("clears staged bumps and restores both packages when commit fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentparty-release-git-"));
    cleanup.push(directory);
    const cliPackagePath = join(directory, "cli", "package.json");
    const desktopPackagePath = join(directory, "desktop", "package.json");
    const cliBackup = join(directory, "cli.backup.json");
    const desktopBackup = join(directory, "desktop.backup.json");
    const cliBumped = join(directory, "cli.bumped.json");
    const desktopBumped = join(directory, "desktop.bumped.json");

    runGit(directory, ["init", "-q"]);
    runGit(directory, ["config", "user.email", "test@example.com"]);
    runGit(directory, ["config", "user.name", "Release Test"]);
    mkdirSync(join(directory, "cli"));
    mkdirSync(join(directory, "desktop"));
    writeFileSync(cliPackagePath, '{"name":"cli","version":"0.2.82"}\n');
    writeFileSync(desktopPackagePath, '{"name":"desktop","version":"0.2.82"}\n');
    runGit(directory, ["add", "cli/package.json", "desktop/package.json"]);
    runGit(directory, ["commit", "-qm", "initial"]);

    writeFileSync(cliBackup, readFileSync(cliPackagePath));
    writeFileSync(desktopBackup, readFileSync(desktopPackagePath));
    writeFileSync(cliPackagePath, '{"name":"cli","version":"0.2.83"}\n');
    writeFileSync(desktopPackagePath, '{"name":"desktop","version":"0.2.83"}\n');
    writeFileSync(cliBumped, readFileSync(cliPackagePath));
    writeFileSync(desktopBumped, readFileSync(desktopPackagePath));
    const expectedCli = readFileSync(cliBackup, "utf8");
    const expectedDesktop = readFileSync(desktopBackup, "utf8");

    const result = Bun.spawnSync(
      [
        "bash",
        "-c",
        `source ${resolve(import.meta.dir, "release.sh")}
CLI_PACKAGE="cli/package.json"
DESKTOP_PACKAGE="desktop/package.json"
CLI_PACKAGE_BACKUP="$TEST_CLI_BACKUP"
DESKTOP_PACKAGE_BACKUP="$TEST_DESKTOP_BACKUP"
CLI_PACKAGE_BUMPED="$TEST_CLI_BUMPED"
DESKTOP_PACKAGE_BUMPED="$TEST_DESKTOP_BUMPED"
RESTORE_PENDING=1
git add cli/package.json desktop/package.json
INDEX_PENDING=1
set +e
git commit --definitely-not-a-valid-option
cleanup_release_version
`,
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          ...cleanupEnvironment({
            cliPackagePath,
            desktopPackagePath,
            cliBackup,
            desktopBackup,
            cliBumped,
            desktopBumped,
          }),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: directory }).toString()).toBe("");
    expect(readFileSync(cliPackagePath, "utf8")).toBe(expectedCli);
    expect(readFileSync(desktopPackagePath, "utf8")).toBe(expectedDesktop);
  });
});

describe("release workflow observation", () => {
  test("keeps the published tag when gh cannot observe the run", () => {
    const result = runReleaseHarness("view-error");

    expect(result.exitCode).not.toBe(0);
    expect(result.commands).toContain("gh run view 4242 --json status,conclusion");
    expect(result.commands).not.toContain("gh run watch");
    expect(result.commands).not.toContain("git push --delete");
    expect(result.stderr).toContain("观察 release run 失败");
  });

  test("keeps the published tag when CI reports a failure conclusion", () => {
    const result = runReleaseHarness("ci-failure");

    expect(result.exitCode).not.toBe(0);
    expect(result.commands).not.toContain("git push --delete");
    expect(result.stderr).toContain("CI 已确认失败: status=completed conclusion=failure");
    expect(result.stderr).toContain("gh run view 4242 --log-failed");
  });

  test("accepts a completed successful run", () => {
    const result = runReleaseShell(
      `TAG="v0.2.83"
sleep() { :; }
gh() {
  if [[ "$1 $2" == "run list" ]]; then
    printf '[{"databaseId":4242,"headBranch":"v0.2.83"}]\\n'
  else
    printf '{"status":"completed","conclusion":"success"}\\n'
  fi
}
watch_tag_run
[[ "$RELEASE_RUN_ID" == "4242" ]]
[[ "$RELEASE_RUN_STATUS" == "completed" ]]
[[ "$RELEASE_RUN_CONCLUSION" == "success" ]]
`,
      {
        RELEASE_RUN_INITIAL_DELAY: "0",
        RELEASE_RUN_POLL_INTERVAL: "0",
      },
    );

    expect(result.exitCode).toBe(0);
  });

  test("restores every version source when a bumped snapshot copy fails", () => {
    const result = runReleaseHarness("snapshot-copy-failure");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("simulated snapshot copy failure");
    expect(readFileSync(result.cliPackage, "utf8")).toBe(result.originalCli);
    expect(readFileSync(result.desktopPackage, "utf8")).toBe(result.originalDesktop);
    expect(readFileSync(result.desktopCargo, "utf8")).toBe(result.originalCargo);
    expect(readFileSync(result.desktopCargoLock, "utf8")).toBe(result.originalCargoLock);
    expect(result.commands).not.toContain("git add");
  });
});

describe("release asset verification", () => {
  const requiredAssets = [
    "party-darwin-arm64.tar.gz",
    "party-darwin-arm64.tar.gz.sha256",
    "party-darwin-x64.tar.gz",
    "party-darwin-x64.tar.gz.sha256",
    "party-linux-arm64.tar.gz",
    "party-linux-arm64.tar.gz.sha256",
    "party-linux-x64.tar.gz",
    "party-linux-x64.tar.gz.sha256",
    "party-windows-x64.tar.gz",
    "party-windows-x64.tar.gz.sha256",
    "agentparty-desktop-darwin-arm64.dmg",
    "agentparty-desktop-darwin-arm64.dmg.sha256",
    "agentparty-desktop-darwin-arm64.app.tar.gz",
    "agentparty-desktop-darwin-arm64.app.tar.gz.sig",
    "agentparty-desktop-darwin-arm64.signing-status.json",
    "agentparty-desktop-darwin-x64.dmg",
    "agentparty-desktop-darwin-x64.dmg.sha256",
    "agentparty-desktop-darwin-x64.app.tar.gz",
    "agentparty-desktop-darwin-x64.app.tar.gz.sig",
    "agentparty-desktop-darwin-x64.signing-status.json",
    "latest.json",
  ];
  const bridgeAssets = [
    ...requiredAssets,
    "agentparty-desktop-darwin-arm64.app.tar.gz.sig.v2",
    "agentparty-desktop-darwin-x64.app.tar.gz.sig.v2",
    "latest-v2.json",
  ];

  function releaseAssetsJson(assets: string[], emptyAsset?: string) {
    return JSON.stringify({ assets: assets.map((name) => ({ name, size: name === emptyAsset ? 0 : 1 })) });
  }

  test("accepts only a complete CLI and desktop updater release", () => {
    const result = runReleaseShell("verify_release_assets", {
      RELEASE_ASSETS_JSON: releaseAssetsJson(requiredAssets),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("21 required release assets ok");
  });

  test("requires both updater channels and v2 signatures for a bridge release", () => {
    const result = runReleaseShell("verify_release_assets", {
      DESKTOP_UPDATER_KEY_MODE: "bridge",
      RELEASE_ASSETS_JSON: releaseAssetsJson(bridgeAssets),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("24 required release assets ok");

    const missing = "latest-v2.json";
    const incomplete = runReleaseShell("verify_release_assets", {
      DESKTOP_UPDATER_KEY_MODE: "bridge",
      RELEASE_ASSETS_JSON: releaseAssetsJson(bridgeAssets.filter((asset) => asset !== missing)),
    });
    expect(incomplete.exitCode).not.toBe(0);
    expect(incomplete.stderr).toContain(`missing release assets: ${missing}`);
  });

  test("requires the v2 manifest but not bridge-only signatures after rotation", () => {
    const result = runReleaseShell("verify_release_assets", {
      DESKTOP_UPDATER_KEY_MODE: "v2",
      RELEASE_ASSETS_JSON: releaseAssetsJson([...requiredAssets, "latest-v2.json"]),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("22 required release assets ok");
  });

  test("rejects a release missing a signed desktop updater asset", () => {
    const missing = "agentparty-desktop-darwin-x64.app.tar.gz.sig";
    const result = runReleaseShell("verify_release_assets", {
      RELEASE_ASSETS_JSON: releaseAssetsJson(requiredAssets.filter((asset) => asset !== missing)),
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(`missing release assets: ${missing}`);
  });

  test("rejects a release missing a desktop signing status asset", () => {
    const missing = "agentparty-desktop-darwin-arm64.signing-status.json";
    const result = runReleaseShell("verify_release_assets", {
      RELEASE_ASSETS_JSON: releaseAssetsJson(requiredAssets.filter((asset) => asset !== missing)),
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(`missing release assets: ${missing}`);
  });

  test("rejects zero-byte required release assets", () => {
    const empty = "latest.json";
    const result = runReleaseShell("verify_release_assets", {
      RELEASE_ASSETS_JSON: releaseAssetsJson(requiredAssets, empty),
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(`empty release assets: ${empty}`);
  });
});
