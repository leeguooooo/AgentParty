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

  // #128：撤回的设计场景是抹掉误发的密钥。清空 body 与 search 不够——正文此前还活在
  // messages.original_body（rowToFrame 会当 revision.original_body 广播回去）和 message_audit 里。
  // 撤回必须抹掉全部正文，只留问责痕迹。
  it("lets a moderator retract another sender and scrubs the body everywhere", async () => {
    const { slug, owner, writer } = await scopedFixture();
    const sent = await postMessage(slug, writer.token, "needle secret");
    const seq = ((await sent.json()) as { seq: number }).seq;

    const retracted = await api(`/api/channels/${slug}/messages/${seq}/retract`, owner.token, { method: "POST" });
    expect(retracted.status).toBe(200);
    const retractedMsg = ((await retracted.json()) as { message: MsgLike }).message;
    expect(retractedMsg).toMatchObject({ seq, body: "", retracted: true });
    // 撤回响应帧不得再回泄正文
    expect(retractedMsg.revision?.original_body ?? null).toBeNull();

    // search 抹掉
    const search = await api(`/api/channels/${slug}/search?q=needle`, writer.token);
    expect(search.status).toBe(200);
    expect(((await search.json()) as { hits: unknown[] }).hits).toEqual([]);

    // /audit 端点不得再读回密钥：留痕迹（action=retract）但正文为 null
    const audit = await api(`/api/channels/${slug}/messages/${seq}/audit`, owner.token);
    expect(audit.status).toBe(200);
    const rows = ((await audit.json()) as { audit: Array<{ action: string; old_body: string | null; new_body: string | null }> }).audit;
    expect(rows.some((r) => r.action === "retract")).toBe(true);
    for (const r of rows) {
      expect(r.old_body).toBeNull();
      expect(r.new_body).toBeNull();
    }
  });

  // 先编辑再撤回：编辑把首版写进了 audit.old_body，撤回必须把这份历史正文也抹掉。
  it("scrubs prior edit-audit bodies when a previously edited message is retracted", async () => {
    const { slug, writer } = await scopedFixture();
    const sent = await postMessage(slug, writer.token, "first secret");
    const seq = ((await sent.json()) as { seq: number }).seq;

    const edited = await api(`/api/channels/${slug}/messages/${seq}/edit`, writer.token, {
      method: "POST",
      body: JSON.stringify({ body: "second secret" }),
    });
    expect(edited.status).toBe(200);

    const retracted = await api(`/api/channels/${slug}/messages/${seq}/retract`, writer.token, { method: "POST" });
    expect(retracted.status).toBe(200);

    const audit = await api(`/api/channels/${slug}/messages/${seq}/audit`, writer.token);
    const rows = ((await audit.json()) as { audit: Array<{ old_body: string | null; new_body: string | null }> }).audit;
    // 编辑行 + 撤回行都在（痕迹保留），但没有一格正文残留
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      expect(r.old_body).toBeNull();
      expect(r.new_body).toBeNull();
    }
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
