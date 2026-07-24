import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, createChannel, postMessage, seedToken, uniq, WsClient } from "./helpers";

describe("channel participant binding writes", () => {
  it("does not turn successful channel reads into D1 writes", async () => {
    const account = `${uniq("reader")}@example.com`;
    const reader = await seedToken("human", uniq("reader"), { owner: account });
    const slug = await createChannel(reader.token);

    const read = await api(`/api/channels/${slug}/messages?since=0&limit=1`, reader.token);
    expect(read.status).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT account FROM channel_participant_bindings WHERE channel_slug = ? AND participant_name = ?",
      ).bind(slug, reader.name).first(),
    ).toBeNull();

    expect((await postMessage(slug, reader.token, "bind on mutation")).status).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT account FROM channel_participant_bindings WHERE channel_slug = ? AND participant_name = ?",
      ).bind(slug, reader.name).first<{ account: string }>(),
    ).toEqual({ account });
  });

  it("still records an accepted WebSocket participant", async () => {
    const account = `${uniq("socket")}@example.com`;
    const participant = await seedToken("human", uniq("socket"), { owner: account });
    const slug = await createChannel(participant.token);
    const socket = await WsClient.open(slug, participant.token);
    await socket.nextOfType("welcome");

    expect(
      await env.DB.prepare(
        "SELECT account FROM channel_participant_bindings WHERE channel_slug = ? AND participant_name = ?",
      ).bind(slug, participant.name).first<{ account: string }>(),
    ).toEqual({ account });
    socket.close();
  });
});
