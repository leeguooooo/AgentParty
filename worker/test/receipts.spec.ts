// 回执（#828）：「已收到但不在轮次」是消息的元数据，不是一条消息。
//
// 这些用例逐条钉死那次真实事故的两个根因：手搓回执把 seq 拼空了（失效一），以及回执与实质消息同权、
// 占 seq / 进 delivery / 要 ack，于是零信息量的回执把七条真消息挡在后面（失效二）。
import { describe, expect, it } from "vitest";
import { api, createChannel, postMessage, seedToken, uniq } from "./helpers";

interface MsgLike {
  seq: number;
  body: string;
  receipts?: { by: { name: string }; reason: string; note?: string; ts: number }[];
  rev_seq?: number;
}

interface PresenceLike {
  name: string;
  last_receipt_seq?: number;
  not_in_turn_since?: number;
}

async function fixture() {
  const acct = `${uniq("acct")}@leeguoo.com`;
  const owner = await seedToken("agent", uniq("owner"), { owner: acct });
  const slug = await createChannel(owner.token);
  const asker = await seedToken("agent", uniq("asker"), { owner: acct, channelScope: slug });
  const episodic = await seedToken("agent", uniq("episodic"), {
    owner: `${uniq("ep")}@example.com`,
    channelScope: slug,
  });
  const readonly = await seedToken("readonly", uniq("ro"), { owner: acct, channelScope: slug });
  const seq = ((await (await postMessage(slug, asker.token, "please pick this up")).json()) as { seq: number }).seq;
  return { slug, owner, asker, episodic, readonly, seq };
}

function receipt(slug: string, token: string, seq: number, body: Record<string, unknown>) {
  return api(`/api/channels/${slug}/messages/${seq}/receipt`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function messages(slug: string, token: string): Promise<MsgLike[]> {
  const res = await api(`/api/channels/${slug}/messages`, token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { messages: MsgLike[] }).messages;
}

async function presenceFor(slug: string, token: string, name: string): Promise<PresenceLike | undefined> {
  const res = await api(`/api/channels/${slug}/presence`, token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { presence: PresenceLike[] }).presence.find((entry) => entry.name === name);
}

describe("message receipts (#828)", () => {
  it("attaches the receipt to the target message without allocating a seq", async () => {
    const { slug, asker, episodic, seq } = await fixture();
    const before = await messages(slug, asker.token);

    const res = await receipt(slug, episodic.token, seq, { reason: "not_in_turn", note: "next turn" });
    expect(res.status).toBe(200);

    const after = await messages(slug, asker.token);
    // 失效二的核心：回执绝不能变成频道里的第 N+1 条消息。
    expect(after.length).toBe(before.length);
    expect(after.at(-1)?.seq).toBe(before.at(-1)?.seq);

    const target = after.find((msg) => msg.seq === seq);
    expect(target?.receipts).toHaveLength(1);
    expect(target?.receipts?.[0]?.by.name).toBe(episodic.name);
    expect(target?.receipts?.[0]?.reason).toBe("not_in_turn");
    expect(target?.receipts?.[0]?.note).toBe("next turn");
    // 修订序号必须前进，否则重连补拉（rev_seq > since_rev）拿不到这条回执。
    expect(typeof target?.rev_seq).toBe("number");
  });

  it("fills seq from the route, so a caller cannot post a receipt that names the wrong message", async () => {
    const { slug, asker, episodic, seq } = await fixture();
    // 手搓版的失效一是模板插值失败发出 `（seq ）`。这里 seq 只来自路径：body 里塞任何 seq 都不被采纳。
    const res = await receipt(slug, episodic.token, seq, { reason: "seen", seq: 99999, target_seq: 99999 });
    expect(res.status).toBe(200);

    const after = await messages(slug, asker.token);
    expect(after.find((msg) => msg.seq === seq)?.receipts).toHaveLength(1);
  });

  it("keeps one receipt per identity, latest wins", async () => {
    const { slug, asker, episodic, seq } = await fixture();
    expect((await receipt(slug, episodic.token, seq, { reason: "not_in_turn" })).status).toBe(200);
    expect((await receipt(slug, episodic.token, seq, { reason: "queued", note: "picked up" })).status).toBe(200);

    const target = (await messages(slug, asker.token)).find((msg) => msg.seq === seq);
    expect(target?.receipts).toHaveLength(1);
    expect(target?.receipts?.[0]?.reason).toBe("queued");
    expect(target?.receipts?.[0]?.note).toBe("picked up");
  });

  it("surfaces the receipt cursor on presence so who answers 'knows about it, not in turn yet'", async () => {
    const { slug, owner, episodic, seq } = await fixture();
    expect((await receipt(slug, episodic.token, seq, { reason: "not_in_turn" })).status).toBe(200);

    const entry = await presenceFor(slug, owner.token, episodic.name);
    expect(entry?.last_receipt_seq).toBe(seq);
    expect(typeof entry?.not_in_turn_since).toBe("number");
  });

  it("clears not_in_turn_since once the agent reports a non not_in_turn reason", async () => {
    const { slug, owner, episodic, seq } = await fixture();
    expect((await receipt(slug, episodic.token, seq, { reason: "not_in_turn" })).status).toBe(200);
    expect((await receipt(slug, episodic.token, seq, { reason: "queued" })).status).toBe(200);

    const entry = await presenceFor(slug, owner.token, episodic.name);
    expect(entry?.last_receipt_seq).toBe(seq);
    // 人已经回到轮次里了，再挂着「自某刻起不在轮次」就是在传播过期信息。
    expect(entry?.not_in_turn_since).toBeUndefined();
  });

  it("rejects an unknown reason, a self receipt, a readonly sender, and a missing message", async () => {
    const { slug, asker, episodic, readonly, seq } = await fixture();
    expect((await receipt(slug, episodic.token, seq, { reason: "nope" })).status).toBe(400);
    expect((await receipt(slug, episodic.token, seq, {})).status).toBe(400);
    // 给自己的消息回执没有语义。
    expect((await receipt(slug, asker.token, seq, { reason: "seen" })).status).toBe(400);
    expect((await receipt(slug, readonly.token, seq, { reason: "seen" })).status).toBe(403);
    expect((await receipt(slug, episodic.token, 999999, { reason: "seen" })).status).toBe(404);
  });

  it("rejects an oversized note instead of silently truncating it", async () => {
    const { slug, episodic, seq } = await fixture();
    const res = await receipt(slug, episodic.token, seq, { reason: "seen", note: "x".repeat(201) });
    expect(res.status).toBe(413);
  });

  it("does not create a directed delivery, so a receipt can never starve real messages", async () => {
    const { slug, owner, asker, episodic, seq } = await fixture();
    expect((await receipt(slug, episodic.token, seq, { reason: "not_in_turn" })).status).toBe(200);

    // #826 的形状：一条未 ack 的回执把后续真消息挡在队列后面。回执不进 delivery ledger，所以
    // asker（回执的接收方）身上不该因此多出任何 @ 债务。
    const entry = await presenceFor(slug, owner.token, asker.name);
    expect((entry as { unhandled_mention_count?: number } | undefined)?.unhandled_mention_count ?? 0).toBe(0);
  });

  it("refuses to receipt a retracted message", async () => {
    const { slug, asker, episodic, seq } = await fixture();
    const retract = await api(`/api/channels/${slug}/messages/${seq}/retract`, asker.token, { method: "POST" });
    expect(retract.status).toBe(200);
    expect((await receipt(slug, episodic.token, seq, { reason: "seen" })).status).toBe(400);
  });
});
