import { describe, expect, test } from "bun:test";
import { buildGroups, countLiveGroups, ownerKey, type Item } from "./PresenceBar";

function item(over: Partial<Item> = {}): Item {
  return {
    name: "agent-a",
    kind: "agent",
    state: "working",
    note: null,
    ts: 1_000,
    lastSeen: 1_000,
    role: null,
    roleSource: null,
    residency: null,
    wakeKind: null,
    wakeVerifiedAt: null,
    context: null,
    lineage: null,
    workflow: null,
    owner: null,
    account: null,
    handle: null,
    display: "agent-a",
    responsibility: null,
    connectionCount: 1,
    ...over,
  };
}

describe("presence grouping by account", () => {
  test("ownerKey groups online and offline sessions of the same account together", () => {
    const online = item({ name: "sess-1", kind: "human", state: "working", owner: "alice@example.com", account: "alice@example.com" });
    // 离线会话：owner 出于隐私置空，但 account 仍保留，用来分组。
    const offline = item({ name: "3d2f1e8a-uuid", kind: "human", state: "offline", owner: null, account: "alice@example.com" });
    expect(ownerKey(online)).toBe(ownerKey(offline));
    expect(ownerKey(online)).toBe("account:alice@example.com");
  });

  test("items without an account fall back to per-session grouping", () => {
    const a = item({ name: "agent-a", account: null });
    const b = item({ name: "agent-b", account: null });
    expect(ownerKey(a)).not.toBe(ownerKey(b));
  });

  test("buildGroups folds one account's online + offline sessions into a single group, and counts participants (not sessions)", () => {
    const aliceOnline = item({
      name: "sess-1",
      kind: "human",
      state: "working",
      owner: "alice@example.com",
      account: "alice@example.com",
      display: "alice@example.com",
    });
    const aliceOffline = item({
      name: "3d2f1e8a-uuid",
      kind: "human",
      state: "offline",
      owner: null,
      account: "alice@example.com",
      display: "3d2f1e8a-uuid",
    });
    const bobOffline = item({
      name: "bot-1",
      kind: "agent",
      state: "offline",
      owner: null,
      account: "bob@example.com",
      display: "bob@example.com",
    });

    const groups = buildGroups([aliceOnline, aliceOffline, bobOffline]);

    // alice 的在线 + 离线会话应折叠为同一组（1 人 2 个会话），bob 单独一组。
    expect(groups).toHaveLength(2);
    const aliceGroup = groups.find((g) => g.key === "account:alice@example.com");
    expect(aliceGroup?.items).toHaveLength(2);

    // 顶部计数按人数：2 个账号，其中只有 alice 有非离线会话，所以 1/2。
    const { live, total } = countLiveGroups(groups);
    expect(total).toBe(2);
    expect(live).toBe(1);
  });

  test("an account with only offline sessions across multiple entries still counts as one non-live participant", () => {
    const offlineA = item({ name: "sess-x", kind: "human", state: "offline", owner: null, account: "carol@example.com" });
    const offlineB = item({ name: "sess-y", kind: "human", state: "offline", owner: null, account: "carol@example.com" });

    const groups = buildGroups([offlineA, offlineB]);
    expect(groups).toHaveLength(1);
    const { live, total } = countLiveGroups(groups);
    expect(total).toBe(1);
    expect(live).toBe(0);
  });
});
