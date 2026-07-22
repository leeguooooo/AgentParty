import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { fetchServerVersion } from "../src/rest";
import { RUNNING_VERSION, serverMinVersionNotice, serverVersionUpgradeNotice, upgradeHintForServer } from "../src/upgrade";
import { resolveAvailableUpgrade } from "../src/commands/serve";

function sha256(bytes: Uint8Array): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(bytes);
  return hash.digest("hex");
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("CLI↔worker version negotiation (issue #137)", () => {
  test("every REST call announces the client version via x-ap-client-version", async () => {
    let seen: string | null = "MISSING";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      seen = req.headers.get("x-ap-client-version");
      return Response.json({ version: "dev", commit: "unknown", deployed_at: null, min_client_version: "0.2.0" });
    }) as typeof fetch;

    await fetchServerVersion("https://ap.test");
    expect(seen).toBe(RUNNING_VERSION);
  });

  test("fetchServerVersion parses the endpoint and tolerates a legacy server (missing fields)", async () => {
    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        version: "0.2.94",
        commit: "abc",
        deployed_at: "2026-07-11T00:00:00Z",
        min_client_version: "0.3.0",
        min_client_enforced: true,
      })) as typeof fetch;
    expect(await fetchServerVersion("https://ap.test")).toEqual({
      version: "0.2.94",
      commit: "abc",
      deployed_at: "2026-07-11T00:00:00Z",
      min_client_version: "0.3.0",
      min_client_enforced: true,
    });

    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => Response.json({})) as typeof fetch;
    const legacy = await fetchServerVersion("https://ap.test");
    expect(legacy.min_client_version).toBe("0.0.0");
    expect(legacy.min_client_enforced).toBe(false);
  });

  test("serverMinVersionNotice fires only when the running version is below the declared floor", () => {
    // 低于下限 → 生成升级提示（对齐 cli_upgrade 的 ask_user 流）
    const below = serverMinVersionNotice("9.9.9", false, { runningVersion: "0.2.60" });
    expect(below).not.toBeNull();
    expect(below?.action_required).toBe("ask_user");
    expect(below?.min_client_version).toBe("9.9.9");
    expect(below?.running_version).toBe("0.2.60");
    expect(below?.enforced).toBe(false);
    expect(below?.command).toContain("install.sh");

    // 等于/高于下限 → 无提示
    expect(serverMinVersionNotice("0.2.60", false, { runningVersion: "0.2.60" })).toBeNull();
    expect(serverMinVersionNotice("0.2.0", false, { runningVersion: "0.2.94" })).toBeNull();

    // enforced 标透传，并改用「已被拒绝」的措辞
    const enforced = serverMinVersionNotice("9.9.9", true, { runningVersion: "0.2.60" });
    expect(enforced?.enforced).toBe(true);
    expect(enforced?.message).toContain("拒绝");
  });

  test("serverVersionUpgradeNotice asks the agent to notify its owner when the deployed release is newer (#485)", () => {
    const notice = serverVersionUpgradeNotice("v0.2.108", { runningVersion: "0.2.107" });
    expect(notice).toMatchObject({
      running_version: "0.2.107",
      available_version: "0.2.108",
      auto_upgrade: false,
      action_required: "ask_user",
    });
    expect(notice?.installed_version).toBeUndefined();
    expect(notice?.message).toContain("主动提醒 owner 升级");
    expect(notice?.command).toContain("install.sh");

    expect(serverVersionUpgradeNotice("0.2.107", { runningVersion: "0.2.107" })).toBeNull();
    expect(serverVersionUpgradeNotice("0.2.106", { runningVersion: "0.2.107" })).toBeNull();
    expect(serverVersionUpgradeNotice("dev", { runningVersion: "0.2.107" })).toBeNull();
    expect(serverVersionUpgradeNotice("0.2.108-rc.1", { runningVersion: "0.2.107" })).toBeNull();
    expect(serverVersionUpgradeNotice("v0.2.108+build.7", { runningVersion: "0.2.107" })?.available_version).toBe("0.2.108");
  });

  test("resolveAvailableUpgrade downloads the release binary when serve --auto-upgrade is enabled (#559)", async () => {
    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ version: "0.2.108", commit: "abc", deployed_at: null })) as typeof fetch;
    const archive = new TextEncoder().encode("fake tarball");
    const installs: string[] = [];

    const notice = await resolveAvailableUpgrade("https://ap.test", null, {
      autoDownload: true,
      upgradeDeps: {
        runningVersion: "0.2.107",
        execPath: "/usr/local/bin/party",
        platform: "darwin",
        arch: "x64",
        fetchBytes: async (url) => url.endsWith(".sha256")
          ? new TextEncoder().encode(`${sha256(archive)}  party-darwin-x64.tar.gz\n`)
          : archive,
        extractPartyBinary: async (_archivePath, outDir) => {
          const binary = `${outDir}/party`;
          writeFileSync(binary, "binary");
          return binary;
        },
        installBinary: (_source, target) => installs.push(target),
      },
    });

    expect(notice).toMatchObject({
      running_version: "0.2.107",
      available_version: "0.2.108",
      installed_version: "0.2.108",
      auto_upgrade: true,
      action_required: "auto_reexec",
    });
    expect(installs).toEqual(["/usr/local/bin/party"]);
  });
});

describe("upgradeHintForServer（#703：watch 挂载升级提示）", () => {
  const server = (over: Partial<{ version: string; min_client_version: string; min_client_enforced: boolean }> = {}) => ({
    version: "0.2.100",
    min_client_version: "0.0.0",
    min_client_enforced: false,
    ...over,
  });

  test("已是最新且不低于 min → 无提示", () => {
    expect(upgradeHintForServer(server({ version: "0.2.100" }), { runningVersion: "0.2.100" })).toBeNull();
    expect(upgradeHintForServer(server({ version: "0.2.90" }), { runningVersion: "0.2.100" })).toBeNull();
  });

  test("落后于最新发布版 → 提示原地 party upgrade、免重绑", () => {
    const hint = upgradeHintForServer(server({ version: "0.2.136" }), { runningVersion: "0.2.100" });
    expect(hint).not.toBeNull();
    expect(hint).toContain("party upgrade");
    expect(hint).toContain("0.2.136");
    expect(hint).toContain("无需重跑接入包");
  });

  test("低于 min 优先于落后提示（协议可能已破）", () => {
    // 同时落后最新且低于 min：min 提示优先
    const hint = upgradeHintForServer(
      server({ version: "0.2.136", min_client_version: "0.2.120", min_client_enforced: false }),
      { runningVersion: "0.2.100" },
    );
    expect(hint).not.toBeNull();
    expect(hint).toContain("最低");
    expect(hint).toContain("party upgrade");
  });

  test("enforced min → 提示措辞更硬（已被拒绝）", () => {
    const hint = upgradeHintForServer(
      server({ min_client_version: "9.9.9", min_client_enforced: true }),
      { runningVersion: "0.2.100" },
    );
    expect(hint).toContain("已被拒绝");
  });
});
