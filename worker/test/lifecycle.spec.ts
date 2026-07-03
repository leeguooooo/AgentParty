import { LOOP_GUARD_N } from "@agentparty/shared";
import { describe, expect, it } from "vitest";
import { api, createChannel, postMessage, seedToken, WsClient } from "./helpers";

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
}

describe("channel lifecycle endpoints", () => {
  it("archive endpoint archives, kicks live ws, is idempotent", async () => {
    const { token } = await seedToken("human");
    const slug = await createChannel(token);
    expect((await postMessage(slug, token, "before")).status).toBe(200);

    const ws = await WsClient.open(slug, token);
    await ws.nextOfType("welcome");

    const res = await api(`/api/channels/${slug}/archive`, token, { method: "POST" });
    expect(res.status).toBe(200);

    // 存活连接收到 error:archived 后被关闭
    const err = await ws.nextOfType("error");
    expect(err.code).toBe("archived");

    const rejected = await postMessage(slug, token, "after");
    expect(rejected.status).toBe(410);
    expect(await errorCode(rejected)).toBe("archived");

    // 归档后仍可回看
    const history = await api(`/api/channels/${slug}/messages`, token);
    expect(history.status).toBe(200);

    // 幂等
    const again = await api(`/api/channels/${slug}/archive`, token, { method: "POST" });
    expect(again.status).toBe(200);
  });

  it("archive rejects readonly and unknown slug", async () => {
    const agent = await seedToken("agent");
    const ro = await seedToken("readonly");
    const slug = await createChannel(agent.token);
    const forbidden = await api(`/api/channels/${slug}/archive`, ro.token, { method: "POST" });
    expect(forbidden.status).toBe(403);
    const missing = await api("/api/channels/no-such-channel/archive", agent.token, { method: "POST" });
    expect(missing.status).toBe(404);
  });

  it("reset-guard clears a tripped loop guard", async () => {
    const agentA = await seedToken("agent");
    const agentB = await seedToken("agent");
    const slug = await createChannel(agentA.token);
    for (let i = 0; i < LOOP_GUARD_N; i++) {
      const res = await postMessage(slug, i % 2 === 0 ? agentA.token : agentB.token, `m${i}`);
      expect(res.status).toBe(200);
    }
    const blocked = await postMessage(slug, agentA.token, "blocked");
    expect(blocked.status).toBe(409);

    const reset = await api(`/api/channels/${slug}/reset-guard`, agentA.token, { method: "POST" });
    expect(reset.status).toBe(200);

    const resumed = await postMessage(slug, agentB.token, "resumed");
    expect(resumed.status).toBe(200);
  }, 30_000);
});
