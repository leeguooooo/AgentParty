import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { createDesktopUiBundle } from "./desktop-ui-bundle";
import {
  buildDesktopUiManifest,
  buildSignedDesktopUiManifest,
  runDesktopUiManifestCli,
} from "./desktop-ui-manifest";

const cleanup: string[] = [];

function makeArtifacts() {
  const directory = mkdtempSync(join(tmpdir(), "desktop-ui-manifest-"));
  cleanup.push(directory);
  const archive = join(directory, "agentparty-desktop-ui-v1.4.0.tar.gz");
  const source = join(directory, "source");
  mkdirSync(source);
  writeFileSync(join(source, "index.html"), "<main>AgentParty</main>");
  mkdirSync(join(source, "assets"));
  writeFileSync(join(source, "assets", "app.js"), "console.log('ui')");
  createDesktopUiBundle({ source, output: archive });
  const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(`${archive}.sig`, "trusted minisign signature\n");
  return { directory, archive, sha256 };
}

afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { force: true, recursive: true });
});

describe("buildDesktopUiManifest", () => {
  test("describes the fixed desktop-ui release channel and signed versioned archive", () => {
    const { archive, sha256 } = makeArtifacts();
    const manifest = buildDesktopUiManifest({
      version: "1.4.0",
      uiAbi: 2,
      minShellVersion: "0.2.94",
      buildId: "933a665e06f3b3dcb1d45f9cccbad0be83581637",
      publishedAt: "2026-07-11T07:30:00Z",
      repo: "leeguooooo/agentparty",
      archive,
    });

    expect(manifest).toEqual({
      schema: 1,
      version: "1.4.0",
      ui_abi: 2,
      min_shell_version: "0.2.94",
      build_id: "933a665e06f3b3dcb1d45f9cccbad0be83581637",
      published_at: "2026-07-11T07:30:00Z",
      archive: {
        name: "agentparty-desktop-ui-v1.4.0.tar.gz",
        url: "https://github.com/leeguooooo/agentparty/releases/download/desktop-ui/agentparty-desktop-ui-v1.4.0.tar.gz",
        sizeBytes: readFileSync(archive).length,
        fileCount: 2,
        sha256,
        signature: "trusted minisign signature\n",
      },
      entrypoint: "index.html",
    });
  });

  test("preserves the exact signed payload bytes in a base64 envelope", () => {
    const payload = Buffer.from('{"published_at":"2026-07-11T07:30:00Z","ui_abi":1}');
    expect(buildSignedDesktopUiManifest(payload, "manifest signature\n")).toEqual({
      payload: payload.toString("base64"),
      signature: "manifest signature\n",
    });
  });

  test("fails closed on checksum drift, missing signatures, and invalid release metadata", () => {
    const { archive } = makeArtifacts();
    const valid = {
      version: "1.4.0",
      uiAbi: 2,
      minShellVersion: "0.2.94",
      buildId: "933a665e06f3b3dcb1d45f9cccbad0be83581637",
      publishedAt: "2026-07-11T07:30:00Z",
      repo: "leeguooooo/agentparty",
      archive,
    };

    writeFileSync(`${archive}.sha256`, `${"0".repeat(64)}  ${basename(archive)}\n`);
    expect(() => buildDesktopUiManifest(valid)).toThrow("Desktop UI checksum does not match archive");

    const wrongName = makeArtifacts();
    writeFileSync(`${wrongName.archive}.sha256`, `${wrongName.sha256}  stale-ui.tar.gz\n`);
    expect(() => buildDesktopUiManifest({ ...valid, archive: wrongName.archive })).toThrow(
      "Desktop UI checksum does not name archive",
    );

    const second = makeArtifacts();
    rmSync(`${second.archive}.sig`);
    expect(() => buildDesktopUiManifest({ ...valid, archive: second.archive })).toThrow("Missing Desktop UI signature");
    expect(() => buildDesktopUiManifest({ ...valid, archive: makeArtifacts().archive, version: "v1.4.0" })).toThrow("Invalid Desktop UI version");
    expect(() => buildDesktopUiManifest({ ...valid, archive: makeArtifacts().archive, publishedAt: "2026-07-11" })).toThrow("Invalid Desktop UI publication date");
    expect(() => buildDesktopUiManifest({ ...valid, archive: makeArtifacts().archive, uiAbi: 0 })).toThrow("Invalid Desktop UI ABI: 0");
    expect(() => buildDesktopUiManifest({ ...valid, archive: makeArtifacts().archive, uiAbi: 65536 })).toThrow("Invalid Desktop UI ABI: 65536");
    expect(() => buildDesktopUiManifest({ ...valid, archive: makeArtifacts().archive, uiAbi: 1.5 })).toThrow("Invalid Desktop UI ABI: 1.5");
  });
});

describe("desktop UI manifest CLI", () => {
  test("writes canonical signing bytes to the requested output", () => {
    const { directory, archive } = makeArtifacts();
    const payload = join(directory, "desktop-ui.payload.json");
    runDesktopUiManifestCli([
      "--version", "1.4.0",
      "--ui-abi", "2",
      "--min-shell-version", "0.2.94",
      "--build-id", "933a665e06f3b3dcb1d45f9cccbad0be83581637",
      "--published-at", "2026-07-11T07:30:00Z",
      "--repo", "leeguooooo/agentparty",
      "--archive", archive,
      "--output", payload,
    ]);

    const expected = buildDesktopUiManifest({
      version: "1.4.0",
      uiAbi: 2,
      minShellVersion: "0.2.94",
      buildId: "933a665e06f3b3dcb1d45f9cccbad0be83581637",
      publishedAt: "2026-07-11T07:30:00Z",
      repo: "leeguooooo/agentparty",
      archive,
    });
    expect(readFileSync(payload, "utf8")).toBe(JSON.stringify(expected));
  });

  test("rejects non-canonical ABI text instead of coercing it", () => {
    const { directory, archive } = makeArtifacts();
    for (const uiAbi of ["01", "1e2", "1.0", "+1"]) {
      expect(() => runDesktopUiManifestCli([
        "--version", "1.4.0",
        "--ui-abi", uiAbi,
        "--min-shell-version", "0.2.94",
        "--build-id", "933a665e06f3b3dcb1d45f9cccbad0be83581637",
        "--published-at", "2026-07-11T07:30:00Z",
        "--repo", "leeguooooo/agentparty",
        "--archive", archive,
        "--output", join(directory, `${uiAbi}.json`),
      ])).toThrow(`Invalid Desktop UI ABI: ${uiAbi}`);
    }
  });

  test("wraps a payload file without parsing or reserializing it", () => {
    const directory = makeArtifacts().directory;
    const payload = join(directory, "manifest.payload.json");
    const signature = `${payload}.sig`;
    const output = join(directory, "desktop-ui.json");
    writeFileSync(payload, '{ "deliberate" : "spacing" }');
    writeFileSync(signature, "manifest signature\n");

    runDesktopUiManifestCli([
      "--payload", payload,
      "--signature", signature,
      "--output", output,
    ]);

    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({
      payload: Buffer.from('{ "deliberate" : "spacing" }').toString("base64"),
      signature: "manifest signature\n",
    });
  });
});
