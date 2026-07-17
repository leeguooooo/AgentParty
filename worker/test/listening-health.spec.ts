import type { PresenceEntry } from "@agentparty/shared";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { WsClient, api, createChannel, seedToken, uniq } from "./helpers";

// 探活分级（issue #603）：live 只证明 TCP+握手活着。这里验证服务端从 directed delivery 租约
// 状态机派生的监听力判定——租约对活连接过期一次 = suspect，连续 ≥2 次 = deaf；目标任何一次
// 被接受的 delivery 更新即清零。判定只对「当前有活连接」的身份下发（离线是 offline，不是 deaf）。

async function fetchPresence(slug: string, token: string): Promise<PresenceEntry[]> {
  const res = await api(`/api/channels/${slug}/presence`, token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { presence: PresenceEntry[] }).presence;
}

async function sendMention(slug: string, token: string, target: string, body: string) {
  const response = await api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body: `@${target} ${body}`, mentions: [target], reply_to: null }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { seq: number };
}

// seedPresence 只在首次挂载用（与 CLI 挂上先报 status 的行为一致）。重连时绝不发：
// helpers 的 nextOfType 会丢弃不匹配帧，等 `sent` 会把重连即刻重派的 `delivery` 帧吞掉。
async function attachServe(slug: string, token: string, opts: { seedPresence?: boolean } = {}): Promise<WsClient> {
  const ws = await WsClient.open(slug, token);
  await ws.nextOfType("welcome");
  ws.send({ type: "hello", since: 0, directed_delivery: "v1" });
  ws.send({ type: "serve_lease", op: "claim" });
  expect(await ws.nextOfType("serve_lease")).toMatchObject({ held: true });
  if (opts.seedPresence === true) {
    ws.send({ type: "send", kind: "status", state: "waiting", note: "attached", mentions: [] });
    await ws.nextOfType("sent");
  }
  return ws;
}

/** 回拨该频道所有在租 delivery 的 lease_until 并触发 alarm——模拟「投喂了 90s 没人吃」。 */
async function expireLeases(slug: string) {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  await runInDurableObject(stub, async (instance: ChannelDO, state) => {
    state.storage.sql.exec(
      "UPDATE directed_deliveries SET lease_until = ? WHERE lease_until IS NOT NULL",
      Date.now() - 1,
    );
    await instance.onAlarm();
  });
}

describe("listening verdict from delivery-lease expiry (issue #603)", () => {
  it("suspect after one live-connection lease expiry, deaf after two, cleared by an accepted update", async () => {
    const owner = `${uniq("listen-owner")}@example.com`;
    const sender = await seedToken("human", uniq("sender"), { owner });
    const slug = await createChannel(sender.token);
    const target = await seedToken("agent", uniq("listen-target"), { owner, channelScope: slug });

    // 第一轮：领取后装死（不 ack），租约对活连接过期 → streak=1
    let serve = await attachServe(slug, target.token, { seedPresence: true });
    await sendMention(slug, sender.token, target.name, "are you listening");
    const first = (await serve.nextOfType("delivery")) as { delivery: { id: string; work_id?: string; continuation_ref?: string } };
    await expireLeases(slug);
    serve.close();

    // 重连（live 恢复）后判定可见：suspect
    serve = await attachServe(slug, target.token);
    let entry = (await fetchPresence(slug, target.token)).find((e) => e.name === target.name);
    expect(entry?.listening).toBe("suspect");

    // 第二轮：重派后继续装死 → streak=2 → deaf
    await serve.nextOfType("delivery");
    await expireLeases(slug);
    serve.close();
    serve = await attachServe(slug, target.token);
    entry = (await fetchPresence(slug, target.token)).find((e) => e.name === target.name);
    expect(entry?.listening).toBe("deaf");

    // 第三轮：终于消费（running ACK）→ 任何被接受的更新即清零
    const replayed = (await serve.nextOfType("delivery")) as { delivery: { id: string; work_id?: string; continuation_ref?: string } };
    expect(replayed.delivery.id).toBe(first.delivery.id);
    serve.send({
      type: "delivery_update",
      delivery_id: replayed.delivery.id,
      state: "running",
      work_id: replayed.delivery.work_id ?? undefined,
      continuation_ref: replayed.delivery.continuation_ref ?? undefined,
    });
    for (;;) {
      const state = await serve.nextOfType("delivery_state");
      if (
        (state as { delivery: { id: string; state: string } }).delivery.id === replayed.delivery.id &&
        (state as { delivery: { state: string } }).delivery.state === "running"
      ) break;
    }
    entry = (await fetchPresence(slug, target.token)).find((e) => e.name === target.name);
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("listening");
    serve.close();
  });

  it("does not emit a verdict for an identity with no live connection (offline is not deaf)", async () => {
    const owner = `${uniq("offline-owner")}@example.com`;
    const sender = await seedToken("human", uniq("sender"), { owner });
    const slug = await createChannel(sender.token);
    const target = await seedToken("agent", uniq("offline-target"), { owner, channelScope: slug });

    const serve = await attachServe(slug, target.token, { seedPresence: true });
    await sendMention(slug, sender.token, target.name, "going deaf then offline");
    await serve.nextOfType("delivery");
    await expireLeases(slug);
    serve.close();

    // 不重连：连接没了就是 offline/wakeable 语义，绝不给 deaf 判定
    const entry = (await fetchPresence(slug, sender.token)).find((e) => e.name === target.name);
    if (entry !== undefined) expect(entry).not.toHaveProperty("listening");
  });
});
