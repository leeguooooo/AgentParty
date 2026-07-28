import { describe, expect, it } from "bun:test";
import type { MsgFrame } from "@agentparty/shared";
import { buildIdentityDisplay, resolveAgentOwnerLabel } from "./identityDisplay";

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

  it("prefers a human display name over an opaque handle and owner/email", () => {
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
          sender: {
            name: uuid,
            kind: "human",
            owner: "thejacks@163.com",
            handle: "oidc-a1b2c3d4e5f60708",
            display_name: "Jane Zhang",
          },
          mentions: [],
          reply_to: null,
        } as MsgFrame,
      ],
      participants: [
        {
          name: uuid,
          kind: "human",
          owner: "thejacks@163.com",
          handle: "oidc-a1b2c3d4e5f60708",
          display_name: "Jane Zhang",
        },
      ],
      presence: {
        [uuid]: {
          name: uuid,
          kind: "human",
          account: "thejacks@163.com",
          handle: "oidc-a1b2c3d4e5f60708",
          display_name: "Jane Zhang",
          state: "working",
          note: null,
          ts: 1,
        },
      },
    });

    expect(map[uuid]).toEqual({ display: "Jane Zhang", kind: "human", account: "thejacks@163.com" });
  });
});

describe("resolveAgentOwnerLabel", () => {
  it("resolves an opaque agent owner account to the linked human display name", () => {
    const identities = buildIdentityDisplay({
      channelIdentities: [
        {
          name: "human-session",
          display: "王路",
          kind: "human",
          account: "lark:on_184c134fbca61311e57a76d581763c84",
        },
      ],
      mentionOptions: [],
      messages: [],
      participants: [],
      presence: {},
    });

    expect(
      resolveAgentOwnerLabel(
        { kind: "agent", owner: "lark:on_184c134fbca61311e57a76d581763c84" },
        identities,
      ),
    ).toBe("王路");
  });

  it("keeps a readable owner when no human identity is available", () => {
    expect(resolveAgentOwnerLabel({ kind: "agent", owner: "team@example.com" }, undefined)).toBe(
      "team@example.com",
    );
  });

  it("does not expose an unresolved opaque owner account", () => {
    expect(resolveAgentOwnerLabel({ kind: "agent", owner: "lark:on_unknown" }, undefined)).toBeNull();
  });
});
