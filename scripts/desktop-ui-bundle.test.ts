import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createDesktopUiBundle } from "./desktop-ui-bundle";

const cleanup: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(directory);
  return directory;
}

function makeUiTree(root: string, reverse = false): void {
  const files = reverse
    ? [["assets/app.js", "console.log('ui')\n"], ["index.html", "<main>AgentParty</main>\n"]]
    : [["index.html", "<main>AgentParty</main>\n"], ["assets/app.js", "console.log('ui')\n"]];
  mkdirSync(join(root, "assets"), { recursive: true });
  for (const [name, contents] of files) writeFileSync(join(root, name), contents);
}

afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { force: true, recursive: true });
});

describe("createDesktopUiBundle", () => {
  test("produces byte-identical archives for identical trees regardless of file metadata", () => {
    const firstSource = temporaryDirectory("desktop-ui-source-a-");
    const secondSource = temporaryDirectory("desktop-ui-source-b-");
    const firstOutput = join(temporaryDirectory("desktop-ui-output-a-"), "agentparty-desktop-ui-v1.4.0.tar.gz");
    const secondOutput = join(temporaryDirectory("desktop-ui-output-b-"), "agentparty-desktop-ui-v1.4.0.tar.gz");
    makeUiTree(firstSource);
    makeUiTree(secondSource, true);
    utimesSync(join(secondSource, "index.html"), new Date("2030-01-01"), new Date("2030-01-01"));

    const first = createDesktopUiBundle({ source: firstSource, output: firstOutput });
    const second = createDesktopUiBundle({ source: secondSource, output: secondOutput });

    expect(readFileSync(firstOutput)).toEqual(readFileSync(secondOutput));
    expect(first.sha256).toBe(second.sha256);
    expect(readFileSync(`${firstOutput}.sha256`, "utf8")).toBe(`${first.sha256}  agentparty-desktop-ui-v1.4.0.tar.gz\n`);
  });

  test("creates a standard root-level archive and hashes the exact bytes", () => {
    const source = temporaryDirectory("desktop-ui-source-");
    const output = join(temporaryDirectory("desktop-ui-output-"), "agentparty-desktop-ui-v1.4.0.tar.gz");
    makeUiTree(source);

    const result = createDesktopUiBundle({ source, output });
    const entries = execFileSync("tar", ["-tzf", output], { encoding: "utf8" }).trim().split("\n");
    const actualHash = createHash("sha256").update(readFileSync(output)).digest("hex");

    expect(entries).toEqual(["assets/", "assets/app.js", "index.html"]);
    expect(result).toEqual({ archive: output, checksum: `${output}.sha256`, sha256: actualHash });
  });

  test("rejects empty input trees and symbolic links", () => {
    const emptySource = temporaryDirectory("desktop-ui-empty-");
    const emptyOutput = join(temporaryDirectory("desktop-ui-output-"), "ui.tar.gz");
    expect(() => createDesktopUiBundle({ source: emptySource, output: emptyOutput })).toThrow("Desktop UI source is empty");

    const linkedSource = temporaryDirectory("desktop-ui-linked-");
    writeFileSync(join(linkedSource, "index.html"), "ok");
    execFileSync("ln", ["-s", "index.html", join(linkedSource, "latest.html")]);
    expect(() => createDesktopUiBundle({ source: linkedSource, output: emptyOutput })).toThrow("Symbolic links are not supported");
  });
});
