import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { WsClient, api, createChannel, postMessage, seedToken } from "./helpers";

interface MsgLike {
  seq: number;
  sender: { name: string; kind: string };
  kind: string;
  body: string;
}

describe("history rest", () => {
  it("returns messages after since, ordered, with limit", async () => {
    const { token, name } = await seedToken("agent");
    const slug = await createChannel(token);
    for (let i = 1; i <= 3; i++) {
      const res = await postMessage(slug, token, `m${i}`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { seq: number }).seq).toBe(i);
    }

    const all = await api(`/api/channels/${slug}/messages?since=0`, token);
    expect(all.status).toBe(200);
    const { messages } = (await all.json()) as { messages: MsgLike[] };
    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(messages[0]).toMatchObject({
      kind: "message",
      body: "m1",
      sender: { name, kind: "agent" },
    });

    const tail = await api(`/api/channels/${slug}/messages?since=2`, token);
    const tailBody = (await tail.json()) as { messages: MsgLike[] };
    expect(tailBody.messages.map((m) => m.seq)).toEqual([3]);

    const limited = await api(`/api/channels/${slug}/messages?since=0&limit=1`, token);
    const limitedBody = (await limited.json()) as { messages: MsgLike[] };
    expect(limitedBody.messages.map((m) => m.seq)).toEqual([1]);
  });

  it("404 on unknown channel", async () => {
    const { token } = await seedToken("agent");
    const res = await api("/api/channels/no-such-channel/messages", token);
    expect(res.status).toBe(404);
  });

  it("archived channel rejects sends over rest and ws", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    expect((await postMessage(slug, token, "before archive")).status).toBe(200);
    await env.DB.prepare("UPDATE channels SET archived_at = ? WHERE slug = ?")
      .bind(Date.now(), slug)
      .run();

    const rest = await postMessage(slug, token, "after archive");
    expect(rest.status).toBe(410);
    expect(((await rest.json()) as { error: { code: string } }).error.code).toBe("archived");

    const ws = await WsClient.open(slug, token);
    const err = await ws.nextOfType("error");
    expect(err.code).toBe("archived");

    // 归档后仍可回看历史
    const history = await api(`/api/channels/${slug}/messages`, token);
    expect(history.status).toBe(200);
    const { messages } = (await history.json()) as { messages: MsgLike[] };
    expect(messages).toHaveLength(1);
  });
});
