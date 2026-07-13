// issue #180：人可暂停某 agent 的接待（如 token 不够用了）。暂停期该 agent 被 @ 也不唤醒
// （webhook 不投），但消息照进频道历史；到点由 DO alarm 自动恢复，也可手动恢复。非 moderator 不能暂停。
import type { PresenceEntry } from "@agentparty/shared";
import { env, runInDurableObject } from "cloudflare:test";
import { fetchMock } from "./fetch-mock";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { api, createChannel, seedToken, uniq } from "./helpers";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

function sendMention(slug: string, token: string, target: string) {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body: `@${target} ping`, mentions: [target], reply_to: null }),
  });
}

function addWebhook(slug: string, token: string, name: string, url: string, filter = "mentions") {
  return api(`/api/channels/${slug}/webhooks`, token, {
    method: "POST",
    body: JSON.stringify({ name, url, secret: "s", filter }),
  });
}

function pause(slug: string, token: string, name: string, resumeAt?: number) {
  return api(`/api/channels/${slug}/presence/${encodeURIComponent(name)}/pause`, token, {
    method: "POST",
    body: JSON.stringify(resumeAt === undefined ? {} : { resume_at: resumeAt }),
  });
}

function resume(slug: string, token: string, name: string) {
  return api(`/api/channels/${slug}/presence/${encodeURIComponent(name)}/resume`, token, {
    method: "POST",
  });
}

async function presenceOf(slug: string, token: string, name: string): Promise<PresenceEntry | undefined> {
  const res = await api(`/api/channels/${slug}/presence`, token);
  const body = (await res.json()) as { presence: PresenceEntry[] };
  return body.presence.find((p) => p.name === name);
}

async function ledgerCount(slug: string): Promise<number> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_i: ChannelDO, state) =>
    Number(state.storage.sql.exec("SELECT COUNT(*) AS n FROM wake_delivery_ledger").one().n),
  );
}

async function bodiesInHistory(slug: string, token: string): Promise<string[]> {
  const res = await api(`/api/channels/${slug}/messages?since=0`, token);
  const body = (await res.json()) as { messages: { body: string }[] };
  return body.messages.map((m) => m.body);
}

async function assignHost(slug: string, moderatorToken: string, name: string): Promise<void> {
  const res = await api(`/api/channels/${slug}/roles/${encodeURIComponent(name)}`, moderatorToken, {
    method: "PUT",
    body: JSON.stringify({ role: "host" }),
  });
  if (!res.ok) throw new Error(`assign host failed: ${res.status} ${await res.text()}`);
}

async function managementAudit(slug: string, token: string): Promise<Array<{
  actor_account: string | null;
  actor_kind: string;
  action: string;
  resource: string;
  channel: string | null;
  metadata: Record<string, unknown>;
}>> {
  const res = await api(`/api/channels/${slug}/management-audit?limit=100`, token);
  if (!res.ok) throw new Error(`management audit failed: ${res.status}`);
  return ((await res.json()) as { audit: Array<{
    actor_account: string | null;
    actor_kind: string;
    action: string;
    resource: string;
    channel: string | null;
    metadata: Record<string, unknown>;
  }> }).audit;
}

describe("暂停接待（issue #180）", () => {
  it("被暂停的 agent 被 @ 时不投 webhook（唤醒被抑制），但消息仍进历史", async () => {
    const { token } = await seedToken("agent");
    const target = uniq("paused-agent");
    await seedToken("agent", target);
    const slug = await createChannel(token);
    // target 注册了 mentions webhook：正常情况下 @它就会被投递唤醒
    expect((await addWebhook(slug, token, target, "https://paused-wake.test/hook")).status).toBe(201);

    // 人为暂停 target 的接待
    const paused = await pause(slug, token, target);
    expect(paused.status).toBe(200);

    // @它——不注册任何 interceptor：一旦有投递发生，disableNetConnect 会让 fetch 抛错并落一条失败 ledger
    const sent = await sendMention(slug, token, target);
    expect(sent.status).toBe(200);
    await new Promise((r) => setTimeout(r, 80));

    // 唤醒被抑制：wake_delivery_ledger 没有任何一行（webhook 从未尝试投递）
    expect(await ledgerCount(slug)).toBe(0);

    // 但消息照进历史（历史/广播不受影响）
    expect(await bodiesInHistory(slug, token)).toContain(`@${target} ping`);
  });

  it("恢复接待后，@它重新触发 webhook 投递", async () => {
    const { token } = await seedToken("agent");
    const target = uniq("resume-agent");
    await seedToken("agent", target);
    const slug = await createChannel(token);
    expect((await addWebhook(slug, token, target, "https://resume-wake.test/hook")).status).toBe(201);

    expect((await pause(slug, token, target)).status).toBe(200);
    expect((await resume(slug, token, target)).status).toBe(200);

    // 恢复后 target 不再 paused
    expect((await presenceOf(slug, token, target))?.paused).toBeUndefined();

    // 现在 @它应真的投递一次
    fetchMock.get("https://resume-wake.test").intercept({ path: "/hook", method: "POST" }).reply(200, "ok");
    expect((await sendMention(slug, token, target)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 80));
    expect(await ledgerCount(slug)).toBe(1);
  });

  it("presence 暴露 paused + resume_at；到点 onAlarm 自动恢复", async () => {
    const { token } = await seedToken("agent");
    const target = uniq("timed-agent");
    await seedToken("agent", target);
    const slug = await createChannel(token);

    const resumeAt = Date.now() + 60_000;
    expect((await pause(slug, token, target, resumeAt)).status).toBe(200);

    const beforeEntry = await presenceOf(slug, token, target);
    expect(beforeEntry?.paused).toBe(true);
    expect(beforeEntry?.resume_at).toBe(resumeAt);

    // 把恢复时刻提前到过去，跑一次 alarm：定时恢复应清除暂停
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      state.storage.sql.exec("UPDATE presence SET paused_resume_at = ? WHERE name = ?", Date.now() - 1, target);
      await instance.onAlarm();
    });

    const afterEntry = await presenceOf(slug, token, target);
    expect(afterEntry?.paused).toBeUndefined();
    expect(afterEntry?.resume_at).toBeUndefined();
  });

  it("非 moderator（channel-scoped token）不能暂停", async () => {
    const { token } = await seedToken("agent");
    const target = uniq("guarded-agent");
    await seedToken("agent", target);
    const slug = await createChannel(token);
    // scoped 到本频道：能访问，但不是 moderator
    const { token: scoped } = await seedToken("agent", uniq("scoped"), { channelScope: slug });

    const res = await pause(slug, scoped, target);
    expect(res.status).toBe(403);
    // 未真的暂停
    expect((await presenceOf(slug, token, target))?.paused).toBeUndefined();
  });

  it("频道 host agent 可暂停并恢复 agent，且两次止损操作都可审计（#439）", async () => {
    const owner = await seedToken("agent");
    const slug = await createChannel(owner.token);
    const target = await seedToken("agent", uniq("runaway"), { channelScope: slug });
    const hostAccount = `${uniq("host")}@example.com`;
    const host = await seedToken("agent", uniq("host-agent"), { owner: hostAccount, channelScope: slug });
    await assignHost(slug, owner.token, host.name);

    const resumeAt = Date.now() + 60_000;
    expect((await pause(slug, host.token, target.name, resumeAt)).status).toBe(200);
    expect((await presenceOf(slug, owner.token, target.name))?.paused).toBe(true);
    expect((await resume(slug, host.token, target.name)).status).toBe(200);
    expect((await presenceOf(slug, owner.token, target.name))?.paused).toBeUndefined();

    const audit = await managementAudit(slug, owner.token);
    const resource = `channel/${slug}/agents/${target.name}/reception`;
    expect(audit).toContainEqual(expect.objectContaining({
      actor_account: hostAccount,
      actor_kind: "agent",
      action: "agent.reception.pause",
      resource,
      channel: slug,
      metadata: { resume_at: resumeAt },
    }));
    expect(audit).toContainEqual(expect.objectContaining({
      actor_account: hostAccount,
      actor_kind: "agent",
      action: "agent.reception.resume",
      resource,
      channel: slug,
      metadata: {},
    }));
  });

  it("host agent 只能控制有效 agent，不能暂停 human、过期或其他频道 scope 的 agent", async () => {
    const owner = await seedToken("agent");
    const slug = await createChannel(owner.token);
    const host = await seedToken("agent", uniq("host-agent"), { owner: `${uniq("host")}@example.com`, channelScope: slug });
    await assignHost(slug, owner.token, host.name);
    const human = await seedToken("human", uniq("human-target"), { channelScope: slug });
    const expired = await seedToken("agent", uniq("expired-agent"), { channelScope: slug, childExpiresAt: Date.now() - 1_000 });
    const otherScoped = await seedToken("agent", uniq("other-agent"), { channelScope: uniq("other-channel") });

    expect((await pause(slug, host.token, human.name)).status).toBe(403);
    expect((await pause(slug, host.token, expired.name)).status).toBe(403);
    expect((await pause(slug, host.token, otherScoped.name)).status).toBe(403);
    expect((await resume(slug, host.token, human.name)).status).toBe(403);
    expect((await managementAudit(slug, owner.token)).filter((entry) => entry.action.startsWith("agent.reception."))).toHaveLength(0);
  });

  it("scope 在另一个频道的 token 即使被分配当前频道 host，也不能跨频道暂停 agent", async () => {
    const owner = await seedToken("agent");
    const slug = await createChannel(owner.token);
    const otherSlug = await createChannel(owner.token);
    const hostAccount = `${uniq("host")}@example.com`;
    const host = await seedToken("agent", uniq("host-agent"), { owner: hostAccount, channelScope: otherSlug });
    await assignHost(slug, owner.token, host.name);
    const target = await seedToken("agent", uniq("target"), { channelScope: slug });

    expect((await pause(slug, host.token, target.name)).status).toBe(403);
    expect((await presenceOf(slug, owner.token, target.name))?.paused).toBeUndefined();
  });

  it("resume_at 必须是未来的整数 epoch-ms，否则 400", async () => {
    const { token } = await seedToken("agent");
    const target = uniq("badtime-agent");
    await seedToken("agent", target);
    const slug = await createChannel(token);
    expect((await pause(slug, token, target, Date.now() - 10_000)).status).toBe(400);
  });

  it("暂停一个从未连接/离线的 agent：凭空建 paused presence 行，唤醒照样被抑制", async () => {
    const { token } = await seedToken("agent");
    const target = uniq("offline-agent"); // 只建 token，从不开 WS → 无 presence 行
    await seedToken("agent", target);
    const slug = await createChannel(token);
    expect((await addWebhook(slug, token, target, "https://offline-wake.test/hook")).status).toBe(201);

    expect((await pause(slug, token, target)).status).toBe(200);
    expect((await presenceOf(slug, token, target))?.paused).toBe(true);

    expect((await sendMention(slug, token, target)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 80));
    expect(await ledgerCount(slug)).toBe(0);
  });

  it("双重暂停：第二次带新 resume_at 覆盖，仍是暂停（幂等，不报错）", async () => {
    const { token } = await seedToken("agent");
    const target = uniq("double-agent");
    await seedToken("agent", target);
    const slug = await createChannel(token);

    expect((await pause(slug, token, target)).status).toBe(200); // 开放式
    expect((await presenceOf(slug, token, target))?.resume_at).toBeUndefined();
    const later = Date.now() + 120_000;
    expect((await pause(slug, token, target, later)).status).toBe(200); // 再暂停，加定时
    const entry = await presenceOf(slug, token, target);
    expect(entry?.paused).toBe(true);
    expect(entry?.resume_at).toBe(later);
  });

  it("恢复一个未暂停的 agent：no-op，200，不报错", async () => {
    const { token } = await seedToken("agent");
    const target = uniq("noop-agent");
    await seedToken("agent", target);
    const slug = await createChannel(token);
    expect((await resume(slug, token, target)).status).toBe(200);
    expect((await presenceOf(slug, token, target))?.paused).toBeUndefined();
  });

  it("非 moderator 也不能恢复（resume 同样要 moderator）", async () => {
    const { token } = await seedToken("agent");
    const target = uniq("guarded-resume");
    await seedToken("agent", target);
    const slug = await createChannel(token);
    expect((await pause(slug, token, target)).status).toBe(200);
    const { token: scoped } = await seedToken("agent", uniq("scoped2"), { channelScope: slug });
    expect((await resume(slug, scoped, target)).status).toBe(403);
    // 仍暂停
    expect((await presenceOf(slug, token, target))?.paused).toBe(true);
  });
});
