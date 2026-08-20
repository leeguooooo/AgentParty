import { describe, expect, it } from "vitest";
import { api, createChannel, seedToken, uniq, WsClient } from "./helpers";

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("channel charter", () => {
  it("lets readers fetch charter, moderators update it, revs list/welcome, and records status audit", async () => {
    const owner = await seedToken("agent", uniq("owner"), { owner: `${uniq("owner")}@example.com` });
    const slug = await createChannel(owner.token);

    const initial = await api(`/api/channels/${slug}/charter`, owner.token);
    expect(initial.status).toBe(200);
    expect(await json(initial)).toMatchObject({
      charter: null,
      charter_rev: 0,
      updated_at: null,
      updated_by: null,
      permissions: {
        charter_write: "moderators",
        charter_write_agents: "moderators",
        members_list: "members",
        members_list_agents: "members",
      },
    });

    const updated = await api(`/api/channels/${slug}/charter`, owner.token, {
      method: "PUT",
      body: JSON.stringify({ charter: "# Welcome\nRead this first." }),
    });
    expect(updated.status).toBe(200);
    expect(await json(updated)).toMatchObject({
      charter: "# Welcome\nRead this first.",
      charter_rev: 1,
      updated_by: owner.name,
    });

    const fetched = await json<{ charter: string; charter_rev: number }>(
      await api(`/api/channels/${slug}/charter`, owner.token),
    );
    expect(fetched).toMatchObject({ charter: "# Welcome\nRead this first.", charter_rev: 1 });

    const list = await json<{ channels: { slug: string; charter_rev: number }[] }>(
      await api("/api/channels", owner.token),
    );
    expect(list.channels.find((c) => c.slug === slug)?.charter_rev).toBe(1);

    const ws = await WsClient.open(slug, owner.token);
    expect(await ws.next()).toMatchObject({ type: "welcome", charter_rev: 1 });
    ws.close();

    const history = await json<{ messages: { kind: string; state: string | null; body: string }[] }>(
      await api(`/api/channels/${slug}/messages?since=0&limit=10`, owner.token),
    );
    expect(history.messages).toContainEqual(
      expect.objectContaining({
        kind: "status",
        state: "waiting",
        body: `charter updated to rev 1 by ${owner.name}`,
      }),
    );
  });

  it("enforces ACL: readonly/scoped guests cannot write, host soft-role agents can", async () => {
    const owner = await seedToken("agent", uniq("owner"), { owner: `${uniq("owner")}@example.com` });
    const slug = await createChannel(owner.token);
    const readonly = await seedToken("readonly", uniq("ro"), { owner: `${uniq("ro")}@example.com`, channelScope: slug });
    const guest = await seedToken("agent", uniq("guest"), { owner: `${uniq("guest")}@example.com`, channelScope: slug });
    const host = await seedToken("agent", uniq("host"), { owner: `${uniq("host")}@example.com`, channelScope: slug });

    expect((await api(`/api/channels/${slug}/charter`, readonly.token)).status).toBe(200);
    expect((await api(`/api/channels/${slug}/charter`, readonly.token, {
      method: "PUT",
      body: JSON.stringify({ charter: "readonly edit" }),
    })).status).toBe(403);
    expect((await api(`/api/channels/${slug}/charter`, guest.token, {
      method: "PUT",
      body: JSON.stringify({ charter: "guest edit" }),
    })).status).toBe(403);

    expect((await api(`/api/channels/${slug}/roles/${host.name}`, owner.token, {
      method: "PUT",
      body: JSON.stringify({ role: "host" }),
    })).status).toBe(200);
    const hostWrite = await api(`/api/channels/${slug}/charter`, host.token, {
      method: "PUT",
      body: JSON.stringify({ charter: "host maintained charter" }),
    });
    expect(hostWrite.status).toBe(200);
    expect(await json(hostWrite)).toMatchObject({ charter: "host maintained charter", charter_rev: 1, updated_by: host.name });
  });

  // #834 第 2 项：charter 权限死锁。isChannelModerator 对 channel_scope 非空的身份先于房主判定
  // 返回 false，于是持频道内 token 的人类房主在自己频道里写不了 charter——而 charter/决策账本正是
  // 结构化授权的唯一容器，写不进去就只剩消息正文里的散文断言（#834 第 1 项的直接成因）。
  it("#834: the human channel owner can write the charter even on a channel-scoped token", async () => {
    const ownerAccount = `${uniq("owner")}@example.com`;
    const owner = await seedToken("human", uniq("owner"), { owner: ownerAccount });
    const slug = await createChannel(owner.token);
    const ownerScoped = await seedToken("human", uniq("owner-scoped"), { owner: ownerAccount, channelScope: slug });

    const write = await api(`/api/channels/${slug}/charter`, ownerScoped.token, {
      method: "PUT",
      body: JSON.stringify({ charter: "# red lines\nno irreversible spend without a ledger credential" }),
    });
    expect(write.status).toBe(200);
    expect(await json(write)).toMatchObject({ charter_rev: 1, updated_by: ownerScoped.name });

    // 同一把钥匙也必须能往决策账本里写授权凭据，否则死锁只挪了个位置。
    const grant = await api(`/api/channels/${slug}/decisions`, ownerScoped.token, {
      method: "POST",
      body: JSON.stringify({ topic: "authz:spend diamonds", summary: "up to 500, this task only" }),
    });
    expect(grant.status).toBe(201);
    expect(await json(grant)).toMatchObject({ topic: "authz:spend diamonds", status: "active" });
    // 线上返回的字段名就是 `party authz check` 判定所依赖的那几个（topic/status/summary/id/
    // created_by）。这里逐个钉住，避免 CLI 侧只对着自己造的 mock 变绿、真机字段一改就静默失效。
    expect(await json(await api(`/api/channels/${slug}/charter`, ownerScoped.token))).toMatchObject({
      active_decisions: [
        expect.objectContaining({
          topic: "authz:spend diamonds",
          status: "active",
          summary: "up to 500, this task only",
          id: expect.stringMatching(/^decision_[a-f0-9]{32}$/u),
          created_by: ownerScoped.name,
          created_by_kind: "human",
        }),
      ],
    });
  });

  it("#834: the owner-scoped exemption does not leak to other principals", async () => {
    const ownerAccount = `${uniq("owner")}@example.com`;
    const otherAccount = `${uniq("other")}@example.com`;
    const owner = await seedToken("human", uniq("owner"), { owner: ownerAccount });
    const slug = await createChannel(owner.token);
    const otherSlug = await createChannel(owner.token);

    // ① 房主账号铸出来、但交给外部执行体用的 channel-scoped **agent** token：仍然不是房主。
    //    这是最危险的一条——放开它等于把房主权限白送给任何被邀请的 agent。
    const scopedAgent = await seedToken("agent", uniq("ext-agent"), { owner: ownerAccount, channelScope: slug });
    expect((await api(`/api/channels/${slug}/charter`, scopedAgent.token, {
      method: "PUT",
      body: JSON.stringify({ charter: "agent edit" }),
    })).status).toBe(403);
    expect((await api(`/api/channels/${slug}/decisions`, scopedAgent.token, {
      method: "POST",
      body: JSON.stringify({ topic: "authz:spend diamonds", summary: "self-granted" }),
    })).status).toBe(403);

    // ② 别的账号的人类，哪怕 scope 命中本频道：不是房主。
    const stranger = await seedToken("human", uniq("stranger"), { owner: otherAccount, channelScope: slug });
    expect((await api(`/api/channels/${slug}/charter`, stranger.token, {
      method: "PUT",
      body: JSON.stringify({ charter: "stranger edit" }),
    })).status).toBe(403);

    // ③ 房主本人，但 scope 锁在**另一个**频道：scope 是硬上限，跨频道一律不放行。
    const wrongScope = await seedToken("human", uniq("owner-elsewhere"), {
      owner: ownerAccount,
      channelScope: otherSlug,
    });
    expect((await api(`/api/channels/${slug}/charter`, wrongScope.token, {
      method: "PUT",
      body: JSON.stringify({ charter: "cross-channel edit" }),
    })).status).toBe(403);

    // ④ readonly 恒不可写，即使账号是房主。
    const readonlyOwner = await seedToken("readonly", uniq("ro-owner"), { owner: ownerAccount, channelScope: slug });
    expect((await api(`/api/channels/${slug}/charter`, readonlyOwner.token, {
      method: "PUT",
      body: JSON.stringify({ charter: "readonly owner edit" }),
    })).status).toBe(403);
  });

  it("configures charter write permissions separately for humans and agents", async () => {
    const owner = await seedToken("agent", uniq("owner"), { owner: `${uniq("owner")}@example.com` });
    const slug = await createChannel(owner.token);
    const memberAccount = `${uniq("member")}@example.com`;
    const member = await seedToken("human", uniq("human"), { owner: memberAccount });
    const host = await seedToken("agent", uniq("host"), { owner: `${uniq("host")}@example.com`, channelScope: slug });

    expect((await api(`/api/channels/${slug}/members/${encodeURIComponent(memberAccount)}`, owner.token, { method: "PUT" })).status).toBe(200);
    expect((await api(`/api/channels/${slug}/roles/${host.name}`, owner.token, {
      method: "PUT",
      body: JSON.stringify({ role: "host" }),
    })).status).toBe(200);

    expect((await api(`/api/channels/${slug}/charter`, member.token, {
      method: "PUT",
      body: JSON.stringify({ charter: "member before policy" }),
    })).status).toBe(403);
    expect((await api(`/api/channels/${slug}/charter`, host.token, {
      method: "PUT",
      body: JSON.stringify({ charter: "host before policy" }),
    })).status).toBe(200);

    const configured = await api(`/api/channels/${slug}/perms`, owner.token, {
      method: "PUT",
      body: JSON.stringify({
        charter_write: "members",
        charter_write_agents: "off",
      }),
    });
    expect(configured.status).toBe(200);
    expect(await json(configured)).toMatchObject({
      permissions: {
        charter_write: "members",
        charter_write_agents: "off",
      },
    });
    expect((await api(`/api/channels/${slug}/charter`, member.token, {
      method: "PUT",
      body: JSON.stringify({ charter: "human member edit" }),
    })).status).toBe(200);
    expect((await api(`/api/channels/${slug}/charter`, host.token, {
      method: "PUT",
      body: JSON.stringify({ charter: "host after off" }),
    })).status).toBe(403);

    expect((await api(`/api/channels/${slug}/perms`, owner.token, {
      method: "PUT",
      body: JSON.stringify({
        charter_write_agents: "allowlist",
        charter_write_agent_allowlist: [host.name],
      }),
    })).status).toBe(200);
    const allowlisted = await api(`/api/channels/${slug}/charter`, host.token, {
      method: "PUT",
      body: JSON.stringify({ charter: "allowlisted host edit" }),
    });
    expect(allowlisted.status).toBe(200);
  });

  it("configures member-list visibility separately for humans and agents", async () => {
    const ownerAccount = `${uniq("owner")}@example.com`;
    const owner = await seedToken("agent", uniq("owner"), { owner: ownerAccount });
    const ownerHuman = await seedToken("human", uniq("owner-human"), { owner: ownerAccount });
    const slug = await createChannel(owner.token);
    const memberAccount = `${uniq("member")}@example.com`;
    const member = await seedToken("human", uniq("human"), { owner: memberAccount });
    const memberAgent = await seedToken("agent", uniq("agent"), { owner: memberAccount, channelScope: slug });
    expect((await api(`/api/channels/${slug}/members/${encodeURIComponent(memberAccount)}`, owner.token, { method: "PUT" })).status).toBe(200);

    expect((await api(`/api/channels/${slug}/members`, member.token)).status).toBe(200);
    expect((await api(`/api/channels/${slug}/members`, memberAgent.token)).status).toBe(200);

    const moderatorsOnly = await api(`/api/channels/${slug}/perms`, owner.token, {
      method: "PUT",
      body: JSON.stringify({
        members_list: "moderators",
        members_list_agents: "off",
      }),
    });
    expect(moderatorsOnly.status).toBe(200);
    expect((await api(`/api/channels/${slug}/members`, member.token)).status).toBe(403);
    expect((await api(`/api/channels/${slug}/members`, memberAgent.token)).status).toBe(403);
    expect((await api(`/api/channels/${slug}/members`, owner.token)).status).toBe(403);
    expect((await api(`/api/channels/${slug}/members`, ownerHuman.token)).status).toBe(200);

    const allowlisted = await api(`/api/channels/${slug}/perms`, owner.token, {
      method: "PUT",
      body: JSON.stringify({
        members_list_agents: "allowlist",
        members_list_agent_allowlist: [memberAgent.name],
      }),
    });
    expect(allowlisted.status).toBe(200);
    expect((await api(`/api/channels/${slug}/members`, memberAgent.token)).status).toBe(200);
  });

  it("rejects oversized charters and expected_rev conflicts", async () => {
    const owner = await seedToken("agent", uniq("owner"), { owner: `${uniq("owner")}@example.com` });
    const slug = await createChannel(owner.token);

    const tooLarge = await api(`/api/channels/${slug}/charter`, owner.token, {
      method: "PUT",
      body: JSON.stringify({ charter: "x".repeat(16_001) }),
    });
    expect(tooLarge.status).toBe(413);
    expect(await json(tooLarge)).toMatchObject({ error: { code: "too_large" } });

    expect((await api(`/api/channels/${slug}/charter`, owner.token, {
      method: "PUT",
      body: JSON.stringify({ charter: "rev one", expected_rev: 0 }),
    })).status).toBe(200);
    const conflict = await api(`/api/channels/${slug}/charter`, owner.token, {
      method: "PUT",
      body: JSON.stringify({ charter: "stale", expected_rev: 0 }),
    });
    expect(conflict.status).toBe(409);
    expect(await json(conflict)).toMatchObject({ error: { code: "conflict" } });
  });
});
