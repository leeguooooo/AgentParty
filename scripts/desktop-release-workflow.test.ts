import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(resolve(import.meta.dir, "../.github/workflows/release.yml"), "utf8");
const desktopDocs = readFileSync(
  resolve(import.meta.dir, "../web/public/docs/desktop/index.html"),
  "utf8",
);
const tauriConfig = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../desktop/src-tauri/tauri.conf.json"), "utf8"),
);
const desktopCapability = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../desktop/src-tauri/capabilities/default.json"), "utf8"),
);
const desktopJob = workflow.slice(workflow.indexOf("  desktop:"), workflow.indexOf("  release:"));
const releaseJob = workflow.slice(workflow.indexOf("  release:"));

function namedStep(job: string, name: string, nextName: string): string {
  return job.slice(job.indexOf(`      - name: ${name}`), job.indexOf(`      - name: ${nextName}`));
}

describe("desktop release workflow", () => {
  test("hands every signed updater artifact to the release job", () => {
    expect(workflow).toMatch(/^\s+path: agentparty-desktop-\*\s*$/m);
    expect(workflow).toContain("agentparty-desktop-${ASSET}.app.tar.gz");
    expect(workflow).toContain('cp "${updater}.sig" "${updater_out}.sig"');
    expect(workflow).toContain('[ ! -s "$dmg" ] || [ ! -s "$updater" ] || [ ! -s "${updater}.sig" ]');
  });

  test("requires the signing key and publishes a static updater manifest", () => {
    expect(workflow).toContain("secrets.TAURI_SIGNING_PRIVATE_KEY");
    expect(workflow).toContain("secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD");
    expect(workflow).toContain("bun scripts/desktop-update-manifest.ts");
    expect(workflow).toContain("--output dist/latest.json");
    expect(workflow).toContain("dist/latest.json");
  });

  test("allows the desktop shell to receive notification click actions", () => {
    expect(desktopCapability.permissions).toContain("notification:allow-register-listener");
  });

  test("ships the desktop webview with a restrictive content security policy", () => {
    const csp = tauriConfig.app.security.csp;
    expect(typeof csp).toBe("string");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-eval'");
  });

  test("fails closed unless updater key mode is legacy, bridge, or v2", () => {
    expect(desktopJob).toContain('mode="${DESKTOP_UPDATER_KEY_MODE:-}"');
    expect(desktopJob).toContain("legacy|bridge|v2)");
    expect(desktopJob).toContain("invalid DESKTOP_UPDATER_KEY_MODE");
    expect(releaseJob).toContain('mode="${DESKTOP_UPDATER_KEY_MODE:-}"');
    expect(releaseJob).toContain("legacy|bridge|v2)");
  });

  test("keeps the old key out of v2 builds and requires both key generations for bridge", () => {
    expect(desktopJob).toContain("id: updater-key-mode");
    expect(desktopJob).toContain("require legacy updater signing key");
    expect(desktopJob).toContain("steps.updater-key-mode.outputs.mode != 'v2'");
    expect(desktopJob).toContain("require v2 updater signing key");
    expect(desktopJob).toContain("TAURI_SIGNING_PRIVATE_KEY_V2: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_V2 }}");
    expect(desktopJob).toContain("TAURI_SIGNING_PRIVATE_KEY_PASSWORD_V2: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD_V2 }}");
    expect(desktopJob).toContain("build notarized desktop app with v2 updater key");
    expect(desktopJob).toContain("build unnotarized desktop preview with v2 updater key");
    expect(desktopJob).toContain("if: steps.apple-signing.outputs.enabled == 'true' && steps.updater-key-mode.outputs.mode == 'v2'");
    expect(desktopJob).toContain("if: steps.apple-signing.outputs.enabled == 'false' && steps.updater-key-mode.outputs.mode == 'v2'");

    const notarizedV2 = namedStep(
      desktopJob,
      "build notarized desktop app with v2 updater key",
      "build unnotarized desktop preview with legacy updater key",
    );
    const previewV2 = namedStep(
      desktopJob,
      "build unnotarized desktop preview with v2 updater key",
      "verify Developer ID signature and notarization ticket",
    );
    for (const v2Build of [notarizedV2, previewV2]) {
      expect(v2Build).toContain("secrets.TAURI_SIGNING_PRIVATE_KEY_V2");
      expect(v2Build).not.toContain("secrets.TAURI_SIGNING_PRIVATE_KEY }}");
      expect(v2Build).not.toContain("secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}");
    }
  });

  test("dual-signs bridge archives and publishes both updater channels", () => {
    expect(tauriConfig.plugins.updater.endpoints).toEqual([
      "https://github.com/leeguooooo/agentparty/releases/latest/download/latest-v2.json",
    ]);
    expect(desktopJob).toContain("name: sign bridge updater with v2 key");
    expect(desktopJob).toContain('mv "${updater}.sig" "${updater}.sig.v2"');
    expect(desktopJob).toContain('cp "${updater}.sig.v2" "${updater_out}.sig.v2"');
    expect(releaseJob).toContain('generate_manifest dist/latest.json ".sig"');
    expect(releaseJob).toContain('generate_manifest dist/latest-v2.json ".sig.v2"');
    expect(releaseJob).toContain('--signature-suffix "$signature_suffix"');
    expect(releaseJob).toContain("dist/latest-v2.json");
    expect(releaseJob).toContain("dist/*.tar.gz.sig.v2");
    expect(releaseJob).not.toMatch(/environment:\s*\n\s+name: release/);
  });

  test("pins the legacy channel to the configured bridge release in v2 mode", () => {
    expect(desktopJob).toContain("DESKTOP_UPDATER_BRIDGE_TAG: ${{ vars.DESKTOP_UPDATER_BRIDGE_TAG }}");
    expect(desktopJob).toContain("DESKTOP_UPDATER_BRIDGE_TAG is required");
    expect(desktopJob).toContain("bridge mode requires DESKTOP_UPDATER_BRIDGE_TAG to equal the release tag");
    expect(releaseJob).toContain('gh release download "$DESKTOP_UPDATER_BRIDGE_TAG"');
    expect(releaseJob).toContain("--pattern latest.json");
    expect(releaseJob).toContain("--output dist/latest.json");
    expect(releaseJob).toContain("encoded_bridge_tag=");
    expect(releaseJob).toContain("legacy updater manifest does not point to the configured bridge tag");
  });

  test("records updater key mode and rejects architecture or configuration drift", () => {
    expect(desktopJob).toContain('"updater_key_mode":"%s"');
    expect(releaseJob).toContain("map({notarized, distribution, updater_key_mode})");
    expect(releaseJob).toContain("desktop architectures disagree on signing status or updater key mode");
    expect(releaseJob).toContain("desktop updater key mode does not match release configuration");
  });

  test("gates desktop distribution and falls back to an honest unnotarized preview", () => {
    expect(tauriConfig.bundle.macOS.signingIdentity).not.toBe("-");
    expect(workflow).toMatch(/desktop:\n(?:[\s\S]*?)environment:\n\s+name: release/);
    expect(workflow).toContain("id: apple-signing");
    expect(workflow).toContain("vars.DESKTOP_REQUIRE_NOTARIZATION");
    expect(workflow).toContain("DESKTOP_REQUIRE_NOTARIZATION must be true or false");
    expect(workflow).toContain("Apple signing is required; missing:");
    expect(workflow).toContain('echo "enabled=false" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain("if: steps.apple-signing.outputs.enabled == 'true'");
    expect(workflow).toContain("if: steps.apple-signing.outputs.enabled == 'false'");
    for (const secret of [
      "APPLE_CERTIFICATE",
      "APPLE_CERTIFICATE_PASSWORD",
      "APPLE_ID",
      "APPLE_PASSWORD",
      "APPLE_TEAM_ID",
      "KEYCHAIN_PASSWORD",
    ]) {
      expect(workflow).toContain(`secrets.${secret}`);
    }
    expect(workflow).toContain("security find-identity -v -p codesigning");
    expect(workflow).toContain("spctl --assess --type execute");
    expect(workflow).toContain("xcrun stapler validate");
    expect(workflow).not.toContain('xcrun notarytool submit "$dmg"');
    expect(workflow).not.toContain('xcrun stapler staple "$dmg"');
    expect(workflow).toContain('xcrun stapler validate "$dmg"');
    expect(workflow).toContain('spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg"');
    expect(workflow).toContain("agentparty-desktop-${ASSET}.signing-status.json");
    expect(workflow).toContain("dist/release-body.md");
    expect(workflow).toContain("--notes \"$DESKTOP_RELEASE_NOTES\"");
    expect(workflow).toContain("dist/*.signing-status.json");

    expect(desktopDocs).toContain("Unnotarized macOS preview");
    expect(desktopDocs).toContain("正式下载入口仍处于准备中");
  });

  test("uses commands available on GitHub macOS runners for certificate import", () => {
    expect(workflow).toContain("security list-keychains -d user");
    expect(workflow).not.toContain("-maxdepth");
  });

  test("requires the tag, CLI package, and desktop package versions to match", () => {
    expect(workflow).toContain('TAG_VERSION="${GITHUB_REF_NAME#v}"');
    expect(workflow).toContain('CLI_VERSION=$(bun -e');
    expect(workflow).toContain('DESKTOP_VERSION=$(bun -e');
    expect(workflow).toContain('"$TAG_VERSION" = "$CLI_VERSION"');
    expect(workflow).toContain('"$TAG_VERSION" = "$DESKTOP_VERSION"');
  });

  test("keeps prereleases out of the stable latest updater channel", () => {
    expect(workflow).toContain('VERSION_WITHOUT_BUILD="${VERSION%%+*}"');
    expect(workflow).toContain('if [[ "$VERSION_WITHOUT_BUILD" == *-* ]]');
    expect(workflow).toContain("prerelease: ${{ steps.release-channel.outputs.prerelease }}");
    expect(workflow).toContain("make_latest: ${{ steps.release-channel.outputs.make_latest }}");
  });

  test("appends GitHub generated changelog entries to the release distribution notice", () => {
    expect(releaseJob).toContain("name: generate release changelog");
    expect(releaseJob).toContain("GH_TOKEN: ${{ github.token }}");
    expect(releaseJob).toContain("repos/$GITHUB_REPOSITORY/releases/generate-notes");
    expect(releaseJob).toContain('--arg tag_name "$GITHUB_REF_NAME"');
    expect(releaseJob).toContain("dist/generated-release-notes.md");
    expect(releaseJob).toContain('cat dist/generated-release-notes.md >> dist/release-body.md');
  });
});
