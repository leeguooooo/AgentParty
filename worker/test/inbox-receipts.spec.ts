// #1130：Claude 收件箱回执挂到被 @ 的那条消息上。
//
// 铁律：@ 欠账只认对方的回复 / ack。held / expired / refused / dropped / denied 证明的是**没送达**，
// delivered 证明的是「被扣的消息进了对话」，都不是 ack——所以这里的每一条状态都不许动欠账，
// 而 `accepted`（没有回执）根本不是一个能上报的状态。
import { describe, expect, it } from "vitest";
import { INBOX_RECEIPT_MAX_PER_MESSAGE, INBOX_RECEIPT_STATES, type InboxReceiptState } from "@agentparty/shared";
import { WsClient, api, createChannel, seedToken, uniq } from "./helpers";

interface InboxLike {
  target: string;
  state: string;
  reported_by: { name: string; owner?: string };
  reason?: string;
  held_at?: number;
  ts: number;
}
interface MsgLike {
  seq: number;
  body: string;
  inbox_receipts?: InboxLike[];
  rev_seq?: number;
}
interface PresenceLike {
  name: string;
  unhandled_mention_count?: number;
  pending_mention_seqs?: number[];
  inbox_pending?: { seq: number; state: string }[];
  wake?: { kind: string; verified_at?: number };
}

function send(slug: string, token: string, body: string, mentions: string[] = [], extra: Record<string, unknown> = {}) {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body, mentions, reply_to: null, ...extra }),
  });
}

function checkIn(slug: string, token: string) {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "status", state: "waiting", note: "standby", mentions: [] }),
  });
}

async function fixture() {
  const acct = `${uniq("acct")}@leeguoo.com`;
  const sender = await seedToken("agent", uniq("asker"), { owner: acct });
  const slug = await createChannel(sender.token);
  const bot = await seedToken("agent", uniq("claude-bot"), { owner: acct, channelScope: slug });
  const relay = await seedToken("agent", uniq("serve-relay"), { owner: acct, channelScope: slug });
  const readonly = await seedToken("readonly", uniq("ro"), { owner: acct, channelScope: slug });
  await checkIn(slug, bot.token);
  const res = await send(slug, sender.token, `@${bot.name} please look`, [bot.name]);
  expect(res.status).toBe(200);
  const seq = ((await res.json()) as { seq: number }).seq;
  return { slug, sender, bot, relay, readonly, seq, acct };
}

function report(slug: string, token: string, seq: number, body: Record<string, unknown>) {
  return api(`/api/channels/${slug}/messages/${seq}/inbox-receipt`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function messageOf(slug: string, token: string, seq: number): Promise<MsgLike> {
  const res = await api(`/api/channels/${slug}/messages`, token);
  expect(res.status).toBe(200);
  const found = ((await res.json()) as { messages: MsgLike[] }).messages.find((msg) => msg.seq === seq);
  expect(found).toBeDefined();
  return found!;
}

async function presenceOf(slug: string, token: string, name: string): Promise<PresenceLike> {
  const res = await api(`/api/channels/${slug}/presence`, token);
  expect(res.status).toBe(200);
  const entry = ((await res.json()) as { presence: PresenceLike[] }).presence.find((p) => p.name === name);
  expect(entry).toBeDefined();
  return entry!;
}

async function nextMention(slug: string, token: string): Promise<number | null> {
  const res = await api(`/api/channels/${slug}/next-mention?since=0`, token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { seq: number | null }).seq;
}

const TERMINAL = INBOX_RECEIPT_STATES.filter((state) => state !== "held");

describe("Claude inbox receipts on the mentioning message (#1130)", () => {
  it("records held on the message without allocating a seq, and bumps rev_seq", async () => {
    const { slug, sender, bot, seq } = await fixture();
    const before = await api(`/api/channels/${slug}/messages`, sender.token).then(
      async (res) => ((await res.json()) as { messages: MsgLike[] }).messages,
    );

    const res = await report(slug, bot.token, seq, { target: bot.name, state: "held", reason: "held for approval" });
    expect(res.status).toBe(200);

    const after = await api(`/api/channels/${slug}/messages`, sender.token).then(
      async (r) => ((await r.json()) as { messages: MsgLike[] }).messages,
    );
    expect(after.length).toBe(before.length);
    const msg = after.find((m) => m.seq === seq)!;
    expect(msg.inbox_receipts).toHaveLength(1);
    expect(msg.inbox_receipts![0]).toMatchObject({
      target: bot.name,
      state: "held",
      reason: "held for approval",
      reported_by: { name: bot.name },
    });
    expect(typeof msg.inbox_receipts![0]!.held_at).toBe("number");
    // 重连补拉按 rev_seq > since_rev 取修订：不前进就拿不到这条回执。
    expect(typeof msg.rev_seq).toBe("number");
    // 上报者的邮箱不进这条元数据。
    expect(msg.inbox_receipts![0]!.reported_by.owner).toBeUndefined();
  });

  it("takes the reporter from the bearer, never from the body", async () => {
    const { slug, sender, bot, relay, seq } = await fixture();
    const res = await report(slug, relay.token, seq, {
      target: bot.name,
      state: "held",
      reported_by: { name: bot.name, kind: "agent" },
    });
    expect(res.status).toBe(200);
    const msg = await messageOf(slug, sender.token, seq);
    expect(msg.inbox_receipts![0]!.reported_by.name).toBe(relay.name);
  });

  for (const terminal of TERMINAL) {
    it(`held → ${terminal} is applied once and keeps held_at`, async () => {
      const { slug, sender, bot, seq } = await fixture();
      expect((await report(slug, bot.token, seq, { target: bot.name, state: "held" })).status).toBe(200);
      const heldAt = (await messageOf(slug, sender.token, seq)).inbox_receipts![0]!.held_at;
      expect((await report(slug, bot.token, seq, { target: bot.name, state: terminal })).status).toBe(200);
      const msg = await messageOf(slug, sender.token, seq);
      expect(msg.inbox_receipts).toHaveLength(1);
      expect(msg.inbox_receipts![0]!.state).toBe(terminal);
      expect(msg.inbox_receipts![0]!.held_at).toBe(heldAt);
    });

    it(`${terminal} can be recorded without a prior held (the held report may have been lost)`, async () => {
      const { slug, sender, bot, seq } = await fixture();
      expect((await report(slug, bot.token, seq, { target: bot.name, state: terminal })).status).toBe(200);
      const msg = await messageOf(slug, sender.token, seq);
      expect(msg.inbox_receipts![0]!.state).toBe(terminal);
      expect(msg.inbox_receipts![0]!.held_at).toBeUndefined();
    });

    it(`${terminal} is final: another state is refused, the same state is a no-op`, async () => {
      const { slug, sender, bot, seq } = await fixture();
      expect((await report(slug, bot.token, seq, { target: bot.name, state: terminal })).status).toBe(200);
      const first = (await messageOf(slug, sender.token, seq)).inbox_receipts![0]!;
      for (const other of INBOX_RECEIPT_STATES.filter((state) => state !== terminal)) {
        expect((await report(slug, bot.token, seq, { target: bot.name, state: other })).status).toBe(409);
      }
      const again = await report(slug, bot.token, seq, { target: bot.name, state: terminal, reason: "rewritten" });
      expect(again.status).toBe(200);
      expect(((await again.json()) as { deduped?: boolean }).deduped).toBe(true);
      // 幂等重报不改写已记录的条目（原因、时间都不动）。
      expect((await messageOf(slug, sender.token, seq)).inbox_receipts![0]).toEqual(first);
    });
  }

  it("a repeated held is a no-op", async () => {
    const { slug, sender, bot, seq } = await fixture();
    expect((await report(slug, bot.token, seq, { target: bot.name, state: "held" })).status).toBe(200);
    const first = (await messageOf(slug, sender.token, seq)).inbox_receipts![0]!;
    const again = await report(slug, bot.token, seq, { target: bot.name, state: "held" });
    expect(((await again.json()) as { deduped?: boolean }).deduped).toBe(true);
    expect((await messageOf(slug, sender.token, seq)).inbox_receipts![0]).toEqual(first);
  });

  it("refuses `accepted` and any other unknown state — no receipt is not a read receipt", async () => {
    const { slug, sender, bot, seq } = await fixture();
    for (const state of ["accepted", "read", "ok", "", 1, null]) {
      expect((await report(slug, bot.token, seq, { target: bot.name, state })).status).toBe(400);
    }
    expect((await report(slug, bot.token, seq, { target: bot.name })).status).toBe(400);
    expect((await messageOf(slug, sender.token, seq)).inbox_receipts).toBeUndefined();
  });

  it("refuses a target the message does not mention, a missing target, a readonly reporter, a missing message", async () => {
    const { slug, sender, bot, relay, readonly, seq } = await fixture();
    expect((await report(slug, bot.token, seq, { target: relay.name, state: "held" })).status).toBe(400);
    expect((await report(slug, bot.token, seq, { state: "held" })).status).toBe(400);
    expect((await report(slug, readonly.token, seq, { target: bot.name, state: "held" })).status).toBe(403);
    expect((await report(slug, bot.token, 999999, { target: bot.name, state: "held" })).status).toBe(404);
    // 一条没有 @ 的消息上挂不了任何收件箱回执。
    const plain = ((await (await send(slug, sender.token, "no mentions")).json()) as { seq: number }).seq;
    expect((await report(slug, bot.token, plain, { target: bot.name, state: "held" })).status).toBe(400);
    expect((await messageOf(slug, sender.token, seq)).inbox_receipts).toBeUndefined();
  });

  it("collapses the receiver-controlled reason to one line and rejects an oversized one", async () => {
    const { slug, sender, bot, seq } = await fixture();
    expect(
      (await report(slug, bot.token, seq, { target: bot.name, state: "held", reason: "line one\n\u001b[31mline two\t end" })).status,
    ).toBe(200);
    expect((await messageOf(slug, sender.token, seq)).inbox_receipts![0]!.reason).toBe("line one [31mline two end");
    const other = await fixture();
    expect(
      (await report(other.slug, other.bot.token, other.seq, { target: other.bot.name, state: "held", reason: "x".repeat(201) })).status,
    ).toBe(413);
  });

  it("refuses a retracted message", async () => {
    const { slug, sender, bot, seq } = await fixture();
    expect((await api(`/api/channels/${slug}/messages/${seq}/retract`, sender.token, { method: "POST" })).status).toBe(200);
    const res = await report(slug, bot.token, seq, { target: bot.name, state: "held" });
    expect(res.status).toBe(400);
    // 撤回会清空 mentions，所以「目标没被 @」那道检查也会拦下它；这里钉的是更准确的那条原因。
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("retracted");
  });

  it("keeps one entry per (target, reporter) and caps entries per message", async () => {
    const { slug, sender, bot, relay, seq, acct } = await fixture();
    expect((await report(slug, bot.token, seq, { target: bot.name, state: "held" })).status).toBe(200);
    expect((await report(slug, relay.token, seq, { target: bot.name, state: "expired" })).status).toBe(200);
    const msg = await messageOf(slug, sender.token, seq);
    expect(msg.inbox_receipts!.map((r) => `${r.reported_by.name}:${r.state}`).sort()).toEqual(
      [`${bot.name}:held`, `${relay.name}:expired`].sort(),
    );
    let refused = 0;
    for (let i = 0; i < INBOX_RECEIPT_MAX_PER_MESSAGE; i += 1) {
      const extra = await seedToken("agent", uniq("extra"), { owner: acct, channelScope: slug });
      const res = await report(slug, extra.token, seq, { target: bot.name, state: "held" });
      if (res.status === 409) refused += 1;
      else expect(res.status).toBe(200);
    }
    expect(refused).toBe(2);
    expect((await messageOf(slug, sender.token, seq)).inbox_receipts).toHaveLength(INBOX_RECEIPT_MAX_PER_MESSAGE);
    // 已有条目的上报者仍能把自己的 held 收尾——封顶只挡新条目。
    expect((await report(slug, bot.token, seq, { target: bot.name, state: "expired" })).status).toBe(200);
  });

  it("broadcasts message_update with the legacy `receipt` action so un-upgraded clients keep the frame", async () => {
    const { slug, sender, bot, seq } = await fixture();
    const ws = await WsClient.open(slug, sender.token);
    ws.send({ type: "hello", since: seq });
    await ws.nextOfType("welcome");
    expect((await report(slug, bot.token, seq, { target: bot.name, state: "held" })).status).toBe(200);
    const update = await ws.nextOfType("message_update");
    expect(update.action).toBe("receipt");
    expect(update.target_seq).toBe(seq);
    expect(update.message.inbox_receipts?.[0]?.state).toBe("held");
    ws.close();
  });
});

describe("inbox receipts never settle or create @ debt (#1130)", () => {
  for (const state of INBOX_RECEIPT_STATES) {
    it(`${state} leaves the mention owed`, async () => {
      const { slug, sender, bot, seq } = await fixture();
      const before = await presenceOf(slug, sender.token, bot.name);
      expect(before.pending_mention_seqs).toEqual([seq]);
      expect(await nextMention(slug, bot.token)).toBe(seq);

      if (state !== "held") {
        expect((await report(slug, bot.token, seq, { target: bot.name, state: "held" })).status).toBe(200);
      }
      expect((await report(slug, bot.token, seq, { target: bot.name, state })).status).toBe(200);

      const after = await presenceOf(slug, sender.token, bot.name);
      expect(after.unhandled_mention_count).toBe(1);
      expect(after.pending_mention_seqs).toEqual([seq]);
      expect(await nextMention(slug, bot.token)).toBe(seq);
      // 回执不是「服务端亲眼看到被 @ 后 resume」，不许盖 wake verified。
      expect(after.wake?.verified_at).toBeUndefined();
      // delivered 已进对话，只是还没回：不再标注；其余状态在 who 上解释欠账为什么还在。
      const expected: { seq: number; state: InboxReceiptState }[] = state === "delivered" ? [] : [{ seq, state }];
      expect(after.inbox_pending ?? []).toEqual(expected);
    });
  }

  it("does not touch the wake delivery ledger", async () => {
    const { slug, sender, bot, seq } = await fixture();
    const ledger = async () =>
      ((await (await api(`/api/channels/${slug}/wake-deliveries?since=0&limit=100`, sender.token)).json()) as {
        deliveries: unknown[];
      }).deliveries;
    const before = await ledger();
    expect((await report(slug, bot.token, seq, { target: bot.name, state: "held" })).status).toBe(200);
    expect((await report(slug, bot.token, seq, { target: bot.name, state: "delivered" })).status).toBe(200);
    expect(await ledger()).toEqual(before);
  });

  it("only the target's reply settles the mention; the annotation then disappears", async () => {
    const { slug, sender, bot, seq } = await fixture();
    expect((await report(slug, bot.token, seq, { target: bot.name, state: "held" })).status).toBe(200);
    expect((await presenceOf(slug, sender.token, bot.name)).inbox_pending).toEqual([{ seq, state: "held" }]);

    expect((await send(slug, bot.token, "on it", [], { reply_to: seq })).status).toBe(200);

    const after = await presenceOf(slug, sender.token, bot.name);
    expect(after.unhandled_mention_count ?? 0).toBe(0);
    expect(after.pending_mention_seqs).toBeUndefined();
    expect(after.inbox_pending).toBeUndefined();
    // 回执本身留在消息上（历史事实），只是不再作为欠账的注解。
    expect((await messageOf(slug, sender.token, seq)).inbox_receipts![0]!.state).toBe("held");
  });

  it("annotates only the identity the receipt is for", async () => {
    const { slug, sender, bot, relay, seq } = await fixture();
    await checkIn(slug, relay.token);
    expect((await report(slug, relay.token, seq, { target: bot.name, state: "expired" })).status).toBe(200);
    expect((await presenceOf(slug, sender.token, bot.name)).inbox_pending).toEqual([{ seq, state: "expired" }]);
    expect((await presenceOf(slug, sender.token, relay.name)).inbox_pending).toBeUndefined();
  });

  it("prefers the target's own report over a third party's", async () => {
    const { slug, sender, bot, relay, seq } = await fixture();
    expect((await report(slug, bot.token, seq, { target: bot.name, state: "held" })).status).toBe(200);
    expect((await report(slug, relay.token, seq, { target: bot.name, state: "expired" })).status).toBe(200);
    expect((await presenceOf(slug, sender.token, bot.name)).inbox_pending).toEqual([{ seq, state: "held" }]);
  });
});

describe("inbox receipts and identity erasure (#1130)", () => {
  it("drops entries that name the erased identity as target or reporter", async () => {
    const acct = `${uniq("acct")}@leeguoo.com`;
    const owner = await seedToken("agent", uniq("owner"), { owner: acct });
    const slug = await createChannel(owner.token);
    const bot = await seedToken("agent", uniq("bot"), { owner: acct, channelScope: slug });
    const relay = await seedToken("agent", uniq("relay"), { owner: acct, channelScope: slug });
    const other = await seedToken("agent", uniq("other"), { owner: acct, channelScope: slug });
    const seq = ((await (await send(slug, owner.token, "hi", [bot.name, other.name])).json()) as { seq: number }).seq;
    expect((await report(slug, bot.token, seq, { target: bot.name, state: "held" })).status).toBe(200);
    expect((await report(slug, relay.token, seq, { target: other.name, state: "expired" })).status).toBe(200);
    expect((await report(slug, bot.token, seq, { target: other.name, state: "held" })).status).toBe(200);

    const erase = await api(`/api/channels/${slug}/identity/${encodeURIComponent(bot.name)}/data`, owner.token, {
      method: "DELETE",
    });
    expect(erase.status).toBe(200);

    const msg = await messageOf(slug, owner.token, seq);
    expect(msg.inbox_receipts).toHaveLength(1);
    expect(msg.inbox_receipts![0]).toMatchObject({ target: other.name, reported_by: { name: relay.name } });
  });
});
