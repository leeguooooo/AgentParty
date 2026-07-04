import { env, fetchMock, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { api, createChannel, postMessage, seedToken } from "./helpers";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

// 带自定义头做 ws 升级，读第一帧
async function openRaw(
  slug: string,
  token: string,
  extra: Record<string, string>,
): Promise<{ ws: WebSocket; first: Record<string, unknown> }> {
  const res = await SELF.fetch(`http://ap.test/api/channels/${slug}/ws`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${token}`, ...extra },
  });
  if (res.status !== 101 || !res.webSocket) throw new Error(`ws upgrade failed: ${res.status}`);
  const ws = res.webSocket;
  ws.accept();
  const first = await new Promise<Record<string, unknown>>((resolve) => {
    ws.addEventListener("message", (e) => resolve(JSON.parse(e.data as string)), { once: true });
  });
  return { ws, first };
}

async function nextRawFrame(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
  for (;;) {
    const frame = await new Promise<Record<string, unknown>>((resolve) => {
      ws.addEventListener("message", (e) => resolve(JSON.parse(e.data as string)), { once: true });
    });
    if (frame.type === type) return frame;
  }
}

describe("ws upgrade header injection", () => {
  // 修复 2①：客户端伪造 x-ap-archived:1 连未归档频道，不得归档活频道
  it("ignores a client-injected x-ap-archived header on an active channel", async () => {
    const human = await seedToken("human");
    const ro = await seedToken("readonly");
    const slug = await createChannel(human.token);

    const { ws, first } = await openRaw(slug, ro.token, { "x-ap-archived": "1" });
    // 被剥离后连接正常握手，而非 error:archived
    expect(first.type).toBe("welcome");
    ws.close();

    // 频道未被归档：合法写入仍 200，D1 未标归档
    const send = await postMessage(slug, human.token, "still active");
    expect(send.status).toBe(200);
    const row = await env.DB.prepare("SELECT archived_at FROM channels WHERE slug = ?")
      .bind(slug)
      .first<{ archived_at: number | null }>();
    expect(row?.archived_at).toBeNull();

    // 归档仍能正常回看
    const history = await api(`/api/channels/${slug}/messages`, human.token);
    expect(history.status).toBe(200);
  });

  // 修复 2②：客户端伪造 x-ap-host 不得污染 webhook permalink
  it("ignores a client-injected x-ap-host header in the webhook permalink", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    expect(
      (
        await api(`/api/channels/${slug}/webhooks`, agent.token, {
          method: "POST",
          body: JSON.stringify({
            name: "hook",
            url: "https://hooks.test/wake",
            secret: "s",
            filter: "all",
          }),
        })
      ).status,
    ).toBe(201);

    let captured = "";
    fetchMock
      .get("https://hooks.test")
      .intercept({ path: "/wake", method: "POST" })
      .reply(200, (opts) => {
        captured = typeof opts.body === "string" ? opts.body : String(opts.body);
        return "ok";
      });

    const { ws, first } = await openRaw(slug, agent.token, { "x-ap-host": "evil.example" });
    expect(first.type).toBe("welcome");
    ws.send(JSON.stringify({ type: "send", kind: "message", body: "hi", mentions: [], reply_to: null }));
    await new Promise((r) => setTimeout(r, 300));
    ws.close();

    expect(captured).not.toBe("");
    const payload = JSON.parse(captured) as { permalink: string };
    expect(payload.permalink).not.toContain("evil.example");
    expect(payload.permalink).toBe(`https://ap.test/c/${slug}`);
  });

  it("ignores client-injected collaboration role headers", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);

    const { ws, first } = await openRaw(slug, agent.token, {
      "x-ap-collab-role": "host",
      "x-ap-role-source": "assigned",
    });
    expect(first.type).toBe("welcome");

    ws.send(JSON.stringify({ type: "send", kind: "status", state: "working", note: "forged host", mentions: [] }));
    const status = await nextRawFrame(ws, "status");
    ws.close();

    expect(status).toMatchObject({ type: "status", kind: "status", note: "forged host" });
    expect(status.role).toBeUndefined();
    expect(status.role_source).toBeUndefined();
  });
});
