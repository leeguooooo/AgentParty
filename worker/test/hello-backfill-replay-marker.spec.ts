// #861 回归：hello 补拉出去的帧必须在 wire 上带 replay:true，live 广播必须**不带**。
// 客户端（web/desktop）据此把「重放的历史」与「真的新消息」分开——否则 socket 重建时
// 服务端把整段历史当 live 帧重放，10 天前的老 @ 会当场弹系统通知。
import { describe, expect, it } from "vitest";
import { WsClient, completeCapabilityHello, createChannel, seedToken } from "./helpers";

describe("hello backfill replay marker (#861)", () => {
  it("marks since=0 backfilled frames with replay:true", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);

    const writer = await WsClient.open(slug, token);
    await completeCapabilityHello(writer);
    writer.send({ type: "send", kind: "message", body: "@Evan 接口报错验证失败", mentions: [] });
    const live = await writer.nextOfType("msg", 8000);
    // live 广播不带标记（这条断言若失守，客户端会把所有新消息当历史静音）
    expect(live.replay).toBeUndefined();
    writer.close();

    // 全新连接以 since=0 重连：同一条消息这次是补拉来的，必须带标记
    const reader = await WsClient.open(slug, token);
    await completeCapabilityHello(reader);
    const replayed = await reader.nextOfType("msg", 8000);
    reader.close();

    expect(replayed.seq).toBe(live.seq);
    expect(replayed.body).toBe(live.body);
    expect(replayed.replay).toBe(true);
  });

  it("keeps live frames unmarked on a socket that already finished its backfill", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);

    const writer = await WsClient.open(slug, token);
    await completeCapabilityHello(writer);
    writer.send({ type: "send", kind: "message", body: "first", mentions: [] });
    const first = await writer.nextOfType("msg", 8000);
    expect(first.replay).toBeUndefined();

    // 第二个观察者补拉到 first（带标记），随后收到的 live second 不带标记
    const reader = await WsClient.open(slug, token);
    await completeCapabilityHello(reader);
    const backfilled = await reader.nextOfType("msg", 8000);
    expect(backfilled.replay).toBe(true);

    writer.send({ type: "send", kind: "message", body: "second", mentions: [] });
    const second = await reader.nextOfType("msg", 8000);
    expect(second.body).toBe("second");
    expect(second.replay).toBeUndefined();

    writer.close();
    reader.close();
  });
});
