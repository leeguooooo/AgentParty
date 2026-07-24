// #422 频道级导出备份 + DO↔D1 对账。
// 导出：moderator-only，合并 D1（channels 行 + roles/tasks/members）与 DO 持久表为一份存档 JSON。
// 对账：只读比对双写字段，人造分裂（直接改 D1 archived_at）时检出「archived」divergence。
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, postMessage, seedToken, uniq } from "./helpers";

async function makeChannel(token: string): Promise<string> {
  const slug = uniq("bk");
  const res = await api("/api/channels", token, {
    method: "POST",
    body: JSON.stringify({ slug, kind: "standing", visibility: "private" }),
  });
  expect(res.status).toBe(201);
  return slug;
}

describe("channel export backup (#422)", () => {
  it("moderator exports a full channel backup with D1 rows and DO messages", async () => {
    const ownerAcct = `${uniq("owner")}@example.com`;
    const owner = await seedToken("human", uniq("owner"), { owner: ownerAcct });
    const slug = await makeChannel(owner.token);
    expect((await postMessage(slug, owner.token, "backup me")).status).toBe(200);

    const res = await api(`/api/channels/${slug}/export`, owner.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      backup_version: number;
      channel: { slug: string; visibility: string };
      d1: {
        channel_roles: unknown[];
        channel_tasks: unknown[];
        channel_members: unknown[];
        channel_decisions: unknown[];
        channel_decision_heads: unknown[];
      };
      durable_object: { tables: Record<string, { body: string }[]>; row_counts: Record<string, number> };
    };
    expect(body.backup_version).toBe(1);
    expect(body.channel.slug).toBe(slug);
    expect(body.channel.visibility).toBe("private");
    // D1 面存在（数组即可，roles/tasks/members 可空）
    expect(Array.isArray(body.d1.channel_roles)).toBe(true);
    expect(Array.isArray(body.d1.channel_tasks)).toBe(true);
    expect(Array.isArray(body.d1.channel_members)).toBe(true);
    expect(Array.isArray(body.d1.channel_decisions)).toBe(true);
    expect(Array.isArray(body.d1.channel_decision_heads)).toBe(true);
    // DO 面：messages 表含刚发的那条，且导出的是完整行（带 body），不是截断摘要
    const messages = body.durable_object.tables.messages;
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.some((m) => m.body === "backup me")).toBe(true);
    expect(body.durable_object.row_counts.messages).toBeGreaterThanOrEqual(1);
    // 瞬时运行期表被排除，不进备份
    expect(body.durable_object.tables.webhook_queue).toBeUndefined();
    expect(body.durable_object.tables.rate).toBeUndefined();
  });

  it("rejects non-moderators from exporting or reconciling", async () => {
    const ownerAcct = `${uniq("owner")}@example.com`;
    const owner = await seedToken("human", uniq("owner"), { owner: ownerAcct });
    const slug = await makeChannel(owner.token);

    const outsider = await seedToken("human", uniq("out"), { owner: `${uniq("out")}@example.com` });
    expect((await api(`/api/channels/${slug}/export`, outsider.token)).status).toBe(403);
    expect((await api(`/api/channels/${slug}/reconcile`, outsider.token)).status).toBe(403);

    // readonly watch token 亦非 moderator
    const ro = await seedToken("readonly", uniq("ro"), { owner: ownerAcct, channelScope: slug });
    expect((await api(`/api/channels/${slug}/export`, ro.token)).status).toBe(403);
    expect((await api(`/api/channels/${slug}/reconcile`, ro.token)).status).toBe(403);
  });
});

describe("channel reconcile DO/D1 (#422)", () => {
  it("reports a healthy channel as in sync", async () => {
    const ownerAcct = `${uniq("owner")}@example.com`;
    const owner = await seedToken("human", uniq("owner"), { owner: ownerAcct });
    const slug = await makeChannel(owner.token);
    await postMessage(slug, owner.token, "hi");

    const res = await api(`/api/channels/${slug}/reconcile`, owner.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; divergences: { field: string }[] };
    expect(body.ok).toBe(true);
    expect(body.divergences).toEqual([]);
  });

  it("detects a manufactured DO↔D1 split (D1 archived, DO not)", async () => {
    const ownerAcct = `${uniq("owner")}@example.com`;
    const owner = await seedToken("human", uniq("owner"), { owner: ownerAcct });
    const slug = await makeChannel(owner.token);

    // 直接改 D1 让它归档，但不走 archive 端点 → DO 侧 meta 仍非归档：制造双写分裂
    await env.DB.prepare("UPDATE channels SET archived_at = ? WHERE slug = ?").bind(Date.now(), slug).run();

    const res = await api(`/api/channels/${slug}/reconcile`, owner.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      divergences: { field: string; d1: unknown; durable_object: unknown }[];
    };
    expect(body.ok).toBe(false);
    const drift = body.divergences.find((d) => d.field === "archived");
    expect(drift).toBeDefined();
    expect(drift?.d1).toBe(true);
    expect(drift?.durable_object).toBe(false);
  });
});
