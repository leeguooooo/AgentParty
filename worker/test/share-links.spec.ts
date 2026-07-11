// 观看模式邀请（#186）：房主自助铸「频道内只读分享 token」，生成 /c/<slug>?t=<token> 围观链接。
// 这是 web 观看模式邀请的后端原语——复用现成 readonly 角色（发送在所有 seam 已被硬挡），
// 不新造权限。与 join-links（参与模式，成员制）平行。
import { describe, expect, it } from "vitest";
import { api, postMessage, seedToken, uniq } from "./helpers";

async function makeChannel(token: string, visibility: "public" | "private" = "private"): Promise<string> {
  const slug = uniq("share");
  const res = await api("/api/channels", token, {
    method: "POST",
    body: JSON.stringify({ slug, kind: "standing", visibility }),
  });
  expect(res.status).toBe(201);
  return slug;
}

describe("share links (watch-mode invites)", () => {
  it("moderator mints a channel-scoped readonly watch token that can read but not send", async () => {
    const ownerAcct = `${uniq("owner")}@example.com`;
    const owner = await seedToken("human", uniq("owner"), { owner: ownerAcct });
    const slug = await makeChannel(owner.token);

    const created = await api(`/api/channels/${slug}/share-links`, owner.token, { method: "POST" });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { token: string; name: string; url: string; role: string; channel_scope: string };
    expect(body.token).toMatch(/^ap_[0-9a-f]{32}$/);
    expect(body.role).toBe("readonly");
    expect(body.channel_scope).toBe(slug);
    expect(body.url).toContain(`/c/${slug}?t=${body.token}`);

    // watch token reads the private channel
    expect((await api(`/api/channels/${slug}/messages`, body.token)).status).toBe(200);
    // watch token cannot send (readonly hard stop lives at the DO send seam)
    const send = await postMessage(slug, body.token, "hi from a watcher");
    expect(send.status).toBe(403);
    expect(((await send.json()) as { error: { message: string } }).error.message).toContain("readonly");
  });

  it("lists active watch links and lets the moderator revoke one", async () => {
    const ownerAcct = `${uniq("owner")}@example.com`;
    const owner = await seedToken("human", uniq("owner"), { owner: ownerAcct });
    const slug = await makeChannel(owner.token);

    const created = await api(`/api/channels/${slug}/share-links`, owner.token, { method: "POST" });
    expect(created.status).toBe(201);
    const { name, token: watchToken } = (await created.json()) as { name: string; token: string };

    const listed = await api(`/api/channels/${slug}/share-links`, owner.token);
    expect(listed.status).toBe(200);
    const links = ((await listed.json()) as { links: { name: string }[] }).links;
    expect(links.some((l) => l.name === name)).toBe(true);

    // revoke → the watch token stops reading
    const del = await api(`/api/channels/${slug}/share-links/${encodeURIComponent(name)}`, owner.token, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await api(`/api/channels/${slug}/messages`, watchToken)).status).toBe(401);
    const after = ((await (await api(`/api/channels/${slug}/share-links`, owner.token)).json()) as { links: { name: string }[] }).links;
    expect(after.some((l) => l.name === name)).toBe(false);
  });

  it("rejects non-moderators (readonly, outsiders) from minting or listing watch links", async () => {
    const ownerAcct = `${uniq("owner")}@example.com`;
    const owner = await seedToken("human", uniq("owner"), { owner: ownerAcct });
    const slug = await makeChannel(owner.token);

    const outsider = await seedToken("human", uniq("out"), { owner: `${uniq("out")}@example.com` });
    expect((await api(`/api/channels/${slug}/share-links`, outsider.token, { method: "POST" })).status).toBe(403);
    expect((await api(`/api/channels/${slug}/share-links`, outsider.token)).status).toBe(403);

    // a readonly caller is never a moderator
    const ro = await seedToken("readonly", uniq("ro"), { owner: ownerAcct, channelScope: slug });
    expect((await api(`/api/channels/${slug}/share-links`, ro.token, { method: "POST" })).status).toBe(403);
  });
});
