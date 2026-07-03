import { env, runInDurableObject } from "cloudflare:test";
import { LOOP_GUARD_N, LOOP_GUARD_PARTY_N } from "@agentparty/shared";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { api, postMessage, seedToken, uniq } from "./helpers";

async function createModeChannel(token: string, mode?: string): Promise<string> {
  const slug = uniq("party");
  const res = await api("/api/channels", token, {
    method: "POST",
    body: JSON.stringify({ slug, kind: "standing", ...(mode === undefined ? {} : { mode }) }),
  });
  expect(res.status).toBe(201);
  return slug;
}

// 直接拨 do meta 里的 agent_streak，避免真发几百条消息（速率限制也不允许）
async function seedStreak(slug: string, streak: number) {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
    state.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('agent_streak', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(streak),
    );
  });
}

describe("party mode", () => {
  it("0002 migration: create accepts mode, list returns it, default is normal", async () => {
    const { token } = await seedToken("agent");
    const partySlug = uniq("party");
    const created = await api("/api/channels", token, {
      method: "POST",
      body: JSON.stringify({ slug: partySlug, kind: "standing", mode: "party" }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ slug: partySlug, mode: "party" });

    const defaulted = await api("/api/channels", token, {
      method: "POST",
      body: JSON.stringify({ slug: uniq("normal"), kind: "temp" }),
    });
    expect(await defaulted.json()).toMatchObject({ mode: "normal" });

    const list = await api("/api/channels", token);
    const { channels } = (await list.json()) as { channels: { slug: string; mode: string }[] };
    expect(channels.find((c) => c.slug === partySlug)?.mode).toBe("party");

    const invalid = await api("/api/channels", token, {
      method: "POST",
      body: JSON.stringify({ slug: uniq("bad"), mode: "rave" }),
    });
    expect(invalid.status).toBe(400);
  });

  it("party channel: the 31st consecutive agent message passes, the 201st trips the guard", async () => {
    const { token } = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createModeChannel(token, "party");

    // 首条消息让 do 缓存 mode=party
    expect((await postMessage(slug, token, "kickoff")).status).toBe(200);

    await seedStreak(slug, LOOP_GUARD_N);
    const thirtyFirst = await postMessage(slug, token, "31st in a row");
    expect(thirtyFirst.status).toBe(200);

    await seedStreak(slug, LOOP_GUARD_PARTY_N);
    const twoHundredFirst = await postMessage(slug, token, "201st in a row");
    expect(twoHundredFirst.status).toBe(409);
    const body = (await twoHundredFirst.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("loop_guard");
    expect(body.error.message).toContain(String(LOOP_GUARD_PARTY_N));

    // 人类发言重置计数，agent 恢复发言
    expect((await postMessage(slug, human.token, "humans joined the party")).status).toBe(200);
    expect((await postMessage(slug, token, "back to it")).status).toBe(200);
  });

  it("normal channel still trips at the 31st consecutive agent message", async () => {
    const { token } = await seedToken("agent");
    const slug = await createModeChannel(token);
    expect((await postMessage(slug, token, "kickoff")).status).toBe(200);
    await seedStreak(slug, LOOP_GUARD_N);
    const blocked = await postMessage(slug, token, "31st");
    expect(blocked.status).toBe(409);
  });
});
