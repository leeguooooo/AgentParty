import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEPRECATION_NOTICE,
  DEPRECATION_NOTICE_TTL_MS,
  deprecationNoticePath,
  maybePrintDeprecationNotice,
} from "../src/deprecation-notice";

let home: string;
let lines: string[];
const env = {} as NodeJS.ProcessEnv;
const opts = (now = 1_000_000) => ({ env, home, now, errlog: (t: string) => lines.push(t) });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-deprecation-"));
  lines = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("Agent Party deprecation notice", () => {
  test("states the 2026-10-31 shutdown, points to open-cross-session with the install line and the uninstall guide", () => {
    expect(DEPRECATION_NOTICE).toContain("will shut down on 2026-10-31");
    expect(DEPRECATION_NOTICE).toContain("agentparty.leeguoo.com");
    expect(DEPRECATION_NOTICE).toContain("https://github.com/leeguooooo/agentparty/blob/main/docs/uninstall.md");
    expect(DEPRECATION_NOTICE).toContain("https://github.com/leeguooooo/open-cross-session");
    expect(DEPRECATION_NOTICE).toContain(
      "curl -fsSL https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.sh | sh",
    );
  });

  test("interactive command prints once, then is throttled for 24h", () => {
    expect(maybePrintDeprecationNotice("send", ["hi"], opts())).toBe(true);
    expect(lines).toEqual([DEPRECATION_NOTICE]);
    expect(existsSync(deprecationNoticePath(home))).toBe(true);
    expect(maybePrintDeprecationNotice("who", [], opts(1_000_000 + DEPRECATION_NOTICE_TTL_MS - 1))).toBe(false);
    expect(maybePrintDeprecationNotice("who", [], opts(1_000_000 + DEPRECATION_NOTICE_TTL_MS))).toBe(true);
    expect(lines).toHaveLength(2);
  });

  test("machine-readable and help invocations stay silent (stdout/JSON never touched, stderr quiet)", () => {
    for (const args of [["--json"], ["--json=1"], ["--help"], ["-h"]]) {
      expect(maybePrintDeprecationNotice("whoami", args, opts())).toBe(false);
    }
    expect(lines).toEqual([]);
    // `--` 之后是透传参数，不算我们的 --json
    expect(maybePrintDeprecationNotice("worktree", ["--", "--json"], opts())).toBe(true);
  });

  test("harness / resident entry points never print", () => {
    for (const cmd of ["mcp", "hook", "serve", "daemon", "watch", "bridge", "claude", "claude-channel", "statusline", "notify-when-idle", "capture"]) {
      expect(maybePrintDeprecationNotice(cmd, [], opts())).toBe(false);
    }
    expect(lines).toEqual([]);
    expect(existsSync(deprecationNoticePath(home))).toBe(false);
  });

  test("AGENTPARTY_NO_DEPRECATION_NOTICE=1 silences it", () => {
    const quiet = { ...opts(), env: { AGENTPARTY_NO_DEPRECATION_NOTICE: "1" } as NodeJS.ProcessEnv };
    expect(maybePrintDeprecationNotice("send", [], quiet)).toBe(false);
    expect(lines).toEqual([]);
  });

  test("an unwritable home still prints (fails visible) and never throws", () => {
    const bad = { ...opts(), home: join(home, "\0bad") };
    expect(maybePrintDeprecationNotice("send", [], bad)).toBe(true);
  });
});
