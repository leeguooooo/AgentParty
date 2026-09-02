// #1052 #5 notify_when_idle（wake protocol v2 §2）：一次性空闲订阅。
//
// 钉住的契约：
//   - 订阅 → 目标 busy 1→0 恰好投**一条** idle_notice 给订阅方（只给订阅方，不落 history），行即删；
//   - 目标再次翻转 ⇒ 什么都不发（一次性）；
//   - 订阅时目标已空闲 ⇒ 立即触发（outcome=fired）；目标离线 ⇒ exited 变体；
//   - 到期未触发 ⇒ expired 变体；
//   - 未知目标 404；同 (target, subscriber) 幂等；
//   - 订阅方触发时不在线 ⇒ 下次 hello 补投。
// 把「触发即删行」改成每次翻转都发，「恰好一条」用例必须红。
import { SELF, env, runInDurableObject } from "cloudflare:test";
import type { IdleNoticeFrame, PresenceEntry, ServerFrame } from "@agentparty/shared";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { ADMIN_HEADERS, WsClient, api, createChannel, seedToken, uniq } from "./helpers";

async function openHello(slug: string, token: string): Promise<WsClient> {
  const ws = await WsClient.open(slug, token);
  await ws.nextOfType("welcome");
  ws.send({ type: "hello", since: 0 });
  return ws;
}

async function sendStatus(ws: WsClient, frame: Record<string, unknown>): Promise<void> {
  ws.send({ type: "send", kind: "status", state: "working", note: "n", mentions: [], ...frame });
  await ws.nextOfType("sent");
}

function subscribe(slug: string, token: string, target: string): Promise<Response> {
  return api(`/api/channels/${slug}/presence/${encodeURIComponent(target)}/notify-when-idle`, token, {
    method: "POST",
    body: "{}",
  });
}

async function fetchPresence(slug: string, token: string): Promise<PresenceEntry[]> {
  const res = await api(`/api/channels/${slug}/presence`, token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { presence: PresenceEntry[] }).presence;
}

/** 在 ms 内收到的所有帧里，type=idle_notice 的那些。 */
async function idleNoticesWithin(ws: WsClient, ms: number): Promise<IdleNoticeFrame[]> {
  const out: IdleNoticeFrame[] = [];
  const deadline = Date.now() + ms;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return out;
    let frame: ServerFrame;
    try {
      frame = await ws.next(left);
    } catch {
      return out;
    }
    if (frame.type === "idle_notice") out.push(frame);
  }
}

async function fireAlarm(slug: string): Promise<void> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  await runInDurableObject(stub, async (instance: ChannelDO) => {
    await instance.onAlarm();
  });
}

async function backdateWatches(slug: string, expiresAt: number): Promise<void> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
    state.storage.sql.exec("UPDATE idle_watch SET expires_at = ?", expiresAt);
  });
}

async function historyBodies(slug: string, token: string): Promise<string[]> {
  const res = await api(`/api/channels/${slug}/messages?limit=100`, token);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { messages: { body: string; sender: { name: string } }[] };
  return body.messages.map((m) => `${m.sender.name}:${m.body}`);
}

describe("notify_when_idle（#1052）", () => {
  it("subscribe → target busy→idle fires exactly one idle notice to the subscriber, deletes the row; a second flip fires nothing", async () => {
    const target = await seedToken("agent");
    const subscriber = await seedToken("agent");
    const bystander = await seedToken("agent");
    const slug = await createChannel(target.token);
    const targetWs = await openHello(slug, target.token);
    const subWs = await openHello(slug, subscriber.token);
    const otherWs = await openHello(slug, bystander.token);
    await sendStatus(targetWs, { state: "working", busy: true });
    // presence 的 idle_watches 挂在订阅方自己的 presence 行上：先让它有一行。
    await sendStatus(subWs, { state: "waiting" });

    const res = await subscribe(slug, subscriber.token, target.name);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, target: target.name, subscriber: subscriber.name, outcome: "subscribed" });
    expect(typeof body.expires_at).toBe("number");

    // presence 暴露订阅方挂着的订阅（who / doctor 可见）。
    const mine = (await fetchPresence(slug, subscriber.token)).find((e) => e.name === subscriber.name);
    expect(mine?.idle_watches).toEqual([{ target: target.name, expires_at: body.expires_at }]);

    // 翻转：busy → idle。
    await sendStatus(targetWs, { state: "waiting", busy: false });
    const notices = await idleNoticesWithin(subWs, 800);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: "idle_notice", target: target.name, reason: "idle" });
    expect(notices[0]!.busy_ms).toBeGreaterThanOrEqual(0);
    // 只投订阅方：旁观者一条都收不到；频道 history 里没有多出任何消息。
    expect(await idleNoticesWithin(otherWs, 200)).toEqual([]);
    expect((await historyBodies(slug, subscriber.token)).some((line) => line.includes("idle"))).toBe(false);
    // 行已删：presence 不再列出。
    const after = (await fetchPresence(slug, subscriber.token)).find((e) => e.name === subscriber.name);
    expect(after).not.toHaveProperty("idle_watches");

    // 第二次翻转：一次性订阅已消费，什么都不发。
    await sendStatus(targetWs, { state: "working", busy: true });
    await sendStatus(targetWs, { state: "waiting", busy: false });
    expect(await idleNoticesWithin(subWs, 500)).toEqual([]);
    targetWs.close();
    subWs.close();
    otherWs.close();
  });

  it("target already idle at subscribe time → fires immediately (outcome=fired/idle)", async () => {
    const target = await seedToken("agent");
    const subscriber = await seedToken("agent");
    const slug = await createChannel(target.token);
    const targetWs = await openHello(slug, target.token);
    const subWs = await openHello(slug, subscriber.token);
    await sendStatus(targetWs, { state: "working" });

    const res = await subscribe(slug, subscriber.token, target.name);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, outcome: "fired", fired: "idle" });
    const notices = await idleNoticesWithin(subWs, 800);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ target: target.name, reason: "idle", busy_ms: 0 });
    targetWs.close();
    subWs.close();
  });

  it("target goes offline before idle → exited variant, once", async () => {
    const target = await seedToken("agent");
    const subscriber = await seedToken("agent");
    const slug = await createChannel(target.token);
    const targetWs = await openHello(slug, target.token);
    const subWs = await openHello(slug, subscriber.token);
    await sendStatus(targetWs, { state: "working", busy: true });
    expect((await subscribe(slug, subscriber.token, target.name)).status).toBe(200);

    targetWs.close();
    const notices = await idleNoticesWithin(subWs, 2000);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ target: target.name, reason: "exited" });
    expect(notices[0]).not.toHaveProperty("busy_ms");
    subWs.close();
  });

  it("target already offline at subscribe time → exited immediately", async () => {
    const target = await seedToken("agent");
    const subscriber = await seedToken("agent");
    const slug = await createChannel(target.token);
    const targetWs = await openHello(slug, target.token);
    await sendStatus(targetWs, { state: "working", busy: true });
    targetWs.close();
    await new Promise((r) => setTimeout(r, 200));
    const subWs = await openHello(slug, subscriber.token);

    const res = await subscribe(slug, subscriber.token, target.name);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "fired", fired: "exited" });
    const notices = await idleNoticesWithin(subWs, 800);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ target: target.name, reason: "exited" });
    subWs.close();
  });

  it("expiry alarm → expired variant, once; row gone", async () => {
    const target = await seedToken("agent");
    const subscriber = await seedToken("agent");
    const slug = await createChannel(target.token);
    const targetWs = await openHello(slug, target.token);
    const subWs = await openHello(slug, subscriber.token);
    await sendStatus(targetWs, { state: "working", busy: true });
    expect((await subscribe(slug, subscriber.token, target.name)).status).toBe(200);

    // alarm 到点但未过期 ⇒ 不发。
    await fireAlarm(slug);
    expect(await idleNoticesWithin(subWs, 300)).toEqual([]);
    // 把到期时刻拨到过去，再跑 alarm ⇒ expired。
    await backdateWatches(slug, Date.now() - 1);
    await fireAlarm(slug);
    const notices = await idleNoticesWithin(subWs, 800);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ target: target.name, reason: "expired" });
    // 再跑一次 alarm 不重复。
    await fireAlarm(slug);
    expect(await idleNoticesWithin(subWs, 300)).toEqual([]);
    // 之后目标空闲也不再通知（订阅已过期）。
    await sendStatus(targetWs, { state: "waiting", busy: false });
    expect(await idleNoticesWithin(subWs, 300)).toEqual([]);
    targetWs.close();
    subWs.close();
  });

  it("unknown target → 404; self → 400; readonly → 403", async () => {
    const target = await seedToken("agent");
    const subscriber = await seedToken("agent");
    const readonly = await seedToken("readonly");
    const slug = await createChannel(target.token);
    const targetWs = await openHello(slug, target.token);
    await sendStatus(targetWs, { state: "working", busy: true });

    const unknown = await subscribe(slug, subscriber.token, "nobody-here");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: "not_found" } });
    expect((await subscribe(slug, subscriber.token, subscriber.name)).status).toBe(400);
    expect((await subscribe(slug, readonly.token, target.name)).status).toBe(403);
    expect((await subscribe("no-such-channel", subscriber.token, target.name)).status).toBe(404);
    targetWs.close();
  });

  it("idempotent per (target, subscriber): second subscribe returns the existing watch and still fires once", async () => {
    const target = await seedToken("agent");
    const subscriber = await seedToken("agent");
    const slug = await createChannel(target.token);
    const targetWs = await openHello(slug, target.token);
    const subWs = await openHello(slug, subscriber.token);
    await sendStatus(targetWs, { state: "working", busy: true });
    await sendStatus(subWs, { state: "waiting" });

    const first = (await (await subscribe(slug, subscriber.token, target.name)).json()) as Record<string, unknown>;
    const second = (await (await subscribe(slug, subscriber.token, target.name)).json()) as Record<string, unknown>;
    expect(first.outcome).toBe("subscribed");
    expect(second).toMatchObject({ outcome: "existing", expires_at: first.expires_at });
    const mine = (await fetchPresence(slug, subscriber.token)).find((e) => e.name === subscriber.name);
    expect(mine?.idle_watches).toHaveLength(1);

    await sendStatus(targetWs, { state: "waiting", busy: false });
    expect(await idleNoticesWithin(subWs, 800)).toHaveLength(1);
    targetWs.close();
    subWs.close();
  });

  it("subscriber offline when it fires → the notice is delivered on its next hello, once", async () => {
    const target = await seedToken("agent");
    const subscriber = await seedToken("agent");
    const slug = await createChannel(target.token);
    const targetWs = await openHello(slug, target.token);
    await sendStatus(targetWs, { state: "working", busy: true });
    // 订阅方只走 REST（没有活连接）。
    expect((await subscribe(slug, subscriber.token, target.name)).status).toBe(200);

    await sendStatus(targetWs, { state: "waiting", busy: false });
    await new Promise((r) => setTimeout(r, 100));
    const subWs = await openHello(slug, subscriber.token);
    const notices = await idleNoticesWithin(subWs, 1500);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ target: target.name, reason: "idle" });
    // 补投过就删：重连不再重复。
    subWs.close();
    const again = await openHello(slug, subscriber.token);
    expect(await idleNoticesWithin(again, 500)).toEqual([]);
    again.close();
    targetWs.close();
  });
});

// 私有频道的访问闸（pr_agent review）：非成员连「某人忙闲翻转」都不该订阅得到——与读历史同一道闸。
// 把 canAccessLoadedChannel 那几行删掉，这条必须红。
describe("notify_when_idle · 私有频道访问控制", () => {
  async function humanSession(owner: string): Promise<string> {
    const res = await SELF.fetch("http://ap.test/api/tokens", {
      method: "POST",
      headers: { ...ADMIN_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ name: uniq("human"), role: "human", owner }),
    });
    if (res.status !== 201) throw new Error(`human session mint failed: ${res.status}`);
    return ((await res.json()) as { token: string }).token;
  }

  it("非成员对私有频道里的人订阅 ⇒ 403，成员 ⇒ 放行", async () => {
    const owner = await humanSession("owner@leeguoo.com");
    const outsider = await humanSession("outsider@leeguoo.com");
    const slug = uniq("priv");
    const created = await api("/api/channels", owner, {
      method: "POST",
      body: JSON.stringify({ slug, kind: "standing", visibility: "private" }),
    });
    expect(created.status).toBe(201);
    const target = await seedToken("agent", uniq("target"), { owner: "owner@leeguoo.com" });
    const targetWs = await openHello(slug, target.token);
    try {
      await sendStatus(targetWs, {}); // 等 presence 行真落下，订阅才有目标可找
      const denied = await subscribe(slug, outsider, target.name);
      expect(denied.status).toBe(403);
      expect(((await denied.json()) as { error: { message: string } }).error.message).toBe("not allowed in this channel");
      const allowed = await subscribe(slug, owner, target.name);
      expect([200, 201]).toContain(allowed.status);
    } finally {
      targetWs.close();
    }
  });
});
