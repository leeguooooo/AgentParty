import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig, writeState, workspaceId } from "../src/config";
import {
  clearStatuslineListener,
  heartbeatPatch,
  readStatuslineCache,
  statuslineCachePath,
  statuslinePreview,
  unreadFromCursor,
  writeStatuslineCache,
} from "../src/statusline-cache";

let home: string;
let cwd: string;
let oldCwd: string;

beforeEach(() => {
  oldCwd = process.cwd();
  home = mkdtempSync(join(tmpdir(), "ap-statusline-"));
  cwd = join(home, "repo", "Agent Party Demo");
  mkdirSync(cwd, { recursive: true });
  process.env.AGENTPARTY_HOME = home;
  process.chdir(cwd);
});

afterEach(() => {
  process.chdir(oldCwd);
  delete process.env.AGENTPARTY_HOME;
  delete process.env.AGENTPARTY_CONFIG;
  rmSync(home, { recursive: true, force: true });
});

describe("workspaceId fixtures", () => {
  test("is stable for statusbar ports", () => {
    expect(workspaceId("/Users/leo/github.com/agentparty")).toBe("agentparty-db745cf4d141394a");
    expect(workspaceId("/tmp/Agent Party Demo")).toBe("agent-party-demo-fe44d3b43c263f52");
    expect(workspaceId("/work/--")).toBe("workspace-b4972acd009ce462");
  });
});

describe("statusline cache contract", () => {
  test("writes statusline.json under the cwd workspace state directory", () => {
    writeStatuslineCache({ channel: "dev", server: "https://agentparty.example" }, cwd, 1234);

    expect(statuslineCachePath(cwd)).toBe(join(home, "state", workspaceId(cwd), "statusline.json"));
    expect(readStatuslineCache(cwd)).toEqual({
      v: 1,
      channel: "dev",
      server: "https://agentparty.example",
      updated_at: 1234,
    });
    expect(statSync(statuslineCachePath(cwd)).mode & 0o777).toBe(0o600);
  });

  test("merges patches and can clear only the listener", () => {
    writeStatuslineCache({ channel: "dev", listener: heartbeatPatch("serve", 1000).listener }, cwd, 1000);
    writeStatuslineCache({ unread: 3 }, cwd, 1100);
    expect(readStatuslineCache(cwd)?.listener).toEqual({ mode: "serve", pid: process.pid, heartbeat_ts: 1000 });
    expect(readStatuslineCache(cwd)?.unread).toBe(3);

    clearStatuslineListener(cwd);
    const next = readStatuslineCache(cwd);
    expect(next?.channel).toBe("dev");
    expect(next?.unread).toBe(3);
    expect(next?.listener).toBeUndefined();
  });

  test("computes unread from the bound workspace cursor", () => {
    writeState({ channel: "dev", cursor: 7 });
    expect(unreadFromCursor(10, "dev")).toBe(3);
    expect(unreadFromCursor(4, "dev")).toBe(0);
    expect(unreadFromCursor(10, "ops")).toBe(10);
  });

  test("explicit AGENTPARTY_CONFIG does not move the statusline cache path", () => {
    const explicit = join(home, "agent.json");
    process.env.AGENTPARTY_CONFIG = explicit;
    writeConfig({ server: "https://agentparty.example", token: "ap_x" });
    writeStatuslineCache({ channel: "dev" }, cwd, 1);

    expect(statuslineCachePath(cwd)).toBe(join(home, "state", workspaceId(cwd), "statusline.json"));
  });

  test("message previews collapse whitespace and cap at 48 characters", () => {
    expect(statuslinePreview("  shipped\n\n the\t auth patch  ")).toBe("shipped the auth patch");
    expect(statuslinePreview("x".repeat(60))).toBe(`${"x".repeat(47)}…`);
  });
});

test("heartbeatPatch carries mentions_only only when asked", () => {
  const on = heartbeatPatch("watch", 1000, { mentionsOnly: true }).listener;
  expect(on.mentions_only).toBe(true);
  const off = heartbeatPatch("watch", 1000, { mentionsOnly: false }).listener;
  expect("mentions_only" in off).toBe(false);
  const legacy = heartbeatPatch("serve", 1000).listener;
  expect("mentions_only" in legacy).toBe(false);
});

test("clearStatuslineListener leaves another live listener's record alone", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ap-"));
  process.env.AGENTPARTY_HOME = mkdtempSync(join(tmpdir(), "ap-home-"));
  // A foreign listener (different pid) heartbeat-wrote the record.
  writeStatuslineCache(
    { channel: "dev", listener: { mode: "watch", pid: process.pid + 1, heartbeat_ts: 1000 } },
    cwd,
    1000,
  );
  const after = clearStatuslineListener(cwd);
  expect(after.listener?.pid).toBe(process.pid + 1);
  // Our own record does get cleared.
  writeStatuslineCache(
    { channel: "dev", listener: { mode: "watch", pid: process.pid, heartbeat_ts: 2000 } },
    cwd,
    2000,
  );
  const cleared = clearStatuslineListener(cwd);
  expect(cleared.listener).toBeUndefined();
});
