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

  // #107 之后 ledger 里有 serve/watch 的 broadcast/consumed 行；生产实测（seq 785）：
  // agent 实际经 serve 被唤醒并回复，但回执只看失败的 webhook 行，红标「唤醒失败」——假报警。
  test("serve broadcast → pending_wake (delivered to pull client, not a failure)", () => {
    const r = receiptFor(
      "evan",
      [delivery({ mention_seq: 45, target_name: "evan", adapter_kind: "serve", webhook_name: "evan", result: "broadcast", http_status: null, attempted_at: 321 })],
      null, ONLINE([]), {}, NOW,
    );
    expect(r.state).toBe("pending_wake");
    expect(r.detail).toBe("serve");
    expect(r.at).toBe(321);
  });

  test("failed webhook + serve broadcast for the same @ → success signal wins, no false wake_failed", () => {
    const rows = [
      delivery({ mention_seq: 45, target_name: "evan", result: "failed", http_status: 500, error: "boom", attempt: 2 }),
      delivery({ mention_seq: 45, target_name: "evan", adapter_kind: "serve", webhook_name: "evan", result: "broadcast", http_status: null, attempt: 1 }),
    ];
    const r = receiptFor("evan", rows, null, ONLINE([]), {}, NOW);
    expect(r.state).toBe("pending_wake");
  });

  test("serve consumed (resume referenced the @) → replied via ack_seq", () => {
    const rows = [
      delivery({ mention_seq: 45, target_name: "evan", result: "failed", http_status: 500, attempt: 2 }),
      delivery({ mention_seq: 45, target_name: "evan", adapter_kind: "serve", webhook_name: "evan", result: "consumed", http_status: null, ack_seq: 52 }),
    ];
    const r = receiptFor("evan", rows, null, ONLINE([]), {}, NOW);
    expect(r.state).toBe("replied");
    expect(r.detail).toBe("#52");
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

  test("current_task matching this mention → working even after serve consumed the wake", () => {
    const rows = [
      delivery({ mention_seq: 45, target_name: "evan", adapter_kind: "serve", webhook_name: "evan", result: "consumed", http_status: null, ack_seq: 52 }),
    ];
    const r = receiptFor(
      "evan",
      rows,
      null,
      ONLINE([]),
      { evan: presence({ name: "evan", current_task: 45, task_started_at: NOW - 500, heartbeat_at: NOW }) },
      NOW,
      45,
    );
    expect(r).toMatchObject({ name: "evan", state: "working", detail: "#45", at: NOW - 500 });
  });

  test("stale current_task heartbeat does not keep claiming working and falls through to the consumed receipt", () => {
    const rows = [
      delivery({ mention_seq: 45, target_name: "evan", adapter_kind: "serve", webhook_name: "evan", result: "consumed", http_status: null, ack_seq: 52 }),
    ];
    const r = receiptFor(
      "evan",
      rows,
      null,
      ONLINE([]),
      { evan: presence({ name: "evan", current_task: 45, task_started_at: NOW - 120_000, heartbeat_at: NOW - 60_001 }) },
      NOW,
      45,
    );
    expect(r).toMatchObject({ name: "evan", state: "replied", detail: "#52" });
  });

  test("current_task for a different mention does not claim this message is being processed", () => {
    const r = receiptFor(
      "evan",
      [],
      null,
      ONLINE([]),
      { evan: presence({ name: "evan", current_task: 99, task_started_at: NOW - 500, heartbeat_at: NOW }) },
      NOW,
      45,
    );
    expect(r.state).toBe("pending_reconnect");
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

  test("presence current_task links an active runner to the original mention", () => {
    const messages: MsgFrame[] = [
      msg({ seq: 45, sender: { name: "leo", kind: "human" }, mentions: ["evan"] }),
    ];
    const receipts = buildReceipts(
      messages,
      [],
      ONLINE([]),
      { evan: presence({ name: "evan", current_task: 45, task_started_at: NOW - 1_000, heartbeat_at: NOW }) },
      NOW,
      ALL_AGENTS,
    );
    expect(receipts.get(45)![0]).toMatchObject({ name: "evan", state: "working", detail: "#45" });
  });
});
