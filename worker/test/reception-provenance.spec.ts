import type { MsgFrame, PresenceEntry, ResponseSource } from "@agentparty/shared";
import { describe, expect, it } from "vitest";
import { api, createChannel, seedToken } from "./helpers";

async function send(
  slug: string,
  token: string,
  payload: Record<string, unknown>,
): Promise<{ seq: number }> {
  const response = await api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { seq: number };
}

describe("resident reception provenance and unresolved mention debt", () => {
  it("persists runner provenance and clears the target's unresolved @ after a linked reply", async () => {
    const owner = await seedToken("human");
    const agent = await seedToken("agent");
    const slug = await createChannel(owner.token);

    await send(slug, agent.token, {
      kind: "status",
      state: "waiting",
      note: "resident reception ready",
      mentions: [],
      context: {
        reception_mode: "model",
        reception_runner: "codex",
        reception_context: "isolated_channel_session",
      },
    });

    const mention = await send(slug, owner.token, {
      kind: "message",
      body: `@${agent.name} please check`,
      mentions: [agent.name],
      reply_to: null,
    });

    const before = (await (await api(`/api/channels/${slug}/presence`, owner.token)).json()) as {
      presence: PresenceEntry[];
    };
    expect(before.presence.find((entry) => entry.name === agent.name)).toMatchObject({
      unhandled_mention_count: 1,
      oldest_unhandled_mention_seq: mention.seq,
      context: {
        reception_mode: "model",
        reception_runner: "codex",
        reception_context: "isolated_channel_session",
      },
    });

    const responseSource: ResponseSource = {
      kind: "reception_runner",
      runner: "codex",
      context: "isolated_channel_session",
      session: "resumed",
      trigger_seq: mention.seq,
    };
    const reply = await send(slug, agent.token, {
      kind: "message",
      body: "checked",
      mentions: [],
      reply_to: mention.seq,
      response_source: responseSource,
    });

    const history = (await (await api(`/api/channels/${slug}/messages`, owner.token)).json()) as {
      messages: MsgFrame[];
    };
    expect(history.messages.find((message) => message.seq === reply.seq)?.response_source).toEqual(responseSource);

    const after = (await (await api(`/api/channels/${slug}/presence`, owner.token)).json()) as {
      presence: PresenceEntry[];
    };
    const agentPresence = after.presence.find((entry) => entry.name === agent.name);
    expect(agentPresence).not.toHaveProperty("unhandled_mention_count");
    expect(agentPresence).not.toHaveProperty("oldest_unhandled_mention_seq");
  });

  it("rejects malformed response provenance instead of storing a misleading badge", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const response = await api(`/api/channels/${slug}/messages`, agent.token, {
      method: "POST",
      body: JSON.stringify({
        kind: "message",
        body: "bad provenance",
        mentions: [],
        reply_to: null,
        response_source: {
          kind: "reception_runner",
          runner: "codex",
          context: "owner_current_session",
          session: "resumed",
          trigger_seq: 1,
        },
      }),
    });
    expect(response.status).toBe(400);
  });
});
