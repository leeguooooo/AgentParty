import { describe, expect, it } from "vitest";
import { WsClient, api, createChannel, postMessage, seedToken, uniq } from "./helpers";

interface MsgLike {
  seq: number;
  body: string;
  edited?: true;
  retracted?: true;
  supersedes?: number;
  superseded_by?: number;
  revision?: { original_body: string | null };
}

async function scopedFixture() {
  const acct = `${uniq("acct")}@leeguoo.com`;
  const owner = await seedToken("agent", uniq("owner"), { owner: acct });
  const slug = await createChannel(owner.token);
  const writer = await seedToken("agent", uniq("writer"), { owner: acct, channelScope: slug });
  const other = await seedToken("agent", uniq("other"), { owner: acct, channelScope: slug });
  return { slug, owner, writer, other };
}

describe("message edit/retract/supersede", () => {
  it("lets the sender edit with audit fields and blocks a non-moderator", async () => {
    const { slug, writer, other } = await scopedFixture();
    const sent = await postMessage(slug, writer.token, "wrong body");
    const seq = ((await sent.json()) as { seq: number }).seq;

    const denied = await api(`/api/channels/${slug}/messages/${seq}/edit`, other.token, {
      method: "POST",
      body: JSON.stringify({ body: "hijack" }),
    });
    expect(denied.status).toBe(403);

    const edited = await api(`/api/channels/${slug}/messages/${seq}/edit`, writer.token, {
      method: "POST",
      body: JSON.stringify({ body: "correct body" }),
    });
    expect(edited.status).toBe(200);
    const editBody = (await edited.json()) as { message: MsgLike };
    expect(editBody.message).toMatchObject({
      seq,
      body: "correct body",
      edited: true,
      revision: { original_body: "wrong body" },
    });

    const history = await api(`/api/channels/${slug}/messages?since=0`, writer.token);
    const messages = ((await history.json()) as { messages: MsgLike[] }).messages;
    expect(messages[0]).toMatchObject({ seq, body: "correct body", edited: true });

    const audit = await api(`/api/channels/${slug}/messages/${seq}/audit`, writer.token);
    expect(audit.status).toBe(200);
    expect((await audit.json()) as { audit: unknown[] }).toMatchObject({
      audit: [{ target_seq: seq, action: "edit", old_body: "wrong body", new_body: "correct body" }],
    });
  });

  it("lets a moderator retract another sender and removes it from search", async () => {
    const { slug, owner, writer } = await scopedFixture();
    const sent = await postMessage(slug, writer.token, "needle secret");
    const seq = ((await sent.json()) as { seq: number }).seq;

    const retracted = await api(`/api/channels/${slug}/messages/${seq}/retract`, owner.token, { method: "POST" });
    expect(retracted.status).toBe(200);
    expect(((await retracted.json()) as { message: MsgLike }).message).toMatchObject({
      seq,
      body: "",
      retracted: true,
      revision: { original_body: "needle secret" },
    });

    const search = await api(`/api/channels/${slug}/search?q=needle`, writer.token);
    expect(search.status).toBe(200);
    expect(((await search.json()) as { hits: unknown[] }).hits).toEqual([]);
  });

  it("supersedes with a new linked message", async () => {
    const { slug, writer } = await scopedFixture();
    const sent = await postMessage(slug, writer.token, "old claim");
    const seq = ((await sent.json()) as { seq: number }).seq;

    const supersede = await api(`/api/channels/${slug}/messages/${seq}/supersede`, writer.token, {
      method: "POST",
      body: JSON.stringify({ body: "new claim" }),
    });
    expect(supersede.status).toBe(200);
    const body = (await supersede.json()) as { message: MsgLike; superseded: MsgLike };
    expect(body.message).toMatchObject({ seq: seq + 1, body: "new claim", supersedes: seq });
    expect(body.superseded).toMatchObject({ seq, superseded_by: seq + 1 });
  });

  it("broadcasts message_update for live clients", async () => {
    const { slug, writer } = await scopedFixture();
    const sent = await postMessage(slug, writer.token, "live wrong");
    const seq = ((await sent.json()) as { seq: number }).seq;
    const ws = await WsClient.open(slug, writer.token);
    await ws.nextOfType("welcome");

    const edit = await api(`/api/channels/${slug}/messages/${seq}/edit`, writer.token, {
      method: "POST",
      body: JSON.stringify({ body: "live correct" }),
    });
    expect(edit.status).toBe(200);
    const update = await ws.nextOfType("message_update");
    expect(update).toMatchObject({
      type: "message_update",
      target_seq: seq,
      action: "edit",
      message: { seq, body: "live correct", edited: true },
    });
    ws.close();
  });
});
