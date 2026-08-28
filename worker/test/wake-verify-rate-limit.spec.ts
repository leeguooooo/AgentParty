// #997：验证帧加固。
//
// #990 的验证帧（`[wake-verify]` + mentions 只含自己）绕过自 @ 过滤、又不计 loop guard，等于一条不受熔断
// 约束的写入通道。这里钉住它唯一的闸：
//   • 同一 (channel, sender) 在 WAKE_VERIFY_MIN_INTERVAL_MS 内最多放行一条，超出 429 wake_verify_rate_limited，
//     错误体带 retry_after_ms / retry_at；窗口过了放行；限频独立于 loop guard，熔断中照拒。
//   • 「验证帧」只对已登记的 agent 身份成立：非 agent 发的同形状帧、mentions 绑定到的登记身份不是发送者本人，
//     都按普通自 @ 处理（不建 delivery、不落 ledger、不免 guard、不限频）。
import { env, runInDurableObject } from "cloudflare:test";
import { LOOP_GUARD_AGENT_N, LOOP_GUARD_N, WAKE_VERIFY_MIN_INTERVAL_MS, WAKE_VERIFY_PREFIX } from "@agentparty/shared";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { fetchMock } from "./fetch-mock";
import { WsClient, api, completeCapabilityHello, createChannel, postMessage, seedToken, uniq } from "./helpers";

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

function send(slug: string, token: string, body: string, mentions: string[], extra: Record<string, unknown> = {}) {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body, mentions, reply_to: null, ...extra }),
  });
}

function verify(slug: string, token: string, name: string, tag = "") {
  return send(slug, token, `${WAKE_VERIFY_PREFIX} @${name} ping${tag}`, [name]);
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

async function ledgerRows(slug: string): Promise<Array<{ seq: number; target: string }>> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_instance: ChannelDO, state) =>
    state.storage.sql
      .exec("SELECT mention_seq, target_name FROM wake_delivery_ledger ORDER BY id")
      .toArray()
      .map((row) => ({ seq: Number(row.mention_seq), target: String(row.target_name) })),
  );
}

async function readMeta(slug: string, key: string): Promise<string | null> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_instance: ChannelDO, state) => {
    const row = state.storage.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row === undefined ? null : String(row.value);
  });
}

async function writeMeta(slug: string, key: string, value: string): Promise<void> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
    state.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  });
}

/** 把「上一条被接受的验证帧」的时间戳往前拨 ms 毫秒——模拟时间流逝，不碰 Date.now。 */
async function ageVerifyWindow(slug: string, name: string, ms: number): Promise<void> {
  const raw = await readMeta(slug, `wake_verify_at:${name}`);
  expect(raw).not.toBeNull();
  await writeMeta(slug, `wake_verify_at:${name}`, String(Number(raw) - ms));
}

async function guardCounters(slug: string, agentName: string): Promise<{ streak: number; count: number }> {
  return {
    streak: Number((await readMeta(slug, "agent_streak")) ?? "0"),
    count: Number((await readMeta(slug, `agent_count:${agentName}`)) ?? "0"),
  };
}

async function enableLoopGuard(slug: string, token: string, limit: number): Promise<void> {
  const res = await api(`/api/channels/${slug}/loop-guard`, token, {
    method: "PUT",
    body: JSON.stringify({ enabled: true, limit }),
  });
  expect(res.status).toBe(200);
}

async function tripLoopGuard(slug: string, agentName: string): Promise<void> {
  await writeMeta(slug, `agent_count:${agentName}`, String(LOOP_GUARD_AGENT_N));
  await writeMeta(slug, "agent_streak", String(LOOP_GUARD_AGENT_N));
}

// 用真实 WS status 帧把 agent 登记成 serve（服务端据此盖 presence.wake_kind）。
async function registerServe(slug: string, token: string): Promise<WsClient> {
  const ws = await WsClient.open(slug, token);
  await completeCapabilityHello(ws);
  ws.send({ type: "send", kind: "status", state: "waiting", note: "standby", mentions: [], residency: "supervised", wake: { kind: "serve" } });
  await ws.nextOfType("sent");
  return ws;
}

describe("验证帧按 (channel, sender) 限频（issue #997）", () => {
  it("连续两条：第二条 429 wake_verify_rate_limited，错误体带 retry_after_ms / retry_at 与人话的下次可发时间", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const before = Date.now();
    const first = await verify(slug, agent.token, agent.name, " 1");
    expect(first.status).toBe(200);
    const firstSeq = ((await first.json()) as { seq: number }).seq;

    const second = await verify(slug, agent.token, agent.name, " 2");
    expect(second.status).toBe(429);
    const body = (await second.json()) as {
      error: { code: string; message: string; retry_after_ms: number; retry_at: number };
    };
    expect(body.error.code).toBe("wake_verify_rate_limited");
    expect(body.error.retry_after_ms).toBeGreaterThan(0);
    expect(body.error.retry_after_ms).toBeLessThanOrEqual(WAKE_VERIFY_MIN_INTERVAL_MS);
    expect(body.error.retry_at).toBeGreaterThanOrEqual(before + WAKE_VERIFY_MIN_INTERVAL_MS);
    expect(body.error.retry_at - Date.now()).toBeLessThanOrEqual(WAKE_VERIFY_MIN_INTERVAL_MS);
    expect(body.error.message).toContain("wake-verify");
    expect(body.error.message).toContain(`1 per ${WAKE_VERIFY_MIN_INTERVAL_MS / 1000}s`);
    expect(body.error.message).toContain(new Date(body.error.retry_at).toISOString());
    // 被拒的那条没有落库、没有建任何唤醒副作用。
    expect(await deliveryTargets(slug)).toEqual([{ seq: firstSeq, target: agent.name }]);
    const history = await api(`/api/channels/${slug}/messages?after=0&limit=50`, agent.token);
    const messages = ((await history.json()) as { messages: Array<{ seq: number }> }).messages;
    expect(messages.map((m) => m.seq)).toEqual([firstSeq]);
  });

  it("WS 发送同样限频：error 帧带 wake_verify_rate_limited 与 retry_after_ms", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await completeCapabilityHello(ws);
    const frame = { type: "send", kind: "message", body: `${WAKE_VERIFY_PREFIX} @${agent.name} ping`, mentions: [agent.name], reply_to: null };
    ws.send(frame);
    await ws.nextOfType("sent");
    ws.send(frame);
    const err = (await ws.nextOfType("error")) as { code: string; retry_after_ms?: number; retry_at?: number };
    expect(err.code).toBe("wake_verify_rate_limited");
    expect(err.retry_after_ms).toBeGreaterThan(0);
    expect(typeof err.retry_at).toBe("number");
    ws.close();
  });

  it("窗口过了放行；再发又进下一个窗口", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    expect((await verify(slug, agent.token, agent.name, " 1")).status).toBe(200);
    expect((await verify(slug, agent.token, agent.name, " 2")).status).toBe(429);
    // 差 1s 到窗口：仍拒。
    await ageVerifyWindow(slug, agent.name, WAKE_VERIFY_MIN_INTERVAL_MS - 1_000);
    const early = await verify(slug, agent.token, agent.name, " 3");
    expect(early.status).toBe(429);
    const earlyBody = (await early.json()) as { error: { retry_after_ms: number } };
    expect(earlyBody.error.retry_after_ms).toBeLessThanOrEqual(1_000);
    // 补足窗口：放行。
    await ageVerifyWindow(slug, agent.name, 1_000);
    expect((await verify(slug, agent.token, agent.name, " 4")).status).toBe(200);
    // 放行那条重新起算窗口。
    expect((await verify(slug, agent.token, agent.name, " 5")).status).toBe(429);
  });

  it("限频按发送者分片：另一个 agent 在同频道不受影响；同一 agent 在另一个频道也不受影响", async () => {
    const owner = `${uniq("owner")}@example.com`;
    const a = await seedToken("agent", uniq("a"), { owner });
    const b = await seedToken("agent", uniq("b"), { owner });
    const slug = await createChannel(a.token);
    const other = await createChannel(a.token);
    expect((await verify(slug, a.token, a.name)).status).toBe(200);
    expect((await verify(slug, a.token, a.name)).status).toBe(429);
    expect((await verify(slug, b.token, b.name)).status).toBe(200);
    expect((await verify(other, a.token, a.name)).status).toBe(200);
  });

  it("独立于 loop guard：熔断中照拒（先撞限频），窗口过了再撞熔断本身；人类发言清熔断也不清限频", async () => {
    const agent = await seedToken("agent");
    const human = await seedToken("human", uniq("leo"));
    const slug = await createChannel(agent.token);
    await enableLoopGuard(slug, agent.token, LOOP_GUARD_N);
    expect((await verify(slug, agent.token, agent.name, " 1")).status).toBe(200);
    await tripLoopGuard(slug, agent.name);
    // 熔断中：普通消息 409；验证帧在限频窗口内 429（限频先于 guard 判定）。
    expect((await postMessage(slug, agent.token, "still talking")).status).toBe(409);
    const limited = await verify(slug, agent.token, agent.name, " 2");
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({ error: { code: "wake_verify_rate_limited" } });
    // 窗口过了、仍在熔断：照拒，这回是 guard 的真话。
    await ageVerifyWindow(slug, agent.name, WAKE_VERIFY_MIN_INTERVAL_MS);
    const tripped = await verify(slug, agent.token, agent.name, " 3");
    expect(tripped.status).toBe(409);
    await expect(tripped.json()).resolves.toMatchObject({ error: { code: "loop_guard" } });
    // 被拒的验证帧不占窗口：guard 解除后立刻重跑验证不必再等。
    expect((await postMessage(slug, human.token, "human here, guard cleared")).status).toBe(200);
    expect((await verify(slug, agent.token, agent.name, " 4")).status).toBe(200);
    // 人类发言清了 streak / fair-share，但限频窗口是独立状态：紧接着的第二条仍拒。
    expect((await postMessage(slug, human.token, "again")).status).toBe(200);
    expect((await verify(slug, agent.token, agent.name, " 5")).status).toBe(429);
    expect(await guardCounters(slug, agent.name)).toEqual({ streak: 0, count: 0 });
  });

  it("幂等重试不算第二条：同 idempotency_key 命中去重回原 seq，不被限频", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const key = uniq("idem");
    const first = await send(slug, agent.token, `${WAKE_VERIFY_PREFIX} @${agent.name} ping`, [agent.name], { idempotency_key: key });
    expect(first.status).toBe(200);
    const seq = ((await first.json()) as { seq: number }).seq;
    const retry = await send(slug, agent.token, `${WAKE_VERIFY_PREFIX} @${agent.name} ping`, [agent.name], { idempotency_key: key });
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { seq: number }).seq).toBe(seq);
  });
});

describe("验证帧只对已登记的 agent 身份成立（issue #997）", () => {
  it("非 agent 发的同形状帧：按普通自 @ 处理——不建 delivery、不落 ledger、也不限频", async () => {
    const human = await seedToken("human", uniq("leo"));
    const slug = await createChannel(human.token);
    for (let i = 0; i < 3; i += 1) {
      const res = await verify(slug, human.token, human.name, ` ${i}`);
      expect(res.status).toBe(200);
    }
    expect(await deliveryTargets(slug)).toEqual([]);
    expect(await ledgerRows(slug)).toEqual([]);
    expect(await readMeta(slug, `wake_verify_at:${human.name}`)).toBeNull();
  });

  it("mentions 绑定到的登记身份不是发送者本人（principal 劈叉）：不是验证帧——不建 delivery、计 loop guard、不限频", async () => {
    // tokens.name 全局唯一、REST 每次从同一行读身份、WS 的陈旧 principal 又会被 reconcileRemovedConnections
    // 关掉——入口层已经让「同名不同 principal」进不来。这道闸是 routeMentionsForDelivery 自己的独立判定
    // （将来任何内部调用方都得被它挡住），所以像 delivery-ack-no-reply.spec 一样直接打 handleSend。
    const owner = `${uniq("owner")}@example.com`;
    const agent = await seedToken("agent", uniq("moved"), { owner });
    const slug = await createChannel(agent.token);
    await enableLoopGuard(slug, agent.token, LOOP_GUARD_N);
    const tokenHash = await sha256Hex(agent.token);
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    const sendAs = (identityOwner: string) =>
      runInDurableObject(stub, async (instance: ChannelDO) => {
        const handleSend = (
          instance as unknown as {
            handleSend: (
              identity: { name: string; kind: "agent"; role: "agent"; owner: string; tokenHash: string },
              frame: Record<string, unknown>,
            ) => Promise<{ ok: boolean; code?: string; deliveryTargets?: string[] }>;
          }
        ).handleSend.bind(instance);
        return handleSend(
          { name: agent.name, kind: "agent", role: "agent", owner: identityOwner, tokenHash },
          { type: "send", kind: "message", body: `${WAKE_VERIFY_PREFIX} @${agent.name} ping`, mentions: [agent.name], reply_to: null },
        );
      });

    // 目录登记的 principal 是 owner，发送身份自称别的账号：同形状帧退化为普通自 @。
    const foreign = await sendAs(`${uniq("stranger")}@example.com`);
    expect(foreign.ok).toBe(true);
    expect(foreign.deliveryTargets).toEqual([]);
    expect(await deliveryTargets(slug)).toEqual([]);
    expect(await guardCounters(slug, agent.name)).toEqual({ streak: 1, count: 1 });
    expect(await readMeta(slug, `wake_verify_at:${agent.name}`)).toBeNull();

    // 对照：同一帧、principal 对上 ⇒ 验证帧成立（自己进 deliveryTargets、开限频窗口、不计 guard）。
    const genuine = await sendAs(owner);
    expect(genuine.ok).toBe(true);
    expect(genuine.deliveryTargets).toEqual([agent.name]);
    expect(await guardCounters(slug, agent.name)).toEqual({ streak: 1, count: 1 });
    expect(await readMeta(slug, `wake_verify_at:${agent.name}`)).not.toBeNull();
    // 第二条真验证帧被限频（与 REST 同一判定）。
    const again = await sendAs(owner);
    expect(again).toMatchObject({ ok: false, code: "wake_verify_rate_limited" });
  });

  it("已登记 agent 的验证帧仍走真实唤醒链（#990 不回退）：建 delivery、落 serve ledger、不计 guard", async () => {
    const owner = `${uniq("owner")}@example.com`;
    const self = await seedToken("agent", uniq("leo-server"), { owner });
    const slug = await createChannel(self.token);
    await enableLoopGuard(slug, self.token, LOOP_GUARD_N);
    const ws = await registerServe(slug, self.token);
    const res = await verify(slug, self.token, self.name);
    expect(res.status).toBe(200);
    const seq = ((await res.json()) as { seq: number }).seq;
    expect(await deliveryTargets(slug)).toEqual([{ seq, target: self.name }]);
    expect(await ledgerRows(slug)).toEqual([{ seq, target: self.name }]);
    expect(await guardCounters(slug, self.name)).toEqual({ streak: 0, count: 0 });
    expect(await readMeta(slug, `wake_verify_at:${self.name}`)).not.toBeNull();
    ws.close();
  });
});
