import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { api, createChannel, postMessage, seedToken, WsClient } from "./helpers";

// 注入短 TTL（spec §6 默认 14 天，测试等不起）
async function injectIdleMs(slug: string, ms: number) {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
    state.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('temp_idle_ms', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(ms),
    );
  });
}

async function fireAlarm(slug: string) {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  await runInDurableObject(stub, async (instance: ChannelDO) => {
    await instance.onAlarm();
  });
}

describe("temp channel auto-archive", () => {
  it("archives an idle temp channel: kicks ws, rejects sends, writes d1 archived_at, keeps history", async () => {
    const { token } = await seedToken("human");
    const slug = await createChannel(token, "temp");
    expect((await postMessage(slug, token, "last words")).status).toBe(200);

    const ws = await WsClient.open(slug, token);
    await ws.nextOfType("welcome");

    await injectIdleMs(slug, 1);
    await new Promise((r) => setTimeout(r, 10));
    await fireAlarm(slug);

    // 存活连接收到 error:archived 后被踢
    const err = await ws.nextOfType("error");
    expect(err.code).toBe("archived");

    const rejected = await postMessage(slug, token, "too late");
    expect(rejected.status).toBe(410);

    // d1 archived_at 已回写（do 拿 env.DB 直写）
    const row = await env.DB.prepare("SELECT archived_at FROM channels WHERE slug = ?")
      .bind(slug)
      .first<{ archived_at: number | null }>();
    expect(row?.archived_at).not.toBeNull();

    // 归档后仍可回看
    const history = await api(`/api/channels/${slug}/messages`, token);
    expect(history.status).toBe(200);
  });

  it("does not archive a temp channel with recent activity", async () => {
    const { token } = await seedToken("human");
    const slug = await createChannel(token, "temp");
    expect((await postMessage(slug, token, "fresh")).status).toBe(200);

    await injectIdleMs(slug, 60_000);
    await fireAlarm(slug);

    expect((await postMessage(slug, token, "still open")).status).toBe(200);
  });

  it("never idle-archives a standing channel", async () => {
    const { token } = await seedToken("human");
    const slug = await createChannel(token, "standing");
    expect((await postMessage(slug, token, "old message")).status).toBe(200);

    await injectIdleMs(slug, 1);
    await new Promise((r) => setTimeout(r, 10));
    await fireAlarm(slug);

    expect((await postMessage(slug, token, "still standing")).status).toBe(200);
  });
});
