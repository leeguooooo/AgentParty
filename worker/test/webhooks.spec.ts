import { env, fetchMock, runInDurableObject } from "cloudflare:test";
import { WEBHOOK_MAX_RETRIES } from "@agentparty/shared";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { api, createChannel, postMessage, seedToken, uniq } from "./helpers";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

interface CapturedRequest {
  headers: Record<string, string>;
  body: string;
}

// undici mock 回调里的 headers/body 形态因版本而异，统一归一化
function normalize(opts: { headers?: unknown; body?: unknown }): CapturedRequest {
  const headers: Record<string, string> = {};
  const h = opts.headers;
  if (Array.isArray(h)) {
    for (let i = 0; i + 1 < h.length; i += 2) headers[String(h[i]).toLowerCase()] = String(h[i + 1]);
  } else if (h && typeof h === "object") {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
      headers[k.toLowerCase()] = String(v);
    }
  }
  let body = "";
  if (typeof opts.body === "string") body = opts.body;
  else if (opts.body instanceof ArrayBuffer) body = new TextDecoder().decode(opts.body);
  else if (ArrayBuffer.isView(opts.body)) {
    body = new TextDecoder().decode(opts.body as Uint8Array);
  } else if (opts.body != null) body = String(opts.body);
  return { headers, body };
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sendMessage(slug: string, token: string, body: string, mentions: string[] = []) {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body, mentions, reply_to: null }),
  });
}

function addWebhook(
  slug: string,
  token: string,
  hook: { name: string; url: string; secret: string; filter?: string },
) {
  return api(`/api/channels/${slug}/webhooks`, token, {
    method: "POST",
    body: JSON.stringify(hook),
  });
}

async function queueRows(slug: string) {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_instance: ChannelDO, state) =>
    state.storage.sql
      .exec("SELECT webhook_name, attempts, next_retry_at FROM webhook_queue")
      .toArray()
      .map((r) => ({ webhook_name: String(r.webhook_name), attempts: Number(r.attempts) })),
  );
}

describe("webhooks", () => {
  it("registers, lists without leaking secret, deletes; readonly is rejected", async () => {
    const agent = await seedToken("agent");
    const ro = await seedToken("readonly");
    const slug = await createChannel(agent.token);

    const forbidden = await addWebhook(slug, ro.token, {
      name: "hermes",
      url: "https://hooks.test/wake",
      secret: "super-secret",
    });
    expect(forbidden.status).toBe(403);

    const bad = await addWebhook(slug, agent.token, {
      name: "hermes",
      url: "not-a-url",
      secret: "s",
    });
    expect(bad.status).toBe(400);
    const noSecret = await api(`/api/channels/${slug}/webhooks`, agent.token, {
      method: "POST",
      body: JSON.stringify({ name: "hermes", url: "https://hooks.test/wake" }),
    });
    expect(noSecret.status).toBe(400);
    const badFilter = await addWebhook(slug, agent.token, {
      name: "hermes",
      url: "https://hooks.test/wake",
      secret: "s",
      filter: "everything",
    });
    expect(badFilter.status).toBe(400);

    const created = await addWebhook(slug, agent.token, {
      name: "hermes",
      url: "https://hooks.test/wake",
      secret: "super-secret",
      filter: "mentions",
    });
    expect(created.status).toBe(201);

    const list = await api(`/api/channels/${slug}/webhooks`, agent.token);
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).not.toContain("super-secret");
    expect(text).not.toContain("secret");
    const { webhooks } = JSON.parse(text) as { webhooks: Record<string, unknown>[] };
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]).toMatchObject({ name: "hermes", url: "https://hooks.test/wake", filter: "mentions" });

    const roDelete = await api(`/api/channels/${slug}/webhooks/hermes`, ro.token, { method: "DELETE" });
    expect(roDelete.status).toBe(403);
    const del = await api(`/api/channels/${slug}/webhooks/hermes`, agent.token, { method: "DELETE" });
    expect(del.status).toBe(200);
    const again = await api(`/api/channels/${slug}/webhooks/hermes`, agent.token, { method: "DELETE" });
    expect(again.status).toBe(404);
    const empty = (await (await api(`/api/channels/${slug}/webhooks`, agent.token)).json()) as {
      webhooks: unknown[];
    };
    expect(empty.webhooks).toHaveLength(0);
  });

  it("mentions filter fires only when mentioned, with bearer auth and a valid hmac signature", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const secret = "hook-tok-1";
    expect(
      (await addWebhook(slug, token, { name: "hermes", url: "https://hooks.test/wake", secret })).status,
    ).toBe(201);

    // 未 @hermes：不投递（disableNetConnect 下若误投会入重试队列）
    expect((await sendMessage(slug, token, "no mention here")).status).toBe(200);
    expect(await queueRows(slug)).toHaveLength(0);

    let captured: CapturedRequest | null = null;
    fetchMock
      .get("https://hooks.test")
      .intercept({ path: "/wake", method: "POST" })
      .reply(200, (opts) => {
        captured = normalize(opts as { headers?: unknown; body?: unknown });
        return "ok";
      });

    expect((await sendMessage(slug, token, "@hermes wake up", ["hermes"])).status).toBe(200);
    expect(captured).not.toBeNull();
    const { headers, body } = captured as unknown as CapturedRequest;

    const payload = JSON.parse(body) as Record<string, unknown>;
    expect(payload).toMatchObject({
      type: "msg",
      kind: "message",
      body: "@hermes wake up",
      mentions: ["hermes"],
      channel: slug,
      permalink: `https://ap.test/c/${slug}`,
    });
    expect(typeof payload.seq).toBe("number");
    expect((payload.sender as { name: string }).name).toBeTruthy();

    expect(headers.authorization).toBe(`Bearer ${secret}`);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-agentparty-signature"]).toBe(`hmac-sha256=${await hmacHex(secret, body)}`);
    expect(await queueRows(slug)).toHaveLength(0);
  });

  it("filter all delivers messages without mentions", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    expect(
      (
        await addWebhook(slug, token, {
          name: uniq("hook"),
          url: "https://hooks.test/all",
          secret: "s",
          filter: "all",
        })
      ).status,
    ).toBe(201);

    let captured: CapturedRequest | null = null;
    fetchMock
      .get("https://hooks.test")
      .intercept({ path: "/all", method: "POST" })
      .reply(200, (opts) => {
        captured = normalize(opts as { headers?: unknown; body?: unknown });
        return "ok";
      });
    expect((await sendMessage(slug, token, "broadcast to all")).status).toBe(200);
    expect(captured).not.toBeNull();
    expect(
      (JSON.parse((captured as unknown as CapturedRequest).body) as { body: string }).body,
    ).toBe("broadcast to all");
  });

  it("failed delivery is queued and the alarm retry drains it on success", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    expect(
      (await addWebhook(slug, token, { name: "hermes", url: "https://down.test/wake", secret: "s" }))
        .status,
    ).toBe(201);

    // 没有 interceptor + disableNetConnect：立即投递失败 → 入队 attempts=1
    expect((await sendMessage(slug, token, "@hermes ping", ["hermes"])).status).toBe(200);
    let rows = await queueRows(slug);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ webhook_name: "hermes", attempts: 1 });

    // 到期后 alarm 重投成功 → 队列清空
    fetchMock.get("https://down.test").intercept({ path: "/wake", method: "POST" }).reply(200, "ok");
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      state.storage.sql.exec("UPDATE webhook_queue SET next_retry_at = ?", Date.now() - 1);
      await instance.onAlarm();
    });
    rows = await queueRows(slug);
    expect(rows).toHaveLength(0);
  });

  it("drops after 3 failed retries and posts a system status to the channel", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    expect(
      (await addWebhook(slug, token, { name: "hermes", url: "https://dead.test/wake", secret: "s" }))
        .status,
    ).toBe(201);
    expect((await sendMessage(slug, token, "@hermes ping", ["hermes"])).status).toBe(200);
    expect(await queueRows(slug)).toHaveLength(1);

    // 直接把 attempts 拨到最后一档，下一次失败即达到 3 次上限 → 丢弃 + system status
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      state.storage.sql.exec(
        "UPDATE webhook_queue SET attempts = ?, next_retry_at = ?",
        WEBHOOK_MAX_RETRIES,
        Date.now() - 1,
      );
      await instance.onAlarm();
    });
    expect(await queueRows(slug)).toHaveLength(0);

    const history = await api(`/api/channels/${slug}/messages`, token);
    const { messages } = (await history.json()) as {
      messages: {
        sender: { name: string; kind: string };
        kind: string;
        state: string | null;
        note: string | null;
      }[];
    };
    const status = messages.at(-1);
    expect(status).toMatchObject({
      sender: { name: "system", kind: "agent" },
      kind: "status",
      state: "blocked",
    });
    expect(status?.note).toContain("webhook hermes 连续投递失败");
  });
});
