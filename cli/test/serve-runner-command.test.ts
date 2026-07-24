import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  builtinRunnerCommand,
  resolveBuiltinCodexLaunch,
} from "../src/commands/serve";

describe("builtin runner executable binding", () => {
  test("uses the launchd-persisted absolute executable instead of PATH lookup", () => {
    expect(
      builtinRunnerCommand("codex", {
        PATH: "/usr/bin:/bin",
        AGENTPARTY_RUNNER_BIN: "/Users/leo/.local/bin/codex",
      }),
    ).toBe("/Users/leo/.local/bin/codex");
    expect(
      builtinRunnerCommand("claude", {
        PATH: "/usr/bin:/bin",
        AGENTPARTY_RUNNER_BIN: "/Users/leo/.local/bin/claude",
      }),
    ).toBe("/Users/leo/.local/bin/claude");
  });

  test("keeps terminal-started serve backward compatible when no binding is present", () => {
    expect(builtinRunnerCommand("codex", { PATH: "/custom/bin" })).toBe("codex");
    expect(builtinRunnerCommand("claude", {})).toBe("claude");
  });

  test("rejects a relative explicit binding instead of silently falling back to PATH", () => {
    expect(() =>
      builtinRunnerCommand("codex", { AGENTPARTY_RUNNER_BIN: "./codex" })
    ).toThrow("AGENTPARTY_RUNNER_BIN must be absolute");
  });

  test("Codex preflight preserves flag > Codex env > launchd runner binding priority", () => {
    const cwd = process.cwd();
    const missingCodex = resolve(cwd, "missing-codex-env");
    const missingRunner = resolve(cwd, "missing-runner-binding");
    const explicit = resolveBuiltinCodexLaunch(process.execPath, {
      PATH: "",
      AGENTPARTY_CODEX_BIN: missingCodex,
      AGENTPARTY_RUNNER_BIN: missingRunner,
    }, cwd);
    expect(explicit).toMatchObject({
      ok: true,
      codexBinary: realpathSync(process.execPath),
    });

    const codexEnv = resolveBuiltinCodexLaunch(undefined, {
      PATH: "",
      AGENTPARTY_CODEX_BIN: process.execPath,
      AGENTPARTY_RUNNER_BIN: missingRunner,
    }, cwd);
    expect(codexEnv).toMatchObject({
      ok: true,
      codexBinary: realpathSync(process.execPath),
    });

    const launchdBinding = resolveBuiltinCodexLaunch(undefined, {
      PATH: "",
      AGENTPARTY_RUNNER_BIN: process.execPath,
    }, cwd);
    expect(launchdBinding).toMatchObject({
      ok: true,
      codexBinary: realpathSync(process.execPath),
    });
  });

  test("Codex preflight fails closed on a malformed launchd runner binding", () => {
    expect(
      resolveBuiltinCodexLaunch(undefined, {
        PATH: "/usr/bin:/bin",
        AGENTPARTY_RUNNER_BIN: "./custom-codex",
      }, process.cwd()),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("AGENTPARTY_RUNNER_BIN must be absolute"),
    });
  });
});
