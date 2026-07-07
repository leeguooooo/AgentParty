import { describe, expect, test } from "bun:test";
import { compareVersions, maybeReexecUpgrade, pendingUpgrade } from "../src/upgrade";

describe("upgrade", () => {
  test("compareVersions orders by numeric segments", () => {
    expect(compareVersions("0.2.61", "0.2.60")).toBe(1);
    expect(compareVersions("0.2.60", "0.2.61")).toBe(-1);
    expect(compareVersions("0.2.61", "0.2.61")).toBe(0);
    expect(compareVersions("0.3.0", "0.2.99")).toBe(1);
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
  });

  test("pendingUpgrade returns the on-disk version only when it is newer", () => {
    const deps = {
      runningVersion: "0.2.60",
      execPath: "/usr/local/bin/party",
      readInstalledVersion: () => "0.2.61",
    };
    expect(pendingUpgrade(deps)).toBe("0.2.61");
    expect(pendingUpgrade({ ...deps, readInstalledVersion: () => "0.2.60" })).toBeNull();
    expect(pendingUpgrade({ ...deps, readInstalledVersion: () => "0.2.59" })).toBeNull();
  });

  test("pendingUpgrade skips when execPath is not a party binary (dev / bun)", () => {
    expect(
      pendingUpgrade({ runningVersion: "0.2.60", execPath: "/opt/homebrew/bin/bun", readInstalledVersion: () => "9.9.9" }),
    ).toBeNull();
  });

  test("pendingUpgrade skips when the on-disk version is unreadable", () => {
    expect(
      pendingUpgrade({ runningVersion: "0.2.60", execPath: "/usr/local/bin/party", readInstalledVersion: () => null }),
    ).toBeNull();
  });

  test("maybeReexecUpgrade only re-execs when auto is on and a newer version exists", () => {
    const calls: Array<{ path: string; argv: string[] }> = [];
    const deps = {
      runningVersion: "0.2.60",
      execPath: "/usr/local/bin/party",
      readInstalledVersion: () => "0.2.61",
      reexec: (path: string, argv: string[]) => calls.push({ path, argv }),
    };
    // auto off: reports pending, does not re-exec
    expect(maybeReexecUpgrade(false, deps)).toEqual({ pending: "0.2.61", reexeced: false });
    expect(calls).toHaveLength(0);
    // auto on: re-execs
    expect(maybeReexecUpgrade(true, deps)).toEqual({ pending: "0.2.61", reexeced: true });
    expect(calls[0]!.path).toBe("/usr/local/bin/party");
    // no pending: nothing
    expect(maybeReexecUpgrade(true, { ...deps, readInstalledVersion: () => "0.2.60" })).toEqual({
      pending: null,
      reexeced: false,
    });
  });
});
