// #200：吊销扇出按 channel_presence 活连接注册表收窄。
//
// 背景：DELETE /api/tokens/:name 原来 `SELECT slug FROM channels`（无过滤）唤醒每一个
// 频道 DO 去踢线——O(全部频道)，149 频道时扇出 8.3s，是 #185 flaky 的主因。
// 修法：DO 在 ws connect/disconnect 维护 D1 表 channel_presence；DELETE 只对注册表里
// 确有该 name 活连接的频道发 /internal/kick（通常 0-1 个）。
//
// 正确性红线：假阴性（漏一个活连接 → 被吊销 token 继续在线）= 安全漏洞，必须避免；
// 假阳性（残留过期行 → 多踢一个无匹配连接的频道）= 冷启动 no-op，无害。
import { describe, expect, it } from "vitest";
import { ADMIN_HEADERS, createChannel, postMessage, seedToken, uniq, WsClient } from "./helpers";
import { SELF, env } from "cloudflare:test";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function presenceChannels(name: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT channel_slug FROM channel_presence WHERE name = ? ORDER BY channel_slug",
  )
    .bind(name)
    .all<{ channel_slug: string }>();
  return results.map((r) => r.channel_slug);
}

function revoke(name: string): Promise<Response> {
  return SELF.fetch(`http://ap.test/api/tokens/${name}`, { method: "DELETE", headers: ADMIN_HEADERS });
}

describe("revocation fanout narrowed by channel_presence (#200)", () => {
  // 测试1：onConnect 在 welcome 之前 await 写入注册表行。victim 只连 A（另建 B 不连），
  // 注册表必须只出现 A，不含 B。变异（注释掉 onConnect 的 upsert）→ 此断言红。
  it("records a live-connection row for the channel the victim actually joined, not others", async () => {
    const victim = await seedToken("agent", uniq("victim"));
    const host = await seedToken("human", uniq("host"));
    const chanA = await createChannel(host.token);
    const chanB = await createChannel(host.token); // 建了但 victim 不连

    const ws = await WsClient.open(chanA, victim.token);
    await ws.nextOfType("welcome"); // welcome 到达时行已落库（upsert 在 welcome 之前 await）

    expect(await presenceChannels(victim.name)).toEqual([chanA]);
    expect(await presenceChannels(victim.name)).not.toContain(chanB);
    ws.close();
  }, 30_000);

  // 测试2：onClose 走到 markOffline 分支（该 name 在本 DO 最后一条连接）时 await 删行。
  // 断开后轮询直到行消失。变异（注释掉 onClose 的 delete）→ 行永不消失 → 超时红。
  it("removes the registry row after the victim's last connection closes", async () => {
    const victim = await seedToken("agent", uniq("victim"));
    const host = await seedToken("human", uniq("host"));
    const chanA = await createChannel(host.token);

    const ws = await WsClient.open(chanA, victim.token);
    await ws.nextOfType("welcome");
    expect(await presenceChannels(victim.name)).toEqual([chanA]);

    ws.close();
    // onClose 是异步删；给它落库时间，最多轮询 ~2s。
    let rows = await presenceChannels(victim.name);
    for (let i = 0; i < 40 && rows.length > 0; i++) {
      await sleep(50);
      rows = await presenceChannels(victim.name);
    }
    expect(rows).toEqual([]);
  }, 30_000);

  // 测试3：安全不回归——收窄后仍踢得掉被吊销 token 的活连接。照抄 broadcast-order.spec.ts:75 的模式。
  it("still kicks a revoked token's live ws after narrowing (no false negative)", async () => {
    const victim = await seedToken("agent", uniq("victim"));
    const other = await seedToken("human", uniq("other"));
    const chanA = await createChannel(other.token);

    const ws = await WsClient.open(chanA, victim.token);
    await ws.nextOfType("welcome");

    const del = await revoke(victim.name);
    expect(del.status).toBe(200);

    // 任一条消息都会触发连接扫描；被吊销的连接必须收到 unauthorized（DELETE 扇出本身也会踢）。
    expect((await postMessage(chanA, other.token, "trigger the scan")).status).toBe(200);
    const err = (await ws.nextOfType("error")) as { code: string };
    expect(err.code).toBe("unauthorized");
    ws.close();
  }, 30_000);

  // 测试4：收窄语义（间接）——victim 在 A 有活连接、B 无。吊销时注册表只解析出 A，
  // 证明扇出面 = 1（不再是 O(全部频道)）。B 的 DO 是否被冷启动无直接 API 可测——
  // 只能靠注册表行数间接保证扇出集合 = {A}。
  it("resolves the revocation fanout set to exactly the channels holding a live row", async () => {
    const victim = await seedToken("agent", uniq("victim"));
    const host = await seedToken("human", uniq("host"));
    const chanA = await createChannel(host.token);
    await createChannel(host.token); // B：在 channels 表里，但 victim 无活连接 → 不该进扇出集

    const ws = await WsClient.open(chanA, victim.token);
    await ws.nextOfType("welcome");

    // 吊销前：注册表对 victim 只有 A 一行 → 扇出面 = {A}，而不是全部频道。
    expect(await presenceChannels(victim.name)).toEqual([chanA]);

    const del = await revoke(victim.name);
    expect(del.status).toBe(200);
    const err = (await ws.nextOfType("error")) as { code: string };
    expect(err.code).toBe("unauthorized");
    ws.close();
  }, 30_000);

  // 测试5：收窄的「源」是注册表而非 channels 全表——这条精确咬住 DELETE 的查询。
  // 构造：victim 连 A，但手动清掉它的注册表行（模拟「扇出源 = 注册表」下无匹配行）。
  // 收窄查询（正确）→ 扇出集为空 → 不发 kick → victim 不被吊销扇出踢（窗口内无 error 帧）。
  // 变异（DELETE 改回 `SELECT slug FROM channels`）→ A 在 channels 表 → 踢 A → victim 收到
  // unauthorized → 本条红。这也从反面说明：onConnect 的 upsert 必须可靠 await（否则真实
  // 场景下漏行 = 活连接踢不掉 = 安全漏洞）。
  it("drives the fanout from channel_presence, not the full channels table", async () => {
    const victim = await seedToken("agent", uniq("victim"));
    const host = await seedToken("human", uniq("host"));
    const chanA = await createChannel(host.token);

    const ws = await WsClient.open(chanA, victim.token);
    await ws.nextOfType("welcome");
    expect(await presenceChannels(victim.name)).toEqual([chanA]);

    // 手动清掉注册表行——扇出源里再无该 name 的活连接。
    await env.DB.prepare("DELETE FROM channel_presence WHERE name = ?").bind(victim.name).run();

    const del = await revoke(victim.name);
    expect(del.status).toBe(200);

    // 收窄查询扇出集为空 → 不发 kick → 窗口内 victim 收不到 error 帧（无其它扫描触发）。
    // 用 nextOfType 跳过 connect 时的 participants 广播，只等 error——超时即证明没被踢。
    await expect(ws.nextOfType("error", 600)).rejects.toThrow(/timeout/);
    ws.close();
  }, 30_000);
});
