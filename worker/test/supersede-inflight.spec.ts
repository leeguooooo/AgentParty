// #930 的服务端前提：打标记的那一刻，这条 @ **一定**还在 runner 手里（或在队列里等着交出去）。
//
// `markSupersededByReplyCorrection` 的谓词要求目标的 directed delivery 处于
// `queued/claimed/running/waiting_owner`——也就是「还没结清」。于是「最需要别按旧前提行动」的那一刻，
// 恰恰就是标记产生的那一刻。客户端那半（serve 交接点重写 + in-flight 通告）在
// cli/test/serve-supersede-inflight.test.ts；这里钉住服务端这半：
//   1. 改口发生时，前一条的 delivery 确实仍是 claimed（不是「已结清所以不标」）；
//   2. 那条 `message_update("supersede")` 确实**实时**推给了正握着这条 delivery 的那个连接。
//
// 这两点成立，客户端才可能在缓冲区里找到标记。缺任何一条，#930 的修法就是空中楼阁。
//
// 逐帧消费（`next()`），不用「读到某类帧就停」的辅助——那会静默丢帧，把顺序问题掩盖成绿。
import type { ServerFrame } from "@agentparty/shared";
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

async function deliveryStates(slug: string): Promise<Array<{ message_seq: number; state: string }>> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_instance: ChannelDO, state) =>
    state.storage.sql
      .exec("SELECT message_seq, state FROM directed_deliveries ORDER BY message_seq")
      .toArray()
      .map((row) => ({ message_seq: Number(row.message_seq), state: String(row.state) })),
  );
}

/** 逐帧收，直到拿到想要的那一帧；把沿途每一帧都留作证据，绝不静默跳过。 */
async function collectUntil(
  ws: WsClient,
  predicate: (frame: ServerFrame) => boolean,
  max = 20,
): Promise<{ hit: ServerFrame | null; seen: ServerFrame[] }> {
  const seen: ServerFrame[] = [];
  for (let i = 0; i < max; i++) {
    let frame: ServerFrame;
    try {
      frame = await ws.next(3000);
    } catch {
      return { hit: null, seen };
    }
    seen.push(frame);
    if (predicate(frame)) return { hit: frame, seen };
  }
  return { hit: null, seen };
}

describe("#930 服务端：标记产生的那一刻，这条 @ 仍在投递中", () => {
  it("delivery 还是 claimed 时改口 → supersede 实时推给正握着它的那个连接", async () => {
    const owner = `${uniq("owner")}@example.com`;
    const sender = await seedToken("agent", uniq("sender"), { owner });
    const target = await seedToken("agent", uniq("target"), { owner });
    const slug = await createChannel(sender.token);

    const ws = await WsClient.open(slug, target.token);
    ws.send({ type: "hello", since: 0, directed_delivery: "v1" });
    ws.send({ type: "serve_lease", op: "claim" });

    const first = await send(slug, sender.token, `@${target.name} 部署到 prod`, [target.name]);

    // 先确认这条 @ 真的被交出去了（delivery 帧 = 服务端把活交给了本连接）。
    const dispatched = await collectUntil(
      ws,
      (f) => f.type === "delivery" && f.message.seq === first.seq,
    );
    expect(dispatched.hit, `没等到 delivery 帧，沿途收到: ${dispatched.seen.map((f) => f.type).join(",")}`)
      .not.toBeNull();

    // 交出去了但还没回执 → 这正是 issue 说的「在 runner 手里」。
    const beforeCorrection = await deliveryStates(slug);
    expect(beforeCorrection).toEqual([{ message_seq: first.seq, state: "claimed" }]);

    // 发送方两条消息之后改口：--reply-to 回到那条、并再次 @ 同一个目标。
    const second = await send(
      slug,
      sender.token,
      `@${target.name} 改口：先别部署`,
      [target.name],
      first.seq,
    );

    const update = await collectUntil(
      ws,
      (f) => f.type === "message_update" && f.action === "supersede" && f.target_seq === first.seq,
    );
    expect(update.hit, `没等到 supersede 广播，沿途收到: ${update.seen.map((f) => f.type).join(",")}`)
      .not.toBeNull();
    const hit = update.hit as Extract<ServerFrame, { type: "message_update" }>;
    // 语义是「已被 seq N 取代」，不是「这条不存在」：正文还在，只是多了一个降级标记。
    expect(hit.message.seq).toBe(first.seq);
    expect(hit.message.body).toBe(`@${target.name} 部署到 prod`);
    expect(hit.message.superseded).toEqual({ by_seq: second.seq, reason: "reply_correction" });
    // 定序依据只有 seq。
    expect(hit.message.superseded!.by_seq).toBeGreaterThan(first.seq);

    // 标记不改投递状态：那条 @ 照常留在 runner 手里，由它自己收尾（路线 A 不打断）。
    const afterCorrection = await deliveryStates(slug);
    expect(afterCorrection.find((row) => row.message_seq === first.seq)?.state).toBe("claimed");

    ws.close();
  });

  it("反向：改口回复的不是那条 @（普通后续消息）→ 不广播 supersede，投递照常", async () => {
    const owner = `${uniq("owner")}@example.com`;
    const sender = await seedToken("agent", uniq("sender"), { owner });
    const target = await seedToken("agent", uniq("target"), { owner });
    const slug = await createChannel(sender.token);

    const ws = await WsClient.open(slug, target.token);
    ws.send({ type: "hello", since: 0, directed_delivery: "v1" });
    ws.send({ type: "serve_lease", op: "claim" });

    const first = await send(slug, sender.token, `@${target.name} 部署到 prod`, [target.name]);
    const dispatched = await collectUntil(
      ws,
      (f) => f.type === "delivery" && f.message.seq === first.seq,
    );
    expect(dispatched.hit).not.toBeNull();

    // 「做 X」「再做 Y」是两条独立的 @：没有 --reply-to 就不构成取代关系。
    const second = await send(slug, sender.token, `@${target.name} 顺手再看看日志`, [target.name]);
    const update = await collectUntil(
      ws,
      (f) => f.type === "message_update" && f.action === "supersede",
      8,
    );
    expect(update.hit).toBeNull();
    expect(update.seen.some((f) => f.type === "msg" && f.seq === second.seq)).toBe(true);

    ws.close();
  });
});
