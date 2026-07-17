import type { PresenceEntry } from "@agentparty/shared";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { WsClient, api, createChannel, seedToken, uniq } from "./helpers";

// 交互 lane 活动直报（issue #615）：不跑 serve 的 Claude Code session 由 hook 经 REST 端点
// 自报「正在干什么」。关键变化：presence 序列化不再把 activity 绑死 current_task——
// 交互 lane 没有任务上下文，改按 TTL(5min) 判新鲜。

async function fetchPresence(slug: string, token: string): Promise<PresenceEntry[]> {
  const res = await api(`/api/channels/${slug}/presence`, token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { presence: PresenceEntry[] }).presence;
}

async function postActivity(slug: string, token: string, name: string, activity: unknown): Promise<Response> {
  return api(`/api/channels/${slug}/presence/${encodeURIComponent(name)}/activity`, token, {
    method: "POST",
    body: JSON.stringify({ activity }),
  });
}

async function attachPresence(slug: string, token: string): Promise<WsClient> {
  const ws = await WsClient.open(slug, token);
  await ws.nextOfType("welcome");
  ws.send({ type: "hello", since: 0 });
  ws.send({ type: "send", kind: "status", state: "waiting", note: "interactive", mentions: [] });
  await ws.nextOfType("sent");
  return ws;
}

describe("interactive-lane activity self-report (issue #615)", () => {
  it("attaches a fresh activity to presence WITHOUT any current_task", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await attachPresence(slug, agent.token);

    const ts = Date.now();
    const res = await postActivity(slug, agent.token, agent.name, { phase: "tool", tool: "Bash", ts });
    expect(res.status).toBe(200);

    const entry = (await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name);
    // #615 的核心：没有 current_task 也能看见活动（交互 lane 没有任务上下文）
    expect(entry).toMatchObject({ activity: { phase: "tool", tool: "Bash", ts } });
    expect(entry).not.toHaveProperty("current_task");
    ws.close();
  });

  it("waiting_permission reaches the channel from a serve-less session", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await attachPresence(slug, agent.token);

    const res = await postActivity(slug, agent.token, agent.name, {
      phase: "waiting_permission",
      tool: "Bash",
      ts: Date.now(),
    });
    expect(res.status).toBe(200);
    const entry = (await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name);
    expect(entry?.activity?.phase).toBe("waiting_permission");
    ws.close();
  });

  it("rejects reporting for another name and rejects humans", async () => {
    const agent = await seedToken("agent");
    const other = await seedToken("agent", uniq("other"));
    const human = await seedToken("human");
    const slug = await createChannel(agent.token);
    const ws = await attachPresence(slug, agent.token);

    const impersonate = await postActivity(slug, other.token, agent.name, { phase: "working", ts: Date.now() });
    expect(impersonate.status).toBe(403);
    const asHuman = await postActivity(slug, human.token, agent.name, { phase: "working", ts: Date.now() });
    expect(asHuman.status).toBe(403);
    const garbage = await postActivity(slug, agent.token, agent.name, { phase: "hacking", ts: Date.now() });
    expect(garbage.status).toBe(400);
    // 远未来时间戳拒收：ts 是 TTL 的输入，放进来会让僵活动永不过期
    const future = await postActivity(slug, agent.token, agent.name, { phase: "working", ts: Date.now() + 10 * 60_000 });
    expect(future.status).toBe(400);
    ws.close();
  });

  it("a stale activity (past the 5min TTL) is not serialized into presence", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await attachPresence(slug, agent.token);

    // 直接把远古活动塞进存储：序列化侧的 TTL 门禁必须把它过滤掉（僵活动不外泄）。
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      state.storage.sql.exec(
        "UPDATE presence SET activity_json = ? WHERE name = ?",
        JSON.stringify({ phase: "tool", tool: "Bash", ts: Date.now() - 6 * 60_000 }),
        agent.name,
      );
    });

    const entry = (await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name);
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("activity");
    ws.close();
  });

  it("no presence rows -> reported as not attached, no error", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    // 从未在频道露过面（没有 presence 行）
    const res = await postActivity(slug, agent.token, agent.name, { phase: "working", ts: Date.now() });
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ ok: true, attached: false });
  });
});
