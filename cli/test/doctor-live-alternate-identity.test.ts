// #1015：token 被服务端拒了，不等于这台机器没得用。~/.agentparty/agents/ 常有同频道的好几份 config
// （真机 ludo：三份里两份 401、一份 200），旧修法却只有「去要个新 token」。
//
// 这里钉住的核心是**只报验活过的**：列未验证的候选比不列更坏——三份里猜一份，准会把人推向死的那份。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PresenceEntry } from "@agentparty/shared";
import {
  claudePluginDoctorFixLines,
  safeProbeTarget,
  inspectClaudePluginReadiness,
  probeLiveAlternateIdentities,
  type ClaudeAlternateIdentity,
  type ClaudePluginDoctorDependencies,
} from "../src/commands/doctor";
import { RestError, type Identity } from "../src/rest";

const agent = (name: string, channelScope: string | null = "ludo"): Identity => ({
  name,
  email: null,
  kind: "agent",
  role: "agent",
  owner: null,
  channel_scope: channelScope,
});

/** 一个只在临时目录里的 ~/.agentparty——绝不碰用户真实 config。 */
function fakeHome(configs: { file: string; name: string; channel: string; token: string; server?: string }[]): string {
  const home = mkdtempSync(join(tmpdir(), "agentparty-1015-"));
  mkdirSync(join(home, "agents"));
  for (const config of configs) {
    writeFileSync(
      join(home, "agents", config.file),
      JSON.stringify({
        server: config.server ?? "https://agentparty.example.com",
        token: config.token,
        identity: { name: config.name, kind: "agent", role: "agent", channel_scope: config.channel },
      }),
    );
  }
  return home;
}

function deps(
  identity: () => Promise<never>,
  liveAlternateIdentities?: ClaudePluginDoctorDependencies["liveAlternateIdentities"],
): ClaudePluginDoctorDependencies {
  return {
    claudeVersion: () => "2.1.228 (Claude Code)",
    claudePlugins: () => null,
    inspectBundle: () => ({ valid: true, launcherExecutable: true }),
    resolveAuth: async () => ({
      server: "https://agentparty.example.com",
      token: "private-test-token",
      auth_source: "runtime_config",
      config: { kind: "workspace", path: "/private/config", workspace_id: "workspace" },
      account: { present: false, path: "/private/account" },
    }),
    channel: () => "ludo",
    identity,
    ...(liveAlternateIdentities === undefined ? {} : { liveAlternateIdentities }),
    presence: async () => [] as PresenceEntry[],
    runtimeTopology: () => undefined,
    runtimePeers: async () => ({ self: "nobody", peers: [] }) as never,
  };
}

const revoked = (): never => {
  throw new RestError(401, "unauthorized", "invalid or revoked token");
};

describe("live alternate identity probe (#1015)", () => {
  test("only the config whose /api/me actually answers 200 is reported", async () => {
    const home = fakeHome([
      { file: "dead-one.json", name: "lark-ad72b3f9749e-ludo", channel: "ludo", token: "dead-1" },
      { file: "dead-two.json", name: "leo-server", channel: "ludo", token: "dead-2" },
      { file: "live.json", name: "server", channel: "ludo", token: "live-1" },
      { file: "other-channel.json", name: "elsewhere", channel: "piggygo", token: "live-2" },
    ]);
    const asked: string[] = [];
    const alternates = await probeLiveAlternateIdentities(
      "ludo",
      null,
      async (_server, token) => {
        asked.push(token);
        if (token !== "live-1") throw new RestError(401, "unauthorized", "invalid or revoked token");
        return agent("server");
      },
      home,
    );

    expect(alternates.map((entry) => entry.name)).toEqual(["server"]);
    expect(alternates[0]!.path).toBe(join(home, "agents", "live.json"));
    // 每一份都真问过服务端——「有 config 就当它活着」正是要修的毛病。
    expect(asked.sort()).toEqual(["dead-1", "dead-2", "live-1"]);
    // 别的频道的身份不算数，哪怕它 token 是好的。
    expect(asked).not.toContain("live-2");
  });

  test("a human token on the same channel is not offered as an agent identity", async () => {
    const home = fakeHome([{ file: "human.json", name: "leo", channel: "ludo", token: "human-1" }]);
    const alternates = await probeLiveAlternateIdentities(
      "ludo",
      null,
      async () => ({ name: "leo", email: null, kind: "human", role: "member", owner: null, channel_scope: "ludo" }),
      home,
    );
    expect(alternates).toEqual([]);
  });

  test("the current config is not offered back to itself", async () => {
    const home = fakeHome([{ file: "self.json", name: "server", channel: "ludo", token: "self-1" }]);
    const alternates = await probeLiveAlternateIdentities(
      "ludo",
      join(home, "agents", "self.json"),
      async () => agent("server"),
      home,
    );
    expect(alternates).toEqual([]);
  });

  test("the report carries verified alternates only under a 401", async () => {
    const probe = async (): Promise<ClaudeAlternateIdentity[]> => [
      { name: "server", path: "/home/leo/.agentparty/agents/live.json", server: "https://agentparty.example.com" },
    ];
    const report = await inspectClaudePluginReadiness(undefined, deps(async () => revoked(), probe));
    expect(report.auth.identity_error).toBe("unauthorized");
    expect(report.auth.live_alternate_identities?.map((entry) => entry.name)).toEqual(["server"]);

    // 超时不是「token 不对」，不该去问兄弟 config。
    const timedOut = await inspectClaudePluginReadiness(
      undefined,
      deps(async () => {
        throw new DOMException("timed out", "TimeoutError");
      }, probe),
    );
    expect(timedOut.auth.live_alternate_identities).toBeUndefined();
  });

  test("a probe that blows up degrades to today's behaviour instead of failing the audit", async () => {
    const report = await inspectClaudePluginReadiness(
      undefined,
      deps(async () => revoked(), async () => {
        throw new Error("disk on fire");
      }),
    );
    expect(report.auth.identity_error).toBe("unauthorized");
    expect(report.auth.live_alternate_identities).toBeUndefined();
  });

  test("the fix line hands over the exact switch command, and stays unchanged with no live sibling", () => {
    const base = {
      blockers: ["identity_unavailable" as const],
      plugin: { installed: true, enabled: true, bundle_valid: true, launcher_executable: true },
      runtime_version: "0.2.224",
      channel: { slug: "ludo" },
    };
    const withAlternate = claudePluginDoctorFixLines({
      ...base,
      auth: {
        identity_error: "unauthorized",
        identity_error_message: "invalid or revoked token",
        live_alternate_identities: [
          { name: "server", path: "/home/leo/.agentparty/agents/live.json", server: "https://x" },
        ],
      },
    }).join("\n");
    expect(withAlternate).toContain("server");
    expect(withAlternate).toContain("AGENTPARTY_CONFIG=/home/leo/.agentparty/agents/live.json party claude ludo");
    expect(withAlternate).toContain("party join <invite>");

    const withoutAlternate = claudePluginDoctorFixLines({
      ...base,
      auth: { identity_error: "unauthorized", identity_error_message: "invalid or revoked token" },
    }).join("\n");
    // 一份都没验活时逐字不动——今天的行为是基线。
    expect(withoutAlternate).toContain("party init --token <agent-token> --channel <channel>");
    expect(withoutAlternate).not.toContain("AGENTPARTY_CONFIG=");
  });

  test("a token that is alive but no longer scoped to this channel is not offered", async () => {
    const home = fakeHome([
      { file: "moved.json", name: "server", channel: "ludo", token: "moved-1" },
      { file: "unscoped.json", name: "roamer", channel: "ludo", token: "unscoped-1" },
      { file: "still-here.json", name: "keeper", channel: "ludo", token: "keeper-1" },
    ]);
    const alternates = await probeLiveAlternateIdentities(
      "ludo",
      null,
      // 三个 token 都活着，但服务端说的 scope 各不相同——本地 config 里那份 scope 是缓存，不算数。
      async (_server, token) =>
        token === "moved-1"
          ? agent("server", "piggygo")
          : token === "unscoped-1"
            ? agent("roamer", null)
            : agent("keeper", "ludo"),
      home,
    );
    expect(alternates.map((entry) => entry.name)).toEqual(["keeper"]);
  });

  test("a plaintext-http sibling never receives its token (loopback excepted)", async () => {
    const home = fakeHome([
      { file: "plain.json", name: "plain", channel: "ludo", token: "plain-1", server: "http://agentparty.example.com" },
      { file: "loopback.json", name: "loopback", channel: "ludo", token: "loopback-1", server: "http://localhost:8787" },
    ]);
    const asked: string[] = [];
    const alternates = await probeLiveAlternateIdentities(
      "ludo",
      null,
      async (server, token) => {
        asked.push(token);
        return agent(server.includes("localhost") ? "loopback" : "plain");
      },
      home,
    );
    // 探活是本机诊断顺手把**别的 config 的 token** 发出去，明文 http 一律不发。
    expect(asked).not.toContain("plain-1");
    expect(asked).toEqual(["loopback-1"]);
    expect(alternates.map((entry) => entry.name)).toEqual(["loopback"]);

    expect(safeProbeTarget("https://agentparty.example.com")).toBe(true);
    expect(safeProbeTarget("http://agentparty.example.com")).toBe(false);
    expect(safeProbeTarget("http://127.0.0.1:8787")).toBe(true);
    expect(safeProbeTarget("not a url")).toBe(false);
  });

  test("a hostile config path cannot break out of the copy-pasteable command", () => {
    const lines = claudePluginDoctorFixLines({
      blockers: ["identity_unavailable"],
      plugin: { installed: true, enabled: true, bundle_valid: true, launcher_executable: true },
      runtime_version: "0.2.224",
      channel: { slug: "ludo" },
      auth: {
        identity_error: "unauthorized",
        live_alternate_identities: [
          { name: "srv\u001b[31mred", path: "/home/leo/x'; rm -rf ~; echo '.json", server: "https://x" },
        ],
      },
    }).join("\n");
    // 注入片段必须整段落在引号里，且服务端给的名字不带控制字符进终端。
    expect(lines).toContain("AGENTPARTY_CONFIG='/home/leo/x'\\''; rm -rf ~; echo '\\''.json'");
    expect(lines).not.toContain("\u001b");
  });
});
