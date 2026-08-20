// #857 第二个阻断缺陷的回归：announce 的触发条件必须按**频道身份**匹配。
// mentions 里只会出现频道 handle；宣告名（`agentparty-21` / `claude-<12hex>`）属于
// cross-session peers 命名空间，服务端 @ 它会直接 mention_not_found。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAnnounceChannelIdentity } from "../src/commands/claude-channel";

const previous = process.env.AGENTPARTY_CONFIG;

afterEach(() => {
  if (previous === undefined) delete process.env.AGENTPARTY_CONFIG;
  else process.env.AGENTPARTY_CONFIG = previous;
});

function writeConfigFile(identity: Record<string, unknown> | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), "ap-announce-identity-"));
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      server: "https://party.invalid",
      token: "tok",
      ...(identity === undefined ? {} : { identity }),
    }),
    { mode: 0o600 },
  );
  return path;
}

describe("resolveAnnounceChannelIdentity", () => {
  test("uses the cached channel identity when its scope matches", async () => {
    const path = writeConfigFile({
      name: "leeguooooo-codex2-agentparty",
      kind: "agent",
      role: "agent",
      owner: "leo@example.com",
      channel_scope: "agentparty",
      verified_at: 1,
    });
    process.env.AGENTPARTY_CONFIG = path;
    try {
      expect(
        await resolveAnnounceChannelIdentity("agentparty", { server: "https://party.invalid", token: "tok" }),
      ).toBe("leeguooooo-codex2-agentparty");
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("a scope mismatch or a missing identity never guesses — falls through to null when /api/me is unreachable", async () => {
    const path = writeConfigFile({
      name: "other-channel-agent",
      kind: "agent",
      role: "agent",
      owner: null,
      // 绑在别的频道上：绝不能拿来当本频道的「我」。
      channel_scope: "other",
      verified_at: 1,
    });
    process.env.AGENTPARTY_CONFIG = path;
    try {
      // server 不可达 → fetchMe 抛错 → null（静默降级为不注入）。
      expect(
        await resolveAnnounceChannelIdentity("agentparty", { server: "https://127.0.0.1:1", token: "tok" }),
      ).toBeNull();
    } finally {
      rmSync(path, { force: true });
    }
  });
});
