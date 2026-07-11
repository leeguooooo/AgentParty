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

  it("retract scrubs the body everywhere — not readable via revision, audit, or search (#196)", async () => {
    const { slug, owner, writer } = await scopedFixture();
    const sent = await postMessage(slug, writer.token, "needle secret");
    const seq = ((await sent.json()) as { seq: number }).seq;

    const retracted = await api(`/api/channels/${slug}/messages/${seq}/retract`, owner.token, { method: "POST" });
    expect(retracted.status).toBe(200);
    const message = ((await retracted.json()) as { message: MsgLike }).message;
    // 正文清空；revision.original_body 不得带回密钥——否则 retract 响应帧 / hello 补拉 / history 会重发它
    expect(message).toMatchObject({ seq, body: "", retracted: true });
    expect(message.revision?.original_body ?? null).toBe(null);

    // search 命不中
    const search = await api(`/api/channels/${slug}/search?q=needle`, writer.token);
    expect(search.status).toBe(200);
    expect(((await search.json()) as { hits: unknown[] }).hits).toEqual([]);

    // 审计端点也读不回密钥：retract 只记「谁在何时撤回了 seq」，old_body 必须为 null
    const audit = await api(`/api/channels/${slug}/messages/${seq}/audit`, owner.token);
    expect(audit.status).toBe(200);
    const auditRows = ((await audit.json()) as { audit: Array<{ action: string; old_body: string | null }> }).audit;
    const retractRow = auditRows.find((r) => r.action === "retract");
    expect(retractRow).toBeDefined();
    expect(retractRow!.old_body).toBe(null);
    expect(JSON.stringify(auditRows)).not.toContain("needle secret");

    // 补拉 history（模拟 hello 补拉）同样不含密钥
    const history = await api(`/api/channels/${slug}/messages?since=0&limit=1000`, owner.token);
    expect(JSON.stringify(await history.json())).not.toContain("needle secret");
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
