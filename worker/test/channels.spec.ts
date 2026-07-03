import { describe, expect, it } from "vitest";
import { api, seedToken, uniq } from "./helpers";

describe("channels", () => {
  it("creates and lists a channel", async () => {
    const { token } = await seedToken("agent");
    const slug = uniq("ch");
    const res = await api("/api/channels", token, {
      method: "POST",
      body: JSON.stringify({ slug, title: "joint debug", kind: "temp" }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ slug, title: "joint debug", kind: "temp" });

    const list = await api("/api/channels", token);
    expect(list.status).toBe(200);
    const { channels } = (await list.json()) as {
      channels: { slug: string; kind: string; archived_at: number | null }[];
    };
    const found = channels.find((c) => c.slug === slug);
    expect(found).toMatchObject({ slug, kind: "temp", archived_at: null });
  });

  it("409 on slug conflict", async () => {
    const { token } = await seedToken("agent");
    const slug = uniq("ch");
    const create = () =>
      api("/api/channels", token, { method: "POST", body: JSON.stringify({ slug, kind: "standing" }) });
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(409);
  });

  it("400 on invalid slug or kind", async () => {
    const { token } = await seedToken("agent");
    const bad = await api("/api/channels", token, {
      method: "POST",
      body: JSON.stringify({ slug: "Bad Slug!", kind: "standing" }),
    });
    expect(bad.status).toBe(400);
    const badKind = await api("/api/channels", token, {
      method: "POST",
      body: JSON.stringify({ slug: uniq("ch"), kind: "forever" }),
    });
    expect(badKind.status).toBe(400);
  });

  it("401 without a token", async () => {
    const res = await api("/api/channels", "");
    expect(res.status).toBe(401);
  });
});
