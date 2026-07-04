import { describe, expect, test } from "bun:test";
import type { MsgFrame } from "@agentparty/shared";
import { channelReducer, initialChannelState } from "./state";

function msgFrame(seq: number, body: string, over: Partial<MsgFrame> = {}): MsgFrame {
  return {
    type: "msg",
    seq,
    sender: { name: "bob", kind: "agent" },
    kind: "message",
    body,
    mentions: [],
    reply_to: null,
    state: null,
    note: null,
    ts: 1_725_000_000_000 + seq,
    ...over,
  };
}

describe("channel state", () => {
  test("ignores duplicate history frames without revision metadata", () => {
    const first = channelReducer(initialChannelState, { type: "frame", frame: msgFrame(6, "original") });
    const duplicate = channelReducer(first, { type: "frame", frame: msgFrame(6, "stale duplicate") });

    expect(duplicate.messages).toHaveLength(1);
    expect(duplicate.messages[0]?.body).toBe("original");
  });

  test("replaces same-seq history frames when they carry revision metadata", () => {
    const first = channelReducer(initialChannelState, { type: "frame", frame: msgFrame(6, "original") });
    const revised = channelReducer(first, {
      type: "frame",
      frame: msgFrame(6, "edited", { edited: true, edited_at: 1_725_000_000_999, edited_by: "bob" }),
    });

    expect(revised.messages).toHaveLength(1);
    expect(revised.messages[0]).toMatchObject({ seq: 6, body: "edited", edited: true });
  });
});
