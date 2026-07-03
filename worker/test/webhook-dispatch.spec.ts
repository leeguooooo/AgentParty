import { WEBHOOK_TIMEOUT_MS } from "@agentparty/shared";
import { fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { api, createChannel, seedToken, uniq } from "./helpers";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

function sendMessage(slug: string, token: string, body: string) {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body, mentions: [], reply_to: null }),
  });
}

function addWebhook(slug: string, token: string, name: string, url: string) {
  return api(`/api/channels/${slug}/webhooks`, token, {
    method: "POST",
    body: JSON.stringify({ name, url, secret: "s", filter: "all" }),
  });
}

describe("webhook dispatch is off the send path", () => {
  // 修复 3：坏/慢端点不得同步阻塞发送。首投走 waitUntil，send 立即返回 seq。
  it("returns seq well under the webhook timeout even with a slow endpoint", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    expect((await addWebhook(slug, token, uniq("slow"), "https://slow.test/hook")).status).toBe(201);

    // 端点拖到 3s 才回；旧实现会同步 await，send 至少阻塞 3s
    fetchMock
      .get("https://slow.test")
      .intercept({ path: "/hook", method: "POST" })
      .reply(200, "ok")
      .delay(3_000);

    const start = Date.now();
    const res = await sendMessage(slug, token, "hi");
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect((await res.json()) as { seq: number }).toMatchObject({ seq: 1 });
    // 远小于 10s 的 webhook 超时，也远小于端点 3s 延迟
    expect(elapsed).toBeLessThan(1_500);
    expect(elapsed).toBeLessThan(WEBHOOK_TIMEOUT_MS);

    // 让后台 waitUntil 投递把 mock 消费掉，afterEach 才不报未消费 interceptor
    await new Promise((r) => setTimeout(r, 3_200));
  });
});
