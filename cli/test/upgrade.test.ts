import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { compareVersions, downloadPartyUpgrade, maybeReexecUpgrade, pendingUpgrade } from "../src/upgrade";

function sha256(bytes: Uint8Array): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(bytes);
  return hash.digest("hex");
}

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

  test("downloadPartyUpgrade fetches release assets, verifies sha256, and atomically installs", async () => {
    const archive = new TextEncoder().encode("fake tarball");
    const calls: Array<{ source: string; target: string }> = [];
    const result = await downloadPartyUpgrade({ version: "0.2.61" }, {
      runningVersion: "0.2.60",
      execPath: "/usr/local/bin/party",
      platform: "darwin",
      arch: "arm64",
      fetchBytes: async (url) => url.endsWith(".sha256")
        ? new TextEncoder().encode(`${sha256(archive)}  party-darwin-arm64.tar.gz\n`)
        : archive,
      extractPartyBinary: async (_archivePath, outDir) => {
        const binary = `${outDir}/party`;
        writeFileSync(binary, "binary");
        return binary;
      },
      installBinary: (source, target) => calls.push({ source, target }),
    });
    expect(result).toMatchObject({
      running_version: "0.2.60",
      target_version: "0.2.61",
      target: "darwin-arm64",
      installed: true,
      install_path: "/usr/local/bin/party",
    });
    expect(result.asset_url).toContain("/v0.2.61/party-darwin-arm64.tar.gz");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toBe("/usr/local/bin/party");
  });

  test("downloadPartyUpgrade refuses a checksum mismatch before install", async () => {
    const archive = new TextEncoder().encode("fake tarball");
    const installs: string[] = [];
    await expect(downloadPartyUpgrade({ version: "0.2.61" }, {
      runningVersion: "0.2.60",
      execPath: "/usr/local/bin/party",
      platform: "linux",
      arch: "x64",
      fetchBytes: async (url) => url.endsWith(".sha256")
        ? new TextEncoder().encode(`${"0".repeat(64)}  party-linux-x64.tar.gz\n`)
        : archive,
      installBinary: (_source, target) => installs.push(target),
    })).rejects.toThrow("sha256 mismatch");
    expect(installs).toHaveLength(0);
  });

  test("downloadPartyUpgrade refuses dev execPath and check mode never installs", async () => {
    await expect(downloadPartyUpgrade({ version: "0.2.61" }, {
      runningVersion: "0.2.60",
      execPath: "/opt/homebrew/bin/bun",
    })).rejects.toThrow("compiled party binary");

    const result = await downloadPartyUpgrade({ version: "0.2.60", checkOnly: true }, {
      runningVersion: "0.2.60",
      execPath: "/usr/local/bin/party",
      platform: "linux",
      arch: "arm64",
      installBinary: () => { throw new Error("must not install"); },
    });
    expect(result).toMatchObject({ installed: false, target: "linux-arm64", target_version: "0.2.60" });
  });
});
