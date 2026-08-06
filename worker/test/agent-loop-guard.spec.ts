import { env, runInDurableObject } from "cloudflare:test";
import {
  LOOP_GUARD_AGENT_N,
  LOOP_GUARD_AGENT_PARTY_N,
  LOOP_GUARD_N,
} from "@agentparty/shared";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { api, createChannel, disableLoopGuard, postMessage, seedToken, uniq } from "./helpers";

async function enableLoopGuard(slug: string, token: string, limit: number): Promise<void> {
  const res = await api(`/api/channels/${slug}/loop-guard`, token, {
    method: "PUT",
    body: JSON.stringify({ enabled: true, limit }),
  });
  expect(res.status).toBe(200);
}

async function createPartyChannel(token: string): Promise<string> {
  const slug = uniq("party-agent-guard");
  const res = await api("/api/channels", token, {
    method: "POST",
    body: JSON.stringify({ slug, kind: "standing", mode: "party" }),
  });
  expect(res.status).toBe(201);
  return slug;
}

async function seedLoopGuardCounts(slug: string, agentName: string, agentCount: number, streak = agentCount) {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
    state.storage.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?), ('agent_streak', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      `agent_count:${agentName}`,
      String(agentCount),
      String(streak),
    );
  });
}

async function expectLoopGuard(res: Response) {
  expect(res.status).toBe(409);
  await expect(res.json()).resolves.toMatchObject({ error: { code: "loop_guard" } });
}

function postStatus(slug: string, token: string, state: "waiting" | "blocked", note: string): Promise<Response> {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "status", state, note, mentions: [] }),
  });
}

describe("per-agent loop guard fairness", () => {
  it("blocks only the normal-mode agent that has already sent 15 messages", async () => {
    const agentA = await seedToken("agent");
    const agentB = await seedToken("agent");
    const slug = await createChannel(agentA.token);
    await enableLoopGuard(slug, agentA.token, LOOP_GUARD_N);
    expect((await postMessage(slug, agentA.token, "warm up")).status).toBe(200);
    await seedLoopGuardCounts(slug, agentA.name, LOOP_GUARD_AGENT_N - 1);

    expect((await postMessage(slug, agentA.token, "at my quota")).status).toBe(200);
    await expectLoopGuard(await postMessage(slug, agentA.token, "over my quota"));
    expect((await postMessage(slug, agentB.token, "another agent can continue")).status).toBe(200);
  });

  it("uses the 50-message per-agent quota in party mode", async () => {
    const agent = await seedToken("agent");
    const slug = await createPartyChannel(agent.token);
    await enableLoopGuard(slug, agent.token, 200);
    expect((await postMessage(slug, agent.token, "warm up")).status).toBe(200);
    await seedLoopGuardCounts(slug, agent.name, LOOP_GUARD_AGENT_PARTY_N - 1);

    expect((await postMessage(slug, agent.token, "at party quota")).status).toBe(200);
    await expectLoopGuard(await postMessage(slug, agent.token, "party quota exceeded"));
  });

  it("a human message clears every per-agent counter", async () => {
    const agent = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(agent.token);
    await enableLoopGuard(slug, agent.token, LOOP_GUARD_N);
    expect((await postMessage(slug, agent.token, "warm up")).status).toBe(200);
    await seedLoopGuardCounts(slug, agent.name, LOOP_GUARD_AGENT_N);

    expect((await postMessage(slug, human.token, "human reset")).status).toBe(200);
    expect((await postMessage(slug, agent.token, "allowed after reset")).status).toBe(200);
  });

  it("does not enforce per-agent or global quotas while loop guard is disabled", async () => {
    const agent = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(agent.token);
    await disableLoopGuard(slug, human.token);
    await seedLoopGuardCounts(slug, agent.name, LOOP_GUARD_AGENT_N, LOOP_GUARD_N);

    expect((await postMessage(slug, agent.token, "guard disabled")).status).toBe(200);
  });

  it("lets a blocked agent publish status without consuming or clearing its message quota", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    await enableLoopGuard(slug, agent.token, LOOP_GUARD_N);
    expect((await postMessage(slug, agent.token, "warm up")).status).toBe(200);
    await seedLoopGuardCounts(slug, agent.name, LOOP_GUARD_AGENT_N);

    const status = await postStatus(slug, agent.token, "blocked", "loop guard，待人类 reset");
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ seq: 2 });
    await expectLoopGuard(await postMessage(slug, agent.token, "still blocked until a human message"));
  });

  it("a human status does not masquerade as the human message that resets loop guard", async () => {
    const agent = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(agent.token);
    await enableLoopGuard(slug, agent.token, LOOP_GUARD_N);
    expect((await postMessage(slug, agent.token, "warm up")).status).toBe(200);
    await seedLoopGuardCounts(slug, agent.name, LOOP_GUARD_AGENT_N);

    expect((await postStatus(slug, human.token, "waiting", "presence only")).status).toBe(200);
    await expectLoopGuard(await postMessage(slug, agent.token, "status must not reset guard"));
    expect((await postMessage(slug, human.token, "real human reset")).status).toBe(200);
    expect((await postMessage(slug, agent.token, "allowed now")).status).toBe(200);
  });
});

// #815：agent 撞的通常是 per-agent fair-share，不是全局 streak。guard 快照只报全局 remaining
// 时，agent 会以为还有余量、写完长消息才被拒——那条消息就丢了。
describe("loop guard snapshot exposes the caller's own fair-share budget", () => {
  it("reports the agent's own remaining quota, not just the channel streak", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    await enableLoopGuard(slug, agent.token, LOOP_GUARD_N);
    await seedLoopGuardCounts(slug, agent.name, LOOP_GUARD_AGENT_N - 3, 1);

    const res = await api(`/api/channels/${slug}/loop-guard`, agent.token);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      enabled: true,
      limit: LOOP_GUARD_N,
      streak: 1,
      // 全局还很宽松，但自己只剩 3 条——这才是 agent 需要看到的数字。
      remaining: LOOP_GUARD_N - 1,
      self: {
        name: agent.name,
        limit: LOOP_GUARD_AGENT_N,
        used: LOOP_GUARD_AGENT_N - 3,
        remaining: 3,
      },
    });
  });

  it("caps the caller's remaining by the channel streak when the global guard is the tighter wall", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    await enableLoopGuard(slug, agent.token, LOOP_GUARD_N);
    // 自己一条没发过，但频道整体只剩 2 条：能再发的是 2，不是 fair-share 的满额。
    await seedLoopGuardCounts(slug, agent.name, 0, LOOP_GUARD_N - 2);

    const res = await api(`/api/channels/${slug}/loop-guard`, agent.token);
    await expect(res.json()).resolves.toMatchObject({
      remaining: 2,
      self: { used: 0, remaining: 2 },
    });
  });

  it("omits the self block for a human caller — humans are not rate-limited by the guard", async () => {
    const agent = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(agent.token);
    await enableLoopGuard(slug, agent.token, LOOP_GUARD_N);

    const body = (await (await api(`/api/channels/${slug}/loop-guard`, human.token)).json()) as Record<string, unknown>;
    expect(body.self).toBeUndefined();
    expect(body.enabled).toBe(true);
  });
});
