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
    expect(await json(initial)).toMatchObject({ charter: null, charter_rev: 0, updated_at: null, updated_by: null });

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
