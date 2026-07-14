import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type ChannelDO, PRESENCE_SCAN_MS } from "../src/do";
import { WsClient, createChannel, seedToken } from "./helpers";

describe("alarm scheduling", () => {
  // 修复 1：已存在远期 alarm（temp 归档 +14 天 / webhook 重试）时，新连接仍要排 presence 扫描，
  // 否则 kill -9（无 close 帧）的连接最长要等远期 alarm 才被标 offline，网页假在线可达 14 天。
  // #487：扫描窗口从 60s 拉到 PRESENCE_SCAN_MS(120s) 降 DO compute，断言随之改用该常量。
  it("moves the alarm forward to the presence scan window on connect despite a far-future alarm", async () => {
    const { token } = await seedToken("agent");
    // temp 频道的 /internal/init 会排一个 +14 天的归档 alarm
    const slug = await createChannel(token, "temp");

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    const before = await runInDurableObject(stub, async (_i: ChannelDO, state) =>
      state.storage.getAlarm(),
    );
    // 前置断言：连接前确实是远期 alarm
    expect(before).not.toBeNull();
    expect(before!).toBeGreaterThan(Date.now() + PRESENCE_SCAN_MS + 60_000);

    const ws = await WsClient.open(slug, token);
    await ws.nextOfType("welcome");

    const after = await runInDurableObject(stub, async (_i: ChannelDO, state) =>
      state.storage.getAlarm(),
    );
    expect(after).not.toBeNull();
    expect(after!).toBeLessThanOrEqual(Date.now() + PRESENCE_SCAN_MS + 5_000);
    ws.close();
  });
});
