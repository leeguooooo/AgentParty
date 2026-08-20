// #875「已读不回」的真终态。今天唯一能结清一条 @ 的动作是 `send --reply-to N`，于是
// 「看到了、判断不需要回复」这种极常见情况只能挂到租约过期，被记成 failed/unknown_outcome——
// 把「已读不回」污染成「投递失败」。这里守四件事：
//   ① 显式 ack 写入 state=replied + terminal_reason=acknowledged_no_reply（不是 failed）；
//   ② 授权只放行**同 principal**——同名不同账号、别人、无归属历史行一律拒；
//   ③ 连接闸开口子是给「不在原 lease 连接上的显式 ack」的，不是放宽成任意调用方；
//   ④ 终态可审计（谁 ack、何时）且频道侧可见——ack 不能成为悄悄吞 @ 的手段。
import type { PublicDirectedDelivery } from "@agentparty/shared";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { WsClient, api, createChannel, seedToken, uniq } from "./helpers";

async function sendMention(slug: string, token: string, target: string) {
  const res = await api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body: `@${target} FYI`, mentions: [target], reply_to: null }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { seq: number };
}

async function deliveryRow(slug: string) {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_instance: ChannelDO, state) => {
    const row = state.storage.sql.exec("SELECT * FROM directed_deliveries LIMIT 1").toArray()[0];
    return row === undefined
      ? null
      : {
          id: String(row.id),
          state: String(row.state),
          terminal_reason: row.terminal_reason === null ? null : String(row.terminal_reason),
          reply_seq: row.reply_seq === null ? null : Number(row.reply_seq),
          last_error: row.last_error === null ? null : String(row.last_error),
          acknowledged_by: row.acknowledged_by === null ? null : String(row.acknowledged_by),
          acknowledged_at: row.acknowledged_at === null ? null : Number(row.acknowledged_at),
          target_owner: row.target_owner === null ? null : String(row.target_owner),
        };
  });
}

async function setup() {
  const owner = `${uniq("owner")}@example.com`;
  const sender = await seedToken("agent", uniq("sender"), { owner });
  const target = await seedToken("agent", uniq("target"), { owner });
  const slug = await createChannel(sender.token);
  const posted = await sendMention(slug, sender.token, target.name);
  const delivery = await deliveryRow(slug);
  expect(delivery?.state).toBe("queued");
  return { owner, sender, target, slug, posted, deliveryId: delivery!.id };
}

describe("#875 已读不回：acknowledged_no_reply 终态", () => {
  it("目标身份显式 ack 后落 replied + acknowledged_no_reply，而不是 failed/unknown_outcome", async () => {
    const { slug, target, deliveryId } = await setup();

    const res = await api(`/api/channels/${slug}/deliveries/${deliveryId}/ack`, target.token, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; delivery: PublicDirectedDelivery };
    expect(body.ok).toBe(true);
    expect(body.delivery.state).toBe("replied");
    expect(body.delivery.reply_seq).toBeNull();

    const row = await deliveryRow(slug);
    expect(row?.state).toBe("replied");
    expect(row?.terminal_reason).toBe("acknowledged_no_reply");
    // 「已读不回」不是失败：它绝不能带上 failed 那条路径的任何痕迹。
    expect(row?.last_error).toBeNull();
    expect(row?.reply_seq).toBeNull();
  });

  it("终态可审计：记下是谁 ack、什么时候，且频道侧（非 acker 的连接）也看得到", async () => {
    const { slug, sender, target, deliveryId } = await setup();
    const before = Date.now();

    const res = await api(`/api/channels/${slug}/deliveries/${deliveryId}/ack`, target.token, { method: "POST" });
    expect(res.status).toBe(200);

    const row = await deliveryRow(slug);
    expect(row?.acknowledged_by).toBe(target.name);
    expect(row?.acknowledged_at).toBeGreaterThanOrEqual(before);

    // 频道侧可见性：用**发送者**（不是 acker）的连接补拉 delivery_state，逐帧读，
    // 不用 nextOfType 当屏障——它会静默丢掉途中帧，从而掩盖「其实根本没下发」。
    const ws = await WsClient.open(slug, sender.token);
    await ws.next();
    ws.send({ type: "hello", since: 0, directed_delivery: "v1" });
    let seen: PublicDirectedDelivery | null = null;
    for (let i = 0; i < 40 && seen === null; i += 1) {
      const frame = await ws.next();
      if (frame.type === "delivery_state" && frame.delivery.id === deliveryId) seen = frame.delivery;
    }
    ws.close();
    expect(seen).not.toBeNull();
    expect(seen!.acknowledged_no_reply).toEqual({ by: target.name, at: row!.acknowledged_at! });
  });

  it("只放行同 principal：别人（含同 owner 的另一个身份）不能替目标 ack", async () => {
    const { slug, owner, sender, deliveryId } = await setup();
    const sibling = await seedToken("agent", uniq("sibling"), { owner });

    for (const token of [sender.token, sibling.token]) {
      const res = await api(`/api/channels/${slug}/deliveries/${deliveryId}/ack`, token, { method: "POST" });
      expect(res.status).toBe(403);
    }
    const row = await deliveryRow(slug);
    expect(row?.state).toBe("queued");
    expect(row?.terminal_reason).toBeNull();
  });

  // 名字全局唯一，「同名不同账号」只能在名字被回收/重注册后出现——那正是建单时快照的
  // target_owner 与当前持名者不一致的状态。直接把库里的 target_owner 改掉来复现它。
  it("同名不同 principal 不放行：建单时的 target_owner 才是权威，不按当前名字推断", async () => {
    const { slug, target, deliveryId } = await setup();
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      state.storage.sql.exec(
        "UPDATE directed_deliveries SET target_owner = ? WHERE id = ?",
        `${uniq("other")}@example.com`,
        deliveryId,
      );
    });

    const res = await api(`/api/channels/${slug}/deliveries/${deliveryId}/ack`, target.token, { method: "POST" });
    expect(res.status).toBe(403);
    expect((await deliveryRow(slug))?.state).toBe("queued");
  });

  it("无归属的历史行（target_owner 为空）一律拒：无法归属的 principal 不能结清别人的 @", async () => {
    const { slug, target, deliveryId } = await setup();
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      state.storage.sql.exec("UPDATE directed_deliveries SET target_owner = NULL WHERE id = ?", deliveryId);
    });

    const res = await api(`/api/channels/${slug}/deliveries/${deliveryId}/ack`, target.token, { method: "POST" });
    expect(res.status).toBe(403);
    expect((await deliveryRow(slug))?.state).toBe("queued");
  });

  // 上面几条走的是 REST 入口，那里另有一道 identityMatchesDeliveryTarget。但「为显式 ack 开的
  // 连接身份闸口子」本身也必须只放行同 principal——它是 transitionDirectedDeliveryTerminal 上
  // 的一道独立闸，将来任何调用方（webhook/alarm/别的内部路径）传 explicitAckPrincipal 都得被它挡住。
  // 所以这里直接打这道闸，不经过 REST 入口。
  it("闸本身只放行同 principal：principal 不符 / 为空时拒绝转终态", async () => {
    const { slug, deliveryId } = await setup();
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    const outcomes = await runInDurableObject(stub, async (instance: ChannelDO) => {
      const gate = (
        instance as unknown as {
          transitionDirectedDeliveryTerminal: (
            id: string,
            state: "replied" | "failed",
            now: number,
            opts: Record<string, unknown>,
          ) => Record<string, unknown> | undefined;
        }
      ).transitionDirectedDeliveryTerminal.bind(instance);
      const attempt = (principal: string) =>
        gate(deliveryId, "replied", Date.now(), {
          replySeq: null,
          terminalReason: "acknowledged_no_reply",
          expectedStates: ["queued"],
          explicitAckPrincipal: principal,
          acknowledgedBy: "whoever",
        });
      return {
        foreign: attempt("someone-else@example.com") === undefined,
        empty: attempt("") === undefined,
      };
    });
    expect(outcomes).toEqual({ foreign: true, empty: true });
    expect((await deliveryRow(slug))?.state).toBe("queued");
  });

  it("显式 ack 不被原 lease 连接卡死：换一个连接（乃至没有连接）也能结清", async () => {
    const { slug, target, deliveryId } = await setup();
    // 先让目标拿到 serve 租约（delivery 进 claimed/running 且 lease_connection_id 绑在这条 ws 上），
    // 再从**另一条**连接之外的纯 REST 调用 ack——这正是「会话换了、从别的终端补 ack」的场景。
    const ws = await WsClient.open(slug, target.token);
    await ws.next();
    ws.send({ type: "hello", since: 0, directed_delivery: "v1" });
    ws.send({ type: "serve_lease", op: "claim" });
    for (let i = 0; i < 40; i += 1) {
      const frame = await ws.next();
      if (frame.type === "delivery" && frame.delivery.id === deliveryId) break;
    }
    const leased = await deliveryRow(slug);
    expect(leased?.state === "claimed" || leased?.state === "running").toBe(true);

    const res = await api(`/api/channels/${slug}/deliveries/${deliveryId}/ack`, target.token, { method: "POST" });
    ws.close();
    expect(res.status).toBe(200);
    const row = await deliveryRow(slug);
    expect(row?.state).toBe("replied");
    expect(row?.terminal_reason).toBe("acknowledged_no_reply");
  });

  it("按 @ 消息的 seq 也能 ack（调用方手上通常只有 pending_mention_seqs）", async () => {
    const { slug, target, posted } = await setup();
    const res = await api(`/api/channels/${slug}/deliveries/${posted.seq}/ack`, target.token, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await deliveryRow(slug))?.terminal_reason).toBe("acknowledged_no_reply");
  });

  it("幂等：重复 ack 返回既有终态，不改写审计列", async () => {
    const { slug, target, deliveryId } = await setup();
    expect((await api(`/api/channels/${slug}/deliveries/${deliveryId}/ack`, target.token, { method: "POST" })).status)
      .toBe(200);
    const first = await deliveryRow(slug);

    const again = await api(`/api/channels/${slug}/deliveries/${deliveryId}/ack`, target.token, { method: "POST" });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { deduped?: boolean }).deduped).toBe(true);
    expect(await deliveryRow(slug)).toEqual(first);
  });

  it("已经真回复过的 @ 不能被 ack 覆盖成「已读不回」", async () => {
    const { slug, sender, target, posted, deliveryId } = await setup();
    const replied = await api(`/api/channels/${slug}/messages`, target.token, {
      method: "POST",
      body: JSON.stringify({ kind: "message", body: "on it", mentions: [sender.name], reply_to: posted.seq }),
    });
    expect(replied.status).toBe(200);

    const res = await api(`/api/channels/${slug}/deliveries/${deliveryId}/ack`, target.token, { method: "POST" });
    expect(res.status).toBe(409);
    const row = await deliveryRow(slug);
    expect(row?.state).toBe("replied");
    expect(row?.terminal_reason).toBeNull();
    expect(row?.reply_seq).not.toBeNull();
  });

  it("只读会话不得结清任何人的 @", async () => {
    const { slug, deliveryId } = await setup();
    const readonly = await seedToken("readonly", uniq("ro"));
    const res = await api(`/api/channels/${slug}/deliveries/${deliveryId}/ack`, readonly.token, { method: "POST" });
    expect(res.status).toBe(403);
    expect((await deliveryRow(slug))?.state).toBe("queued");
  });
});
