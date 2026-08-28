// #990：接入引导第 4 步的验证帧——本身份对自己的显式召唤。
//
// #963 把「自 @」判成「对话里提到自己」：不建 directed delivery、不落 broadcast ledger、不投 webhook。
// 验证帧（`[wake-verify]` 前缀 + mentions 只含自己）是唯一例外：它就是要让本身份走一遍真实唤醒链。
// 同时它是探针不是对话：不计入 loop guard 的 streak / fair-share（反复跑接入引导不该吃光频道名额），
// 但频道已熔断时照样拒——那时 @ 本来就到不了它，验证失败是真话。
import { env, runInDurableObject } from "cloudflare:test";
import { LOOP_GUARD_AGENT_N, LOOP_GUARD_N, WAKE_VERIFY_PREFIX, isWakeVerifyFrame } from "@agentparty/shared";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { fetchMock } from "./fetch-mock";
import { WsClient, api, completeCapabilityHello, createChannel, postMessage, seedToken, uniq } from "./helpers";

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

async function guardCounters(slug: string, agentName: string): Promise<{ streak: number; count: number }> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_instance: ChannelDO, state) => {
    const read = (key: string) => {
      const row = state.storage.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
      return row === undefined ? 0 : Number(row.value);
    };
    return { streak: read("agent_streak"), count: read(`agent_count:${agentName}`) };
  });
}

async function seedGuardCounters(slug: string, agentName: string, count: number, streak = count) {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
    state.storage.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?), ('agent_streak', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      `agent_count:${agentName}`,
      String(count),
      String(streak),
    );
  });
}

async function enableLoopGuard(slug: string, token: string, limit: number): Promise<void> {
  const res = await api(`/api/channels/${slug}/loop-guard`, token, {
    method: "PUT",
    body: JSON.stringify({ enabled: true, limit }),
  });
  expect(res.status).toBe(200);
}

// 用真实 WS status 帧把 agent 登记成 serve（服务端据此盖 presence.wake_kind）。
async function registerServe(slug: string, token: string): Promise<WsClient> {
  const ws = await WsClient.open(slug, token);
  await completeCapabilityHello(ws);
  ws.send({ type: "send", kind: "status", state: "waiting", note: "standby", mentions: [], residency: "supervised", wake: { kind: "serve" } });
  await ws.nextOfType("sent");
  return ws;
}

describe("isWakeVerifyFrame（共享判据）", () => {
  it("三样缺一不可：前缀 + kind=message + mentions 只含自己", () => {
    const base = { kind: "message" as const, body: `${WAKE_VERIFY_PREFIX} @me ping`, mentions: ["me"], sender: { name: "me" } };
    expect(isWakeVerifyFrame(base)).toBe(true);
    // ASCII 大小写按 mentionMatchKey 同一把尺子
    expect(isWakeVerifyFrame({ ...base, mentions: ["ME"] })).toBe(true);
    expect(isWakeVerifyFrame({ ...base, body: "@me ping" })).toBe(false);
    expect(isWakeVerifyFrame({ ...base, kind: "status" })).toBe(false);
    expect(isWakeVerifyFrame({ ...base, mentions: [] })).toBe(false);
    expect(isWakeVerifyFrame({ ...base, mentions: ["me", "peer"] })).toBe(false);
    expect(isWakeVerifyFrame({ ...base, mentions: ["peer"] })).toBe(false);
    expect(isWakeVerifyFrame({ ...base, body: null })).toBe(false);
    expect(isWakeVerifyFrame({ ...base, mentions: undefined })).toBe(false);
  });
});

describe("验证帧是自 @ 的唯一例外（issue #990）", () => {
  it("验证帧：为自己建 directed delivery、落 serve broadcast ledger；普通自 @ 依旧不建（#963 不回退）", async () => {
    const owner = `${uniq("owner")}@example.com`;
    const self = await seedToken("agent", uniq("leo-server"), { owner });
    const slug = await createChannel(self.token);
    const ws = await registerServe(slug, self.token);

    // 对照：普通自 @ 没有任何唤醒语义。
    const plain = await send(slug, self.token, `@${self.name} 这次醒了`, [self.name]);
    expect(plain.status).toBe(200);
    expect(await deliveryTargets(slug)).toEqual([]);
    expect(await ledgerRows(slug)).toEqual([]);

    // 验证帧：与别人 @ 它完全同一条路径。
    const verify = await send(slug, self.token, `${WAKE_VERIFY_PREFIX} @${self.name} ping`, [self.name]);
    expect(verify.status).toBe(200);
    const seq = ((await verify.json()) as { seq: number }).seq;
    expect(await deliveryTargets(slug)).toEqual([{ seq, target: self.name }]);
    expect(await ledgerRows(slug)).toEqual([{ seq, target: self.name, kind: "serve", result: "broadcast" }]);
    ws.close();
  });

  it("前缀对了但还 @ 了别人：不是验证帧，自己那份照旧不建，只给别人建", async () => {
    const owner = `${uniq("owner")}@example.com`;
    const self = await seedToken("agent", uniq("leo-server"), { owner });
    const peer = await seedToken("agent", uniq("peer"), { owner });
    const slug = await createChannel(self.token);
    const res = await send(slug, self.token, `${WAKE_VERIFY_PREFIX} @${peer.name} 看看 @${self.name}`, [peer.name, self.name]);
    expect(res.status).toBe(200);
    const seq = ((await res.json()) as { seq: number }).seq;
    expect(await deliveryTargets(slug)).toEqual([{ seq, target: peer.name }]);
  });
});

describe("验证帧不计 loop guard（issue #990）", () => {
  it("连发验证帧不推 streak / fair-share 计数；普通消息的名额一条不少", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    await enableLoopGuard(slug, agent.token, LOOP_GUARD_N);
    expect((await postMessage(slug, agent.token, "warm up")).status).toBe(200);
    await seedGuardCounters(slug, agent.name, LOOP_GUARD_AGENT_N - 1);

    for (let i = 0; i < 3; i += 1) {
      const res = await send(slug, agent.token, `${WAKE_VERIFY_PREFIX} @${agent.name} ping ${i}`, [agent.name]);
      expect(res.status).toBe(200);
    }
    // 三条验证帧过去了，计数器纹丝不动。
    expect(await guardCounters(slug, agent.name)).toEqual({ streak: LOOP_GUARD_AGENT_N - 1, count: LOOP_GUARD_AGENT_N - 1 });
    // 最后一条普通消息的名额还在（若验证帧计了数，这条就已经 409）。
    expect((await postMessage(slug, agent.token, "at my quota")).status).toBe(200);
    const over = await postMessage(slug, agent.token, "over my quota");
    expect(over.status).toBe(409);
    await expect(over.json()).resolves.toMatchObject({ error: { code: "loop_guard" } });
  });

  it("频道已熔断时验证帧照样被拒——@ 本来就到不了它，验证失败是真话", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    await enableLoopGuard(slug, agent.token, LOOP_GUARD_N);
    await seedGuardCounters(slug, agent.name, LOOP_GUARD_AGENT_N);
    const res = await send(slug, agent.token, `${WAKE_VERIFY_PREFIX} @${agent.name} ping`, [agent.name]);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "loop_guard" } });
  });
});
