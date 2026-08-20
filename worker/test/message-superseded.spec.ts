// #881 迟到投递的定序：worker 可能拿旧前提行动。修法**不是**按 ts 定序（ts 是本地时钟，
// 同机多 runner / 跨机漂移下比 seq 更不可信，按它排序反而引入新的错序），而是保留 seq 作为
// 唯一定序依据，另外补 superseded 显式标记让消费者识别「这条已被后续消息取代」。
//
// 判定口径刻意保守——只认「同一 sender 用 --reply-to 回到那条、并再次 @ 同一目标、且那条对该
// 目标的 delivery 仍未结清」。这里连过度标记的反例一起守：两条独立的 @ 绝不能互相标过期。
import type { MsgFrame } from "@agentparty/shared";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { WsClient, api, createChannel, seedToken, uniq } from "./helpers";

async function send(
  slug: string,
  token: string,
  body: string,
  mentions: string[],
  replyTo: number | null = null,
) {
  const res = await api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body, mentions, reply_to: replyTo }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { seq: number };
}

async function frameAt(slug: string, token: string, seq: number): Promise<MsgFrame> {
  const res = await api(`/api/channels/${slug}/messages?limit=50`, token);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { messages: MsgFrame[] };
  const found = body.messages.find((m) => m.seq === seq);
  expect(found).toBeDefined();
  return found!;
}

async function setup() {
  const owner = `${uniq("owner")}@example.com`;
  const sender = await seedToken("agent", uniq("sender"), { owner });
  const target = await seedToken("agent", uniq("target"), { owner });
  const slug = await createChannel(sender.token);
  return { owner, sender, target, slug };
}

describe("#881 superseded 显式标记", () => {
  it("同 sender 用 --reply-to 改口、并再次 @ 同一目标 → 前一条标 superseded，by_seq 指向后一条", async () => {
    const { slug, sender, target } = await setup();
    const first = await send(slug, sender.token, `@${target.name} 部署到 prod`, [target.name]);
    const second = await send(slug, sender.token, `@${target.name} 改口：先别部署`, [target.name], first.seq);

    const stale = await frameAt(slug, sender.token, first.seq);
    expect(stale.superseded).toEqual({ by_seq: second.seq, reason: "reply_correction" });
    // 定序依据只有 seq：标记指向的一定是**更大的 seq**，与任何 ts 无关。
    expect(stale.superseded!.by_seq).toBeGreaterThan(stale.seq);
    // 取代它的那条自己不是过期的。
    expect((await frameAt(slug, sender.token, second.seq)).superseded).toBeUndefined();
  });

  it("不过度标记：同 sender 同目标的两条独立 @（无 reply-to）互不标过期", async () => {
    const { slug, sender, target } = await setup();
    const first = await send(slug, sender.token, `@${target.name} 做 X`, [target.name]);
    await send(slug, sender.token, `@${target.name} 再做 Y`, [target.name]);

    // 「做 X」仍然是有效指令。把它降级掉比不标更危险——这正是本切片否掉「同目标后续消息」口径的原因。
    expect((await frameAt(slug, sender.token, first.seq)).superseded).toBeUndefined();
  });

  it("不过度标记：别人回复同一条 @ 不构成取代关系（只有原发起者能改口）", async () => {
    const { slug, owner, sender, target } = await setup();
    const other = await seedToken("agent", uniq("other"), { owner });
    const first = await send(slug, sender.token, `@${target.name} 做 X`, [target.name]);
    await send(slug, other.token, `@${target.name} 我插一句`, [target.name], first.seq);

    expect((await frameAt(slug, sender.token, first.seq)).superseded).toBeUndefined();
  });

  it("已结清的 @ 不标：它不会再被谁当成最新指令执行", async () => {
    const { slug, sender, target } = await setup();
    const first = await send(slug, sender.token, `@${target.name} 做 X`, [target.name]);
    // 目标已经回复过这条，delivery 进终态。
    await send(slug, target.token, "done", [sender.name], first.seq);
    await send(slug, sender.token, `@${target.name} 改口`, [target.name], first.seq);

    expect((await frameAt(slug, sender.token, first.seq)).superseded).toBeUndefined();
  });

  it("与 replay 正交：补拉的历史帧可以同时带 replay 与 superseded", async () => {
    const { slug, sender, target } = await setup();
    const first = await send(slug, sender.token, `@${target.name} 部署到 prod`, [target.name]);
    const second = await send(slug, sender.token, `@${target.name} 别部署`, [target.name], first.seq);

    // 逐帧读，不用 nextOfType 当屏障——它会静默丢弃途中帧，可能把该出现的帧一起吃掉造成假绿。
    const ws = await WsClient.open(slug, target.token);
    await ws.next();
    ws.send({ type: "hello", since: 0, directed_delivery: "v1" });
    let replayed: MsgFrame | null = null;
    for (let i = 0; i < 60 && replayed === null; i += 1) {
      const frame = await ws.next();
      if (frame.type === "msg" && frame.seq === first.seq) replayed = frame;
    }
    ws.close();
    expect(replayed).not.toBeNull();
    expect(replayed!.replay).toBe(true);
    expect(replayed!.superseded).toEqual({ by_seq: second.seq, reason: "reply_correction" });
  });

  it("显式 supersede 链优先，reason 报 revision", async () => {
    const { slug, sender, target } = await setup();
    const first = await send(slug, sender.token, `@${target.name} 老结论`, [target.name]);
    const res = await api(`/api/channels/${slug}/messages/${first.seq}/supersede`, sender.token, {
      method: "POST",
      body: JSON.stringify({ body: "新结论", mentions: [target.name] }),
    });
    expect(res.status).toBe(200);
    const superseded = await frameAt(slug, sender.token, first.seq);
    expect(superseded.superseded?.reason).toBe("revision");
    expect(superseded.superseded?.by_seq).toBe(superseded.superseded_by);
  });

  it("幂等：再来一条改口不覆盖已有标记（by_seq 仍指第一次取代它的那条）", async () => {
    const { slug, sender, target } = await setup();
    const first = await send(slug, sender.token, `@${target.name} 做 X`, [target.name]);
    const second = await send(slug, sender.token, `@${target.name} 改口一`, [target.name], first.seq);
    await send(slug, sender.token, `@${target.name} 改口二`, [target.name], first.seq);

    expect((await frameAt(slug, sender.token, first.seq)).superseded).toEqual({
      by_seq: second.seq,
      reason: "reply_correction",
    });
  });

  it("标记会 bump rev_seq，重连按 since_rev 补拉的客户端能收到这次修订", async () => {
    const { slug, sender, target } = await setup();
    const first = await send(slug, sender.token, `@${target.name} 做 X`, [target.name]);
    const second = await send(slug, sender.token, `@${target.name} 改口`, [target.name], first.seq);

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    const revSeq = await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      const row = state.storage.sql.exec("SELECT rev_seq FROM messages WHERE seq = ?", first.seq).toArray()[0];
      return row?.rev_seq === null || row?.rev_seq === undefined ? null : Number(row.rev_seq);
    });
    expect(revSeq).not.toBeNull();
    expect(revSeq!).toBeGreaterThan(0);
    expect(second.seq).toBeGreaterThan(first.seq);
  });
});
