import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const installer = readFileSync(resolve(import.meta.dir, "../install-desktop.sh"), "utf8");
const readme = readFileSync(resolve(import.meta.dir, "../README.md"), "utf8");

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function runInstaller(failReplacement: boolean, preview = false, allowUnnotarized = false) {
  const root = mkdtempSync(resolve(tmpdir(), "desktop-installer-"));
  const bin = resolve(root, "bin");
  const assets = resolve(root, "assets");
  const mount = resolve(root, "mount");
  const appDir = resolve(root, "Applications");
  const app = resolve(mount, "AgentParty.app");
  mkdirSync(resolve(app, "Contents/MacOS"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(assets, { recursive: true });
  mkdirSync(resolve(appDir, "AgentParty.app"), { recursive: true });
  writeFileSync(resolve(appDir, "AgentParty.app/old-marker"), "old");
  writeFileSync(resolve(app, "Contents/Info.plist"), "fixture");
  executable(resolve(app, "Contents/MacOS/party"), "echo 0.2.90");
  const dmg = "agentparty-desktop-darwin-arm64.dmg";
  const status = "agentparty-desktop-darwin-arm64.signing-status.json";
  const dmgBytes = "production-dmg";
  const dmgHash = createHash("sha256").update(dmgBytes).digest("hex");
  writeFileSync(resolve(assets, dmg), dmgBytes);
  writeFileSync(
    resolve(assets, `${dmg}.sha256`),
    `${dmgHash}  ${dmg}\n`,
  );
  writeFileSync(resolve(assets, status), "{}");

  executable(resolve(bin, "uname"), '[ "$1" = "-s" ] && echo Darwin || echo arm64');
  executable(resolve(bin, "curl"), 'for last; do :; done; cp "$FIXTURE_ASSETS/$(basename "$2")" "$last" 2>/dev/null || cp "$FIXTURE_ASSETS/$(basename "$1")" "$last"');
  executable(resolve(bin, "shasum"), 'echo "$FIXTURE_DMG_HASH  $3"');
  executable(resolve(bin, "hdiutil"), 'case "$1" in attach) printf "/dev/disk9s1\\tApple_HFS\\t%s\\n" "$FIXTURE_MOUNT" ;; esac; exit 0');
  executable(resolve(bin, "plutil"), 'case "$2" in notarized) [ "${FIXTURE_PREVIEW:-0}" = 1 ] && echo false || echo true ;; distribution) [ "${FIXTURE_PREVIEW:-0}" = 1 ] && echo preview || echo production ;; notarization_auth) [ "${FIXTURE_PREVIEW:-0}" = 1 ] && echo none || echo api-key ;; CFBundleShortVersionString) echo 0.2.90 ;; *) exit 1 ;; esac');
  executable(resolve(bin, "xcrun"), "exit 0");
  executable(resolve(bin, "spctl"), "exit 0");
  executable(resolve(bin, "codesign"), 'case "$1" in -dv) echo "Authority=Developer ID Application: AgentParty Inc. (TEAM123456)" >&2 ;; esac; exit 0');
  executable(resolve(bin, "xattr"), 'printf "%s\\n" "$*" > "$FIXTURE_XATTR_LOG"');
  executable(resolve(bin, "pgrep"), "exit 1");
  executable(resolve(bin, "sleep"), "exit 0");
  if (failReplacement) {
    executable(resolve(bin, "mv"), 'case "$1" in *.AgentParty.app.new.*) exit 1 ;; esac; PATH=/usr/bin:/bin exec mv "$@"');
  }

  const result = spawnSync("sh", [resolve(import.meta.dir, "../install-desktop.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      AGENTPARTY_VERSION: "0.2.90",
      AGENTPARTY_APP_DIR: appDir,
      FIXTURE_ASSETS: assets,
      FIXTURE_MOUNT: mount,
      FIXTURE_DMG_HASH: dmgHash,
      FIXTURE_PREVIEW: preview ? "1" : "0",
      FIXTURE_XATTR_LOG: resolve(root, "xattr.log"),
      AGENTPARTY_ALLOW_UNNOTARIZED: allowUnnotarized ? "1" : "0",
    },
  });
  return { root, appDir, result };
}

describe("macOS desktop installer", () => {
  test("never ad-hoc re-signs a downloaded app and scopes quarantine removal to preview mode", () => {
    expect(installer).not.toMatch(/codesign[^\n]*--sign\s+-/);
    expect(installer).toContain('xattr -dr com.apple.quarantine "$stage"');
    expect(installer).toContain('[ "$preview" = "0" ]');
  });

  test("requires explicit opt-in before mounting or copying a preview", () => {
    const productionGate = installer.indexOf('[ "$ALLOW_UNNOTARIZED" = "1" ]');
    const mount = installer.indexOf('hdiutil attach "$tmp/$dmg"');
    const copy = installer.indexOf('cp -R "$src" "$stage"');
    expect(productionGate).toBeGreaterThan(0);
    expect(productionGate).toBeLessThan(mount);
    expect(mount).toBeLessThan(copy);
    expect(installer).toContain('[ "$notarized" = "true" ]');
    expect(installer).toContain("apple-id|api-key");
    expect(readme).toContain("AGENTPARTY_ALLOW_UNNOTARIZED=1");
  });

  test("verifies both the DMG and staged app with Apple security tools", () => {
    expect(installer).toContain('xcrun stapler validate "$tmp/$dmg"');
    expect(installer).toContain('spctl --assess --type open --context context:primary-signature "$tmp/$dmg"');
    expect(installer).toContain('codesign --verify --deep --strict --verbose=2 "$stage"');
    expect(installer).toContain("^Authority=Developer ID Application:");
    expect(installer).toContain('xcrun stapler validate "$stage"');
    expect(installer).toContain('spctl --assess --type execute "$stage"');
  });

  test("stages and validates before backing up or replacing the installed app", () => {
    const stageCopy = installer.indexOf('cp -R "$src" "$stage"');
    const gatekeeper = installer.indexOf('spctl --assess --type execute "$stage"');
    const backup = installer.indexOf('mv "$dst" "$backup"');
    const replacement = installer.indexOf('mv "$stage" "$dst"');
    expect(stageCopy).toBeLessThan(gatekeeper);
    expect(gatekeeper).toBeLessThan(backup);
    expect(backup).toBeLessThan(replacement);
    expect(installer).toContain('mv "$backup" "$dst"');
  });

  test("installs a fully verified production fixture through the real shell flow", () => {
    const run = runInstaller(false);
    try {
      expect(run.result.status).toBe(0);
      expect(readFileSync(resolve(run.appDir, "AgentParty.app/Contents/MacOS/party"), "utf8")).toContain("0.2.90");
      expect(() => readFileSync(resolve(run.appDir, "AgentParty.app/old-marker"))).toThrow();
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  });

  test("restores the old app when the staged replacement move fails", () => {
    const run = runInstaller(true);
    try {
      expect(run.result.status).not.toBe(0);
      expect(readFileSync(resolve(run.appDir, "AgentParty.app/old-marker"), "utf8")).toBe("old");
      expect(run.result.stderr).toContain("已尝试恢复旧版本");
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  });

  test("rejects an unnotarized preview without explicit consent", () => {
    const run = runInstaller(false, true, false);
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("AGENTPARTY_ALLOW_UNNOTARIZED=1");
      expect(readFileSync(resolve(run.appDir, "AgentParty.app/old-marker"), "utf8")).toBe("old");
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  });

  test("installs an unnotarized preview after explicit consent", () => {
    const run = runInstaller(false, true, true);
    try {
      expect(run.result.status).toBe(0);
      expect(readFileSync(resolve(run.root, "xattr.log"), "utf8")).toContain("com.apple.quarantine");
      expect(readFileSync(resolve(run.appDir, "AgentParty.app/Contents/MacOS/party"), "utf8")).toContain("0.2.90");
      expect(run.result.stderr).toContain("未经 Apple Developer ID 签名和公证");
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  });
});
