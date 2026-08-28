// #963：发信人 @ 自己的身份不是召唤。事故第二、三轮：seq 42 的会话在回帖里写了「@leo-server」
// （指代那个身份，不是想召唤谁），服务端如实解析成 mentions=['leo-server']，同身份全部 runtime 又被叫醒。
// 服务端不为自 @ 生成任何唤醒语义：不建 directed delivery、不落 serve/watch broadcast ledger、
// 不投 mentions 过滤的 webhook。mentions 数组本身原样落库/广播（正文高亮、历史不受影响）。
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { fetchMock } from "./fetch-mock";
import { WsClient, api, completeCapabilityHello, createChannel, seedToken, uniq } from "./helpers";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

function send(slug: string, token: string, body: string, mentions: string[], replyTo: number | null = null) {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body, mentions, reply_to: replyTo }),
  });
}

async function deliveryTargets(slug: string): Promise<Array<{ seq: number; target: string }>> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_instance: ChannelDO, state) =>
    state.storage.sql
      .exec("SELECT message_seq, target_name FROM directed_deliveries ORDER BY message_seq, target_name")
      .toArray()
      .map((row) => ({ seq: Number(row.message_seq), target: String(row.target_name) })),
  );
}

async function ledgerRows(slug: string): Promise<Array<{ seq: number; target: string; kind: string; result: string }>> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_instance: ChannelDO, state) =>
    state.storage.sql
      .exec("SELECT mention_seq, target_name, adapter_kind, result FROM wake_delivery_ledger ORDER BY id")
      .toArray()
      .map((row) => ({
        seq: Number(row.mention_seq),
        target: String(row.target_name),
        kind: String(row.adapter_kind),
        result: String(row.result),
      })),
  );
}

async function storedMentions(slug: string, seq: number): Promise<string[]> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_instance: ChannelDO, state) => {
    const row = state.storage.sql.exec("SELECT mentions_json FROM messages WHERE seq = ?", seq).toArray()[0];
    return JSON.parse(String(row?.mentions_json ?? "[]")) as string[];
  });
}

/** 路由时算出的 delivery 目标快照（编辑/撤回/undeliverable 回执都读它）——自 @ 不该出现在这里。 */
async function storedDeliveryTargets(slug: string, seq: number): Promise<string[]> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_instance: ChannelDO, state) => {
    const row = state.storage.sql.exec("SELECT delivery_targets_json FROM messages WHERE seq = ?", seq).toArray()[0];
    return JSON.parse(String(row?.delivery_targets_json ?? "[]")) as string[];
  });
}

async function webhookQueue(slug: string): Promise<string[]> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_instance: ChannelDO, state) =>
    state.storage.sql.exec("SELECT webhook_name FROM webhook_queue ORDER BY id").toArray().map((row) => String(row.webhook_name)),
  );
}

// 用真实 WS status 帧把 agent 登记成 serve（服务端据此盖 presence.wake_kind）。
async function registerServe(slug: string, token: string): Promise<WsClient> {
  const ws = await WsClient.open(slug, token);
  await completeCapabilityHello(ws);
  ws.send({ type: "send", kind: "status", state: "waiting", note: "standby", mentions: [], residency: "supervised", wake: { kind: "serve" } });
  await ws.nextOfType("sent");
  return ws;
}

describe("自 @ 不生成唤醒语义（issue #963）", () => {
  it("sender === mention 且带 reply_to：不建 directed delivery、不落 broadcast ledger，但 mentions 原样落库", async () => {
    const owner = `${uniq("owner")}@example.com`;
    const self = await seedToken("agent", uniq("leo-server"), { owner });
    const peer = await seedToken("agent", uniq("peer"), { owner });
    const slug = await createChannel(self.token);
    const ws = await registerServe(slug, self.token);

    // 对照：别人 @ 它 ⇒ 正常召唤（delivery + ledger 都有）。这一行保证下面的「没有」不是因为路径本来就不通。
    const ping = await send(slug, peer.token, `@${self.name} ping`, [self.name]);
    expect(ping.status).toBe(200);
    const pingSeq = ((await ping.json()) as { seq: number }).seq;
    expect(await deliveryTargets(slug)).toEqual([{ seq: pingSeq, target: self.name }]);
    expect(await ledgerRows(slug)).toEqual([{ seq: pingSeq, target: self.name, kind: "serve", result: "broadcast" }]);

    // 事故帧：leo-server 回帖里提到自己（reply_to 指向被 @ 的那条）。
    const reply = await send(slug, self.token, `收到 ping，但接住它的是 @${self.name} 的 QA 会话`, [self.name], pingSeq);
    expect(reply.status).toBe(200);
    const replySeq = ((await reply.json()) as { seq: number }).seq;
    expect(replySeq).toBeGreaterThan(pingSeq);
    // 正文/历史不受影响：mentions 仍含 self，前端照常高亮；#544 的「回复 agent 自动 @ 原作者」照旧补上 peer。
    expect(await storedMentions(slug, replySeq)).toEqual([self.name, peer.name]);
    expect(await storedDeliveryTargets(slug, replySeq)).toEqual([peer.name]);
    // 但 self 那份没有任何唤醒语义：delivery 只给被回复的 peer 建，ledger 没有新行
    // （原来那行由 #191 的 @→resume 观测升级成 consumed——那是「ping 的唤醒被这条回复闭环了」，正确）。
    expect(await deliveryTargets(slug)).toEqual([
      { seq: pingSeq, target: self.name },
      { seq: replySeq, target: peer.name },
    ]);
    expect(await ledgerRows(slug)).toEqual([{ seq: pingSeq, target: self.name, kind: "serve", result: "consumed" }]);

    // 不带 reply_to 的自 @ 同样不是召唤。
    const plain = await send(slug, self.token, `@${self.name} 这次醒了`, [self.name]);
    expect(plain.status).toBe(200);
    expect(await deliveryTargets(slug)).toEqual([
      { seq: pingSeq, target: self.name },
      { seq: replySeq, target: peer.name },
    ]);
    expect(await ledgerRows(slug)).toEqual([{ seq: pingSeq, target: self.name, kind: "serve", result: "consumed" }]);
    ws.close();
  });

  it("自 @ 与他人 @ 同在一条消息里：只给他人建 delivery，自己那份不建", async () => {
    const owner = `${uniq("owner")}@example.com`;
    const self = await seedToken("agent", uniq("leo-server"), { owner });
    const peer = await seedToken("agent", uniq("peer"), { owner });
    const slug = await createChannel(self.token);
    const res = await send(slug, self.token, `@${peer.name} 看看 @${self.name} 这条线`, [peer.name, self.name]);
    expect(res.status).toBe(200);
    const seq = ((await res.json()) as { seq: number }).seq;
    expect(await storedMentions(slug, seq)).toEqual([peer.name, self.name]);
    expect(await storedDeliveryTargets(slug, seq)).toEqual([peer.name]);
    expect(await deliveryTargets(slug)).toEqual([{ seq, target: peer.name }]);
  });

  it("mentions 过滤的 webhook：自 @ 不投，他人 @ 照投", async () => {
    const owner = `${uniq("owner")}@example.com`;
    const self = await seedToken("agent", uniq("leo-server"), { owner });
    const peer = await seedToken("agent", uniq("peer"), { owner });
    const slug = await createChannel(self.token);
    // webhook 以 self 的名字注册、只订阅 mentions。
    const hook = await api(`/api/channels/${slug}/webhooks`, self.token, {
      method: "POST",
      body: JSON.stringify({ name: self.name, url: "https://wake.test/hook", secret: "s", filter: "mentions" }),
    });
    expect(hook.status).toBe(201);

    // 自 @：没有 interceptor（disableNetConnect）——若服务端真去投递，首投会失败入 webhook_queue 并落
    // 一行 result=failed 的 webhook ledger。两处都必须是空的。
    const selfMsg = await send(slug, self.token, `@${self.name} 这次醒了`, [self.name]);
    expect(selfMsg.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await webhookQueue(slug)).toEqual([]);
    expect(await ledgerRows(slug)).toEqual([]);

    // 对照：别人 @ 它 ⇒ 投递（interceptor 被消费，afterEach 的 assertNoPendingInterceptors 兜底）。
    fetchMock.get("https://wake.test").intercept({ path: "/hook", method: "POST" }).reply(200, "ok");
    const ping = await send(slug, peer.token, `@${self.name} ping`, [self.name]);
    expect(ping.status).toBe(200);
    const pingSeq = ((await ping.json()) as { seq: number }).seq;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await webhookQueue(slug)).toEqual([]);
    expect(await ledgerRows(slug)).toEqual([{ seq: pingSeq, target: self.name, kind: "webhook", result: "ok" }]);
  });
});
