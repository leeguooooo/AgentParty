import { describe, expect, test } from "bun:test";
import type { PresenceEntry, Sender } from "@agentparty/shared";
import { activeMentionQuery, filterCandidates, mentionCandidates } from "./mentions";

const NOW = 1_000_000_000;

function presence(over: Partial<PresenceEntry> & { name: string }): PresenceEntry {
  return { state: "waiting", note: null, ts: NOW, last_seen: NOW, ...over };
}

describe("mentionCandidates", () => {
  test("tiers: online (participant) > wakeable (serve/watch fresh) > recent", () => {
    const participants: Sender[] = [{ name: "alice", kind: "human" }];
    const pres: Record<string, PresenceEntry> = {
      alice: presence({ name: "alice" }),
      bob: presence({ name: "bob", wake: { kind: "serve" } }),
      carol: presence({ name: "carol", wake: { kind: "none" } }),
    };
    const c = mentionCandidates(participants, pres, "me", NOW);
    const byName = Object.fromEntries(c.map((x) => [x.name, x.tier]));
    expect(byName.alice).toBe("online");
    expect(byName.bob).toBe("wakeable");
    expect(byName.carol).toBe("recent");
    // 排序：online 在最前
    expect(c[0]!.name).toBe("alice");
  });

  test("stale wakeable falls back to recent", () => {
    const pres = { bob: presence({ name: "bob", wake: { kind: "serve" }, last_seen: NOW - 120_000 }) };
    expect(mentionCandidates([], pres, null, NOW)[0]!.tier).toBe("recent");
  });

  test("excludes self and system", () => {
    const pres = { me: presence({ name: "me" }), system: presence({ name: "system" }), x: presence({ name: "x" }) };
    const names = mentionCandidates([], pres, "me", NOW).map((c) => c.name);
    expect(names).toEqual(["x"]);
  });
});

describe("activeMentionQuery", () => {
  test("detects @prefix at caret after whitespace/start", () => {
    expect(activeMentionQuery("@ali", 4)).toEqual({ start: 0, query: "ali" });
    expect(activeMentionQuery("hi @bo", 6)).toEqual({ start: 3, query: "bo" });
    expect(activeMentionQuery("@", 1)).toEqual({ start: 0, query: "" });
  });
  test("ignores @ inside a word (email etc.)", () => {
    expect(activeMentionQuery("mail me@x", 9)).toBeNull();
  });
  test("null when caret not in a mention", () => {
    expect(activeMentionQuery("hello world", 11)).toBeNull();
    expect(activeMentionQuery("@ali done ", 10)).toBeNull();
  });
});

describe("filterCandidates", () => {
  const cands = [
    { name: "alice", kind: "human" as const, tier: "online" as const },
    { name: "bob-review", kind: "agent" as const, tier: "wakeable" as const },
    { name: "carol", kind: "agent" as const, tier: "recent" as const },
  ];
  test("prefix hits before substring hits", () => {
    expect(filterCandidates(cands, "b").map((c) => c.name)).toEqual(["bob-review"]);
    expect(filterCandidates(cands, "review").map((c) => c.name)).toEqual(["bob-review"]);
  });
  test("empty query returns all (capped)", () => {
    expect(filterCandidates(cands, "").length).toBe(3);
  });
});
