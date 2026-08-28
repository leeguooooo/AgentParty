import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeSessionRegistryEntry } from "../src/claude-session-registry";
import {
  CLAUDE_CHANNEL_FORCE_ARM_ENV,
  claimMentionWake,
  claudeChannelSiblingDormancy,
  countIdentityRuntimes,
  mentionWakeClaimKey,
  pruneMentionWakeClaims,
  releaseMentionWake,
  selfAuthoredMention,
} from "../src/mention-wake-claim";

const SERVER = "https://party.example";
const IDENTITY = "leo-server";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "wake-claims-"));
}

function entry(overrides: Partial<ClaudeSessionRegistryEntry> = {}): ClaudeSessionRegistryEntry {
  return {
    version: 1,
    session_id: "11111111-1111-4111-8111-111111111111",
    pid: 1000,
    display_name: null,
    channel: "ludo",
    server: SERVER,
    identity: IDENTITY,
    cwd: "/Users/leo/piggo",
    registered_at: 1_000,
    ...overrides,
  };
}

describe("claimMentionWake（#963 同身份多 runtime 一次 @ 只认领一次）", () => {
  test("同一条 (server, identity, channel, seq) 三个 runtime 抢，只有第一个 acquired，其余 denied 且看得到持有者", () => {
    const dir = tempDir();
    const ref = { server: SERVER, identity: IDENTITY, channel: "ludo", seq: 37 };
    const first = claimMentionWake(ref, { dir, runtimeId: "runtime-a" });
    const second = claimMentionWake(ref, { dir, runtimeId: "runtime-b" });
    const third = claimMentionWake(ref, { dir, runtimeId: "runtime-c" });
    expect(first.state).toBe("acquired");
    expect(second.state).toBe("denied");
    expect(third.state).toBe("denied");
    if (second.state !== "denied" || third.state !== "denied") throw new Error("unreachable");
    expect(second.holder?.runtime_id).toBe("runtime-a");
    expect(third.holder?.runtime_id).toBe("runtime-a");
    // 同一 runtime 再问一次也是 denied：认领只发一次，进程内 seen 表负责别再来问。
    expect(claimMentionWake(ref, { dir, runtimeId: "runtime-a" }).state).toBe("denied");
  });

  test("不同 seq / 不同频道 / 不同身份 / 不同实例互不阻塞", () => {
    const dir = tempDir();
    const base = { server: SERVER, identity: IDENTITY, channel: "ludo", seq: 37 };
    expect(claimMentionWake(base, { dir, runtimeId: "a" }).state).toBe("acquired");
    expect(claimMentionWake({ ...base, seq: 38 }, { dir, runtimeId: "b" }).state).toBe("acquired");
    expect(claimMentionWake({ ...base, channel: "dev" }, { dir, runtimeId: "b" }).state).toBe("acquired");
    expect(claimMentionWake({ ...base, identity: "other" }, { dir, runtimeId: "b" }).state).toBe("acquired");
    // #865：同一台机器连两台实例，两边都有 #ludo——认领键必须带 server。
    expect(claimMentionWake({ ...base, server: "https://other.example" }, { dir, runtimeId: "b" }).state).toBe("acquired");
    // 身份比对与 mention 同一把尺子：ASCII handle 大小写等价 ⇒ 同一把锁。
    expect(claimMentionWake({ ...base, identity: "LEO-SERVER" }, { dir, runtimeId: "b" }).state).toBe("denied");
    expect(mentionWakeClaimKey(base)).toBe(mentionWakeClaimKey({ ...base, identity: "Leo-Server" }));
  });

  test("release 只释放自己的认领，释放后别的 runtime 才能接手", () => {
    const dir = tempDir();
    const ref = { server: SERVER, identity: IDENTITY, channel: "ludo", seq: 40 };
    const mine = claimMentionWake(ref, { dir, runtimeId: "a" });
    if (mine.state !== "acquired") throw new Error("expected acquired");
    // 冒充别人的认领结果去释放：文件里记的是 a，不许删。
    const forged = { ...mine, holder: { ...mine.holder, runtime_id: "b" } };
    expect(releaseMentionWake(forged)).toBe(false);
    expect(existsSync(mine.path)).toBe(true);
    expect(releaseMentionWake(mine)).toBe(true);
    expect(existsSync(mine.path)).toBe(false);
    expect(claimMentionWake(ref, { dir, runtimeId: "b" }).state).toBe("acquired");
  });

  test("认领存储不可写 ⇒ unenforced（放行，不拒绝），带原因", () => {
    const dir = join(tempDir(), "not-a-dir");
    writeFileSync(dir, "occupied");
    const result = claimMentionWake({ server: SERVER, identity: IDENTITY, channel: "ludo", seq: 1 }, { dir, runtimeId: "a" });
    expect(result.state).toBe("unenforced");
    if (result.state === "unenforced") expect(result.reason).toBe("claim_store_unwritable");
  });

  test("陈旧认领文件会被清扫，新鲜的留着", () => {
    const dir = tempDir();
    const now = Date.now();
    const stale = claimMentionWake({ server: SERVER, identity: IDENTITY, channel: "ludo", seq: 1 }, { dir, runtimeId: "a", now });
    const fresh = claimMentionWake({ server: SERVER, identity: IDENTITY, channel: "ludo", seq: 2 }, { dir, runtimeId: "a", now });
    if (stale.state !== "acquired" || fresh.state !== "acquired") throw new Error("expected acquired");
    const old = new Date(now - 7 * 60 * 60 * 1000);
    utimesSync(stale.path, old, old);
    expect(pruneMentionWakeClaims(dir, now)).toBe(1);
    expect(readdirSync(dir)).toEqual([`${mentionWakeClaimKey({ server: SERVER, identity: IDENTITY, channel: "ludo", seq: 2 })}.json`]);
  });
});

describe("selfAuthoredMention（#963 自 @ 不是召唤）", () => {
  test("发信人与被 @ 身份同一把尺子比对", () => {
    expect(selfAuthoredMention("leo-server", "leo-server")).toBe(true);
    expect(selfAuthoredMention("LEO-SERVER", "leo-server")).toBe(true);
    expect(selfAuthoredMention("leo", "leo-server")).toBe(false);
    expect(selfAuthoredMention(undefined, "leo-server")).toBe(false);
    expect(selfAuthoredMention("", "leo-server")).toBe(false);
    expect(selfAuthoredMention("leo-server", null)).toBe(false);
  });
});

describe("countIdentityRuntimes（#963 siblings=N）", () => {
  test("同 server + 同频道 + 同身份，按 pid 去重，跨 cwd 也算；别的身份/实例/频道不算", () => {
    const entries = [
      entry({ pid: 1000 }),
      entry({ pid: 1000, session_id: "22222222-2222-4222-8222-222222222222" }), // 同 pid 两条 session（/clear）
      entry({ pid: 2000, cwd: "/Users/leo/other" }),
      entry({ pid: 3000, identity: "LEO-SERVER" }),
      entry({ pid: 4000, identity: "someone-else" }),
      entry({ pid: 5000, server: "https://other.example" }),
      entry({ pid: 6000, channel: "dev" }),
    ];
    expect(countIdentityRuntimes(entries, { channel: "ludo", server: SERVER, identity: IDENTITY })).toBe(3);
    expect(countIdentityRuntimes(entries, { channel: "ludo", server: SERVER, identity: null })).toBe(0);
  });
});

describe("claudeChannelSiblingDormancy（#963 建议 3：已有存活兄弟 ⇒ 新会话蛰伏）", () => {
  const scope = { channel: "ludo", cwd: "/Users/leo/piggo", server: SERVER, identity: IDENTITY, hostPid: 9999 };

  test("同 cwd 已有同身份的其他存活会话 ⇒ dormant，并列出兄弟 pid", () => {
    const decision = claudeChannelSiblingDormancy([entry({ pid: 1000 }), entry({ pid: 2000 })], scope, {});
    expect(decision).toEqual({ dormant: true, siblingPids: [1000, 2000], forced: false });
  });

  test("只有自己（宿主 pid）入册 ⇒ 不蛰伏；别的 cwd / 身份 / 实例 / 频道的会话不算兄弟", () => {
    const entries = [
      entry({ pid: 9999 }),
      entry({ pid: 1000, cwd: "/Users/leo/other" }),
      entry({ pid: 2000, identity: "someone-else" }),
      entry({ pid: 3000, server: "https://other.example" }),
      entry({ pid: 4000, channel: "dev" }),
    ];
    expect(claudeChannelSiblingDormancy(entries, scope, {})).toEqual({ dormant: false, siblingPids: [], forced: false });
  });

  test("解析不出身份 ⇒ 不按兄弟判蛰伏（交给后面的锁/身份闸）", () => {
    expect(claudeChannelSiblingDormancy([entry({ pid: 1000 })], { ...scope, identity: null }, {}).dormant).toBe(false);
  });

  test(`显式 ${CLAUDE_CHANNEL_FORCE_ARM_ENV}=1 才让新会话接管`, () => {
    const decision = claudeChannelSiblingDormancy([entry({ pid: 1000 })], scope, { [CLAUDE_CHANNEL_FORCE_ARM_ENV]: "1" });
    expect(decision).toEqual({ dormant: false, siblingPids: [1000], forced: true });
    expect(claudeChannelSiblingDormancy([entry({ pid: 1000 })], scope, { [CLAUDE_CHANNEL_FORCE_ARM_ENV]: "0" }).dormant).toBe(true);
  });
});
