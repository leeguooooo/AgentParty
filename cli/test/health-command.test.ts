import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/commands/health";
import { writeHealthCache } from "../src/health-cache";

let home: string;
let cwd: string;
let oldHome: string | undefined;
let oldCwd: string;
let logs: string[];
let errs: string[];
let oldLog: typeof console.log;
let oldError: typeof console.error;

beforeEach(() => {
  oldCwd = process.cwd();
  oldHome = process.env.AGENTPARTY_HOME;
  home = mkdtempSync(join(tmpdir(), "ap-health-cmd-"));
  cwd = join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  process.env.AGENTPARTY_HOME = home;
  process.chdir(cwd);
  logs = [];
  errs = [];
  oldLog = console.log;
  oldError = console.error;
  console.log = (line?: unknown) => logs.push(String(line));
  console.error = (line?: unknown) => errs.push(String(line));
});

afterEach(() => {
  process.chdir(oldCwd);
  console.log = oldLog;
  console.error = oldError;
  if (oldHome === undefined) delete process.env.AGENTPARTY_HOME;
  else process.env.AGENTPARTY_HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});

describe("party health", () => {
  test("exits 1 with no health record", async () => {
    const code = await run([]);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("no health record");
  });

  test("exits 0 and reports healthy for a fresh, connected record", async () => {
    writeHealthCache({ channel: "dev", ws_connected: true, last_frame_at: Date.now(), reconnecting: false }, cwd);
    const code = await run(["--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(logs.join(""));
    expect(report.healthy).toBe(true);
    expect(report.stale).toBe(false);
  });

  test("exits 2 when stale (last_frame_at older than --stale-after)", async () => {
    writeHealthCache({ channel: "dev", ws_connected: true, last_frame_at: Date.now() - 200_000, reconnecting: false }, cwd);
    const code = await run(["--json", "--stale-after", "1000"]);
    expect(code).toBe(2);
    const report = JSON.parse(logs.join(""));
    expect(report.stale).toBe(true);
    expect(report.healthy).toBe(false);
  });

  test("exits 2 while reconnecting even if ws_connected was true before", async () => {
    writeHealthCache({ channel: "dev", ws_connected: false, reconnecting: true, last_frame_at: Date.now() }, cwd);
    const code = await run(["--json"]);
    expect(code).toBe(2);
  });

  test("exits 2 on channel mismatch", async () => {
    writeHealthCache({ channel: "dev", ws_connected: true, reconnecting: false, last_frame_at: Date.now() }, cwd);
    const code = await run(["--channel", "ops", "--json"]);
    expect(code).toBe(2);
  });

  test("text output includes a one-line operator hint", async () => {
    writeHealthCache({ channel: "dev", ws_connected: false, reconnecting: true, reconnect_count: 3 }, cwd);
    const code = await run([]);
    expect(code).toBe(2);
    expect(logs.join("\n")).toContain("reconnecting (3 time(s) so far)");
  });

  test("rejects a non-positive --stale-after", async () => {
    const code = await run(["--stale-after", "0"]);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("--stale-after must be a positive number");
  });
});
