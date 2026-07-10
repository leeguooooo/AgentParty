import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dir, "..");
const installScript = join(repoRoot, "install.sh");
const cleanup: string[] = [];

type Fixture = ReturnType<typeof makeFixture>;

function commandPath(name: string): string {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${name}`], {
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) throw new Error(`missing test dependency: ${name}`);
  return result.stdout.trim();
}

function writeShim(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "agentparty-install-"));
  cleanup.push(root);

  const installDir = join(root, "bin");
  const mirror = join(root, "mirror");
  const payload = join(root, "payload");
  const shims = join(root, "shims");
  const releaseDir = join(mirror, "v0.2.87");
  const trace = join(root, "trace.tsv");
  mkdirSync(installDir, { recursive: true });
  mkdirSync(payload, { recursive: true });
  mkdirSync(shims, { recursive: true });
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(trace, "");

  const target = join(installDir, "party");
  writeFileSync(target, "old party\n");
  chmodSync(target, 0o755);

  const payloadBinary = join(payload, "party");
  writeFileSync(payloadBinary, "#!/bin/sh\nprintf 'new party\\n'\n");
  chmodSync(payloadBinary, 0o644);

  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const asset = `party-${platform}-${architecture}.tar.gz`;
  const archive = join(releaseDir, asset);
  const tar = spawnSync(commandPath("tar"), ["-czf", archive, "-C", payload, "party"], {
    encoding: "utf8",
  });
  if (tar.status !== 0) throw new Error(`failed to build installer fixture: ${tar.stderr}`);
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(`${archive}.sha256`, `${digest}  ${asset}\n`);

  const realInstall = commandPath("install");
  const realMv = commandPath("mv");
  writeShim(
    join(shims, "install"),
    `printf 'install' >> "$INSTALLER_TRACE"
for arg in "$@"; do printf '\\t%s' "$arg" >> "$INSTALLER_TRACE"; done
printf '\\n' >> "$INSTALLER_TRACE"
[ "\${INSTALLER_INSTALL_MODE:-pass}" = fail ] && exit 1
exec ${realInstall} "$@"`,
  );
  writeShim(
    join(shims, "mv"),
    `printf 'mv' >> "$INSTALLER_TRACE"
for arg in "$@"; do printf '\\t%s' "$arg" >> "$INSTALLER_TRACE"; done
printf '\\n' >> "$INSTALLER_TRACE"
case "\${INSTALLER_MV_MODE:-pass}" in
  fail) exit 42 ;;
  signal) kill -TERM "$PPID"; exit 0 ;;
esac
exec ${realMv} "$@"`,
  );

  return { root, installDir, mirror, shims, target, trace };
}

function runInstaller(fixture: Fixture, extraEnv: Record<string, string> = {}) {
  return spawnSync("/bin/sh", [installScript], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.shims}:${process.env.PATH ?? ""}`,
      AGENTPARTY_INSTALL_DIR: fixture.installDir,
      AGENTPARTY_MIRROR: `file://${fixture.mirror}`,
      AGENTPARTY_VERSION: "0.2.87",
      INSTALLER_TRACE: fixture.trace,
      ...extraEnv,
    },
  });
}

function traceEvents(fixture: Fixture): string[][] {
  return readFileSync(fixture.trace, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

function installedFiles(fixture: Fixture): string[] {
  return readdirSync(fixture.installDir).sort();
}

afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { force: true, recursive: true });
});

describe("install.sh atomic replacement", () => {
  test("stages each binary at a unique 0755 path beside the final target", () => {
    const fixture = makeFixture();

    const first = runInstaller(fixture);
    const second = runInstaller(fixture);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const installEvents = traceEvents(fixture).filter(([command]) => command === "install");
    const destinations = installEvents.map((event) => event.at(-1)!);
    for (const event of installEvents) {
      expect(event).toContain("-m");
      expect(event).toContain("0755");
    }
    expect(destinations).toHaveLength(2);
    expect(new Set(destinations).size).toBe(2);
    for (const staged of destinations) {
      expect(staged).not.toBe(fixture.target);
      expect(dirname(staged)).toBe(fixture.installDir);
      expect(basename(staged)).toMatch(/^\.party\.[A-Za-z0-9]+$/);
    }
    expect(statSync(fixture.target).mode & 0o777).toBe(0o755);
  });

  test("atomically renames the staged binary over the target and leaves no temporary file", () => {
    const fixture = makeFixture();

    const result = runInstaller(fixture);

    expect(result.status).toBe(0);
    const events = traceEvents(fixture);
    const staged = events.find(([command]) => command === "install")!.at(-1)!;
    expect(events.find(([command]) => command === "mv")).toEqual(["mv", "-f", staged, fixture.target]);
    expect(readFileSync(fixture.target, "utf8")).toContain("new party");
    expect(installedFiles(fixture)).toEqual(["party"]);
  });

  test("keeps the copy fallback while still replacing the target atomically", () => {
    const fixture = makeFixture();

    const result = runInstaller(fixture, { INSTALLER_INSTALL_MODE: "fail" });

    expect(result.status).toBe(0);
    const move = traceEvents(fixture).find(([command]) => command === "mv");
    expect(move?.[1]).toBe("-f");
    expect(dirname(move![2])).toBe(fixture.installDir);
    expect(move?.[3]).toBe(fixture.target);
    expect(readFileSync(fixture.target, "utf8")).toContain("new party");
    expect(statSync(fixture.target).mode & 0o777).toBe(0o755);
    expect(installedFiles(fixture)).toEqual(["party"]);
  });

  test("keeps the old target and cleans the staged file when the atomic rename fails", () => {
    const fixture = makeFixture();

    const result = runInstaller(fixture, { INSTALLER_MV_MODE: "fail" });

    expect(result.status).toBe(42);
    expect(readFileSync(fixture.target, "utf8")).toBe("old party\n");
    expect(installedFiles(fixture)).toEqual(["party"]);
  });

  test("cleans the staged file when the installer receives TERM during replacement", () => {
    const fixture = makeFixture();

    const result = runInstaller(fixture, { INSTALLER_MV_MODE: "signal" });

    expect(result.status).toBe(143);
    expect(readFileSync(fixture.target, "utf8")).toBe("old party\n");
    expect(installedFiles(fixture)).toEqual(["party"]);
  });
});
