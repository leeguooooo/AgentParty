import { describe, expect, it } from "bun:test";
import type { MsgFrame } from "@agentparty/shared";
import { buildIdentityDisplay } from "./identityDisplay";

describe("buildIdentityDisplay", () => {
  it("keeps readable server identity labels when mention candidates only have raw names", () => {
    const uuid = "61ec302c-6c31-4bca-a1df-88152372f6d9";
    const map = buildIdentityDisplay({
      channelIdentities: [{ name: uuid, display: "thejacks@163.com", kind: "human", account: "thejacks@163.com" }],
      mentionOptions: [{ name: uuid, display: uuid, kind: "human", tier: "online" }],
      messages: [
        {
          seq: 1,
          kind: "message",
          body: `@${uuid} hello`,
          ts: 1,
          sender: { name: "agent", kind: "agent" },
          mentions: [uuid],
          reply_to: null,
        } as MsgFrame,
      ],
      participants: [{ name: uuid, kind: "human" }],
      presence: {},
    });

    expect(map[uuid]).toEqual({ display: "thejacks@163.com", kind: "human", account: "thejacks@163.com" });
  });

  it("prefers a human's handle over owner/email for participants, presence and message senders", () => {
    const uuid = "61ec302c-6c31-4bca-a1df-88152372f6d9";
    const map = buildIdentityDisplay({
      channelIdentities: [],
      mentionOptions: [],
      messages: [
        {
          seq: 1,
          kind: "message",
          body: "hi",
          ts: 1,
          sender: { name: uuid, kind: "human", owner: "thejacks@163.com", handle: "leo" },
          mentions: [],
          reply_to: null,
        } as MsgFrame,
      ],
      participants: [{ name: uuid, kind: "human", owner: "thejacks@163.com", handle: "leo" }],
      presence: {
        [uuid]: {
          name: uuid,
          kind: "human",
          account: "thejacks@163.com",
          handle: "leo",
          state: "working",
          note: null,
          ts: 1,
        },
      },
    });

    expect(map[uuid]).toEqual({ display: "leo", kind: "human", account: "thejacks@163.com" });
  });
});
