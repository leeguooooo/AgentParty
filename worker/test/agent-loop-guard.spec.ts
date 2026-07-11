import { env, runInDurableObject } from "cloudflare:test";
import {
  LOOP_GUARD_AGENT_N,
  LOOP_GUARD_AGENT_PARTY_N,
  LOOP_GUARD_N,
} from "@agentparty/shared";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { api, createChannel, disableLoopGuard, postMessage, seedToken, uniq } from "./helpers";

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

describe("per-agent loop guard fairness", () => {
  it("blocks only the normal-mode agent that has already sent 15 messages", async () => {
    const agentA = await seedToken("agent");
    const agentB = await seedToken("agent");
    const slug = await createChannel(agentA.token);
    expect((await postMessage(slug, agentA.token, "warm up")).status).toBe(200);
    await seedLoopGuardCounts(slug, agentA.name, LOOP_GUARD_AGENT_N - 1);

    expect((await postMessage(slug, agentA.token, "at my quota")).status).toBe(200);
    await expectLoopGuard(await postMessage(slug, agentA.token, "over my quota"));
    expect((await postMessage(slug, agentB.token, "another agent can continue")).status).toBe(200);
  });

  it("uses the 50-message per-agent quota in party mode", async () => {
    const agent = await seedToken("agent");
    const slug = await createPartyChannel(agent.token);
    expect((await postMessage(slug, agent.token, "warm up")).status).toBe(200);
    await seedLoopGuardCounts(slug, agent.name, LOOP_GUARD_AGENT_PARTY_N - 1);

    expect((await postMessage(slug, agent.token, "at party quota")).status).toBe(200);
    await expectLoopGuard(await postMessage(slug, agent.token, "party quota exceeded"));
  });

  it("a human message clears every per-agent counter", async () => {
    const agent = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(agent.token);
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
});
