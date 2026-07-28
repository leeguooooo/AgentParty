import { describe, expect, test } from "bun:test";
import type { MsgFrame, SenderKind, StatusState } from "@agentparty/shared";
import { catchupKey, compactDigestText, summarizeCatchup } from "./digest";

function msg(input: {
  seq: number;
  sender?: string;
  senderKind?: SenderKind;
  body?: string;
  mentions?: string[];
  replyTo?: number | null;
}): MsgFrame {
  return {
    type: "msg",
    seq: input.seq,
    sender: { name: input.sender ?? "agent-a", kind: input.senderKind ?? "agent" },
    kind: "message",
    body: input.body ?? "",
    mentions: input.mentions ?? [],
    reply_to: input.replyTo ?? null,
    state: null,
    note: null,
    status: null,
    ts: input.seq * 1000,
  };
}

function status(input: {
  seq: number;
  sender?: string;
  state: StatusState;
  note: string;
  mentions?: string[];
  summarySeq?: number | null;
}): MsgFrame {
  return {
    type: "status",
    seq: input.seq,
    sender: { name: input.sender ?? "agent-a", kind: "agent" },
    kind: "status",
    body: input.note,
    mentions: input.mentions ?? [],
    reply_to: null,
    state: input.state,
    note: input.note,
    status: {
      owner: input.sender ?? "agent-a",
      state: input.state,
      scope: [],
      summary_seq: input.summarySeq ?? null,
      blocked_reason: input.state === "blocked" ? input.note : null,
      updated_at: input.seq * 1000,
    },
    ts: input.seq * 1000,
  };
}

describe("web catchup digest", () => {
  test("uses a versioned per-channel viewer cursor key", () => {
    expect(catchupKey("agentparty", "codex-main")).toBe("ap_seen:v1:agentparty:codex-main");
  });

  test("ignores messages at or before last seen", () => {
    const digest = summarizeCatchup(
      [
        msg({ seq: 10, body: "old @me", mentions: ["me"] }),
        msg({ seq: 11, body: "new @me", mentions: ["me"] }),
      ],
      "me",
      10,
    );
    expect(digest.messages).toBe(1);
    expect(digest.mentions).toBe(1);
    expect(digest.items[0]).toMatchObject({ seq: 11, kind: "mention", attention: true });
  });

  test("counts open and responded mentions using reply_to", () => {
    const digest = summarizeCatchup(
      [
        msg({ seq: 20, sender: "alice", body: "@me please check", mentions: ["me"] }),
        msg({ seq: 21, sender: "me", body: "checked", replyTo: 20 }),
      ],
      "me",
      19,
    );
    expect(digest.mentions).toBe(1);
    expect(digest.respondedMentions).toBe(1);
    expect(digest.replies).toBe(1);
    expect(digest.items.some((item) => item.kind === "handled")).toBe(true);
  });

  test("counts responded mentions using status summary_seq", () => {
    const digest = summarizeCatchup(
      [
        msg({ seq: 30, sender: "alice", body: "@me need a summary", mentions: ["me"] }),
        status({ seq: 31, sender: "me", state: "done", note: "summary posted", summarySeq: 30 }),
      ],
      "me",
      29,
    );
    expect(digest.mentions).toBe(1);
    expect(digest.respondedMentions).toBe(1);
    expect(digest.done).toBe(1);
  });

  test("summarizes statuses, releases, issues, and questions", () => {
    const digest = summarizeCatchup(
      [
        status({ seq: 40, state: "blocked", note: "need owner token" }),
        status({ seq: 41, state: "done", note: "v0.2.24 shipped for #22" }),
        msg({ seq: 42, body: "open question?" }),
      ],
      "me",
      39,
    );
    expect(digest.statuses).toBe(2);
    expect(digest.blocked).toBe(1);
    expect(digest.done).toBe(1);
    expect(digest.releases).toBe(1);
    expect(digest.issues).toBe(1);
    expect(digest.questions).toBe(1);
    expect(digest.attentionItems.map((item) => item.kind)).toEqual(["question", "blocked"]);
    expect(digest.updateItems.map((item) => item.kind)).toEqual(["release"]);
  });

  test("puts actionable items before routine updates", () => {
    const digest = summarizeCatchup(
      [
        msg({ seq: 60, body: "v0.2.30 released" }),
        msg({ seq: 61, body: "@me please decide", mentions: ["me"] }),
        msg({ seq: 62, body: "ordinary reply", replyTo: 60 }),
      ],
      "me",
      59,
    );
    expect(digest.items.map((item) => item.seq)).toEqual([61, 62, 60]);
    expect(digest.attentionItems).toHaveLength(1);
  });

  test("does not mislabel a plain issue or PR reference as a release", () => {
    const digest = summarizeCatchup(
      [msg({ seq: 70, body: "reviewed #783; two comments remain" })],
      "me",
      69,
    );
    expect(digest.releases).toBe(0);
    expect(digest.issues).toBe(1);
    expect(digest.updateItems.map((item) => item.kind)).toEqual(["issue"]);
  });

  test("compacts whitespace and clips long bodies", () => {
    const text = compactDigestText(msg({ seq: 50, body: `line one\n${"x".repeat(180)}` }));
    expect(text).not.toContain("\n");
    expect(text.length).toBe(120);
    expect(text.endsWith("...")).toBe(true);
  });
});
