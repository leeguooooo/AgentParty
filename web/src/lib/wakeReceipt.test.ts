import { describe, expect, test } from "bun:test";
import type { MsgFrame, PresenceEntry, WakeDelivery } from "@agentparty/shared";
import { buildReceipts, receiptFor } from "./wakeReceipt";

const NOW = 1_000_000_000;

function presence(over: Partial<PresenceEntry> & { name: string }): PresenceEntry {
  return { state: "waiting", note: null, ts: NOW, last_seen: NOW, ...over };
}

function delivery(over: Partial<WakeDelivery> & { mention_seq: number; target_name: string }): WakeDelivery {
  return {
    webhook_name: "hook",
    adapter_kind: "webhook",
    attempt: 1,
    result: "ok",
    http_status: 200,
    error: null,
    attempted_at: NOW,
    ack_seq: null,
    resume_seq: null,
    ...over,
  };
}

function msg(over: Partial<MsgFrame> & { seq: number }): MsgFrame {
  return {
    type: "msg",
    sender: { name: "leo", kind: "agent" },
    kind: "message",
    body: "",
    mentions: [],
    reply_to: null,
    state: null,
    note: null,
    status: null,
    ts: NOW,
    ...over,
  } as MsgFrame;
}

const ONLINE = (names: string[]) => new Set(names);
const ALL_AGENTS = () => true;

describe("receiptFor priority ladder", () => {
  test("replied wins over everything (client reply link)", () => {
    const r = receiptFor("evan", [delivery({ mention_seq: 45, target_name: "evan", result: "failed" })], { seq: 47, at: NOW }, ONLINE([]), {}, NOW);
    expect(r.state).toBe("replied");
    expect(r.detail).toBe("#47");
    expect(r.at).toBe(NOW);
  });

  test("replied via ledger resume_seq when no client reply link", () => {
    const r = receiptFor("evan", [delivery({ mention_seq: 45, target_name: "evan", resume_seq: 50 })], null, ONLINE([]), {}, NOW);
    expect(r.state).toBe("replied");
    expect(r.detail).toBe("#50");
  });

  test("webhook ok → woke, carries http status + time", () => {
    const r = receiptFor("evan", [delivery({ mention_seq: 45, target_name: "evan", http_status: 200, attempted_at: 123 })], null, ONLINE([]), {}, NOW);
    expect(r.state).toBe("woke");
    expect(r.detail).toBe("HTTP 200");
    expect(r.at).toBe(123);
  });

  test("webhook failed → wake_failed, prefers error text", () => {
    const r = receiptFor("evan", [delivery({ mention_seq: 45, target_name: "evan", result: "failed", http_status: 500, error: "boom" })], null, ONLINE([]), {}, NOW);
    expect(r.state).toBe("wake_failed");
    expect(r.detail).toBe("boom");
  });

  test("failed with no error text falls back to HTTP code", () => {
    const r = receiptFor("evan", [delivery({ mention_seq: 45, target_name: "evan", result: "failed", http_status: 502, error: null })], null, ONLINE([]), {}, NOW);
    expect(r.detail).toBe("HTTP 502");
  });

  test("latest attempt wins among multiple ledger rows", () => {
    const rows = [
      delivery({ mention_seq: 45, target_name: "evan", attempt: 1, result: "failed", error: "first" }),
      delivery({ mention_seq: 45, target_name: "evan", attempt: 2, result: "ok", http_status: 200 }),
    ];
    expect(receiptFor("evan", rows, null, ONLINE([]), {}, NOW).state).toBe("woke");
  });

  test("no ledger + online now → delivered", () => {
    const r = receiptFor("evan", [], null, ONLINE(["evan"]), { evan: presence({ name: "evan" }) }, NOW);
    expect(r.state).toBe("delivered");
  });

  test("no ledger + wakeable presence → pending_wake with wake kind", () => {
    const r = receiptFor("evan", [], null, ONLINE([]), { evan: presence({ name: "evan", wake: { kind: "serve" } }) }, NOW);
    expect(r.state).toBe("pending_wake");
    expect(r.detail).toBe("serve");
  });

  test("no ledger + offline/not wakeable → pending_reconnect", () => {
    const r = receiptFor("evan", [], null, ONLINE([]), { evan: presence({ name: "evan", wake: { kind: "none" } }) }, NOW);
    expect(r.state).toBe("pending_reconnect");
  });

  test("stale wakeable (last_seen too old) → pending_reconnect, not pending_wake", () => {
    const r = receiptFor("evan", [], null, ONLINE([]), { evan: presence({ name: "evan", wake: { kind: "serve" }, last_seen: NOW - 120_000 }) }, NOW);
    expect(r.state).toBe("pending_reconnect");
  });

  test("human_driven watch → pending_reconnect, not pending_wake", () => {
    const r = receiptFor("evan", [], null, ONLINE([]), { evan: presence({ name: "evan", residency: "human_driven", wake: { kind: "watch" } }) }, NOW);
    expect(r.state).toBe("pending_reconnect");
  });
});

describe("buildReceipts", () => {
  test("only messages with agent mentions get receipts; self-mention + human targets skipped", () => {
    const isAgent = (n: string) => n !== "human-luis";
    const messages: MsgFrame[] = [
      msg({ seq: 45, sender: { name: "leo", kind: "agent" }, mentions: ["evan", "leo", "human-luis"] }),
      msg({ seq: 46, sender: { name: "leo", kind: "agent" }, mentions: [] }), // no mention
      msg({ seq: 47, sender: { name: "evan", kind: "agent" }, kind: "status", mentions: ["leo"] } as Partial<MsgFrame> & { seq: number }),
    ];
    const receipts = buildReceipts(messages, [], ONLINE(["evan"]), { evan: presence({ name: "evan" }) }, NOW, isAgent);
    expect(receipts.has(45)).toBe(true);
    expect(receipts.get(45)!.map((r) => r.name)).toEqual(["evan"]); // leo(self) + human-luis dropped
    expect(receipts.has(46)).toBe(false);
    expect(receipts.has(47)).toBe(false); // status kind skipped
  });

  test("client reply linkage: a later reply from the target flips to replied", () => {
    const messages: MsgFrame[] = [
      msg({ seq: 45, sender: { name: "leo", kind: "agent" }, mentions: ["evan"] }),
      msg({ seq: 47, sender: { name: "evan", kind: "agent" }, reply_to: 45, ts: NOW + 5 }),
    ];
    const receipts = buildReceipts(messages, [], ONLINE([]), {}, NOW, ALL_AGENTS);
    expect(receipts.get(45)![0]).toMatchObject({ name: "evan", state: "replied", detail: "#47" });
  });

  test("a reply from someone else does NOT count as this target replying", () => {
    const messages: MsgFrame[] = [
      msg({ seq: 45, sender: { name: "leo", kind: "agent" }, mentions: ["evan"] }),
      msg({ seq: 47, sender: { name: "karl", kind: "agent" }, reply_to: 45 }),
    ];
    const receipts = buildReceipts(messages, [], ONLINE([]), { evan: presence({ name: "evan", wake: { kind: "none" } }) }, NOW, ALL_AGENTS);
    expect(receipts.get(45)![0]!.state).toBe("pending_reconnect");
  });
});
