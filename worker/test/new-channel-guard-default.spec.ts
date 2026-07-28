import { describe, expect, it } from "vitest";
import { api, createChannel, postMessage, seedToken, uniq } from "./helpers";

describe("new channels keep optional guards off by default", () => {
  it("a freshly created channel reports both guards disabled", async () => {
    const human = await seedToken("human", uniq("human"));
    const slug = await createChannel(human.token);

    const list = (await (await api("/api/channels", human.token)).json()) as {
      channels: {
        slug: string;
        loop_guard_enabled?: number;
        loop_guard_limit?: number | null;
        workflow_guard_enabled?: number;
      }[];
    };
    const ch = list.channels.find((c) => c.slug === slug);
    expect(ch).toBeDefined();
    expect(ch?.loop_guard_enabled).toBe(0);
    expect(ch?.workflow_guard_enabled).toBe(0);
    expect(ch?.loop_guard_limit ?? null).toBeNull();
  });

  it("the loop guard still works after an owner explicitly enables it", async () => {
    const agentA = await seedToken("agent", uniq("ga"));
    const agentB = await seedToken("agent", uniq("gb"));
    const slug = await createChannel(agentA.token);
    const enable = await api(`/api/channels/${slug}/loop-guard`, agentA.token, {
      method: "PUT",
      body: JSON.stringify({ enabled: true, limit: 30 }),
    });
    expect(enable.status).toBe(200);

    // LOOP_GUARD_N = 30：前 30 条连续 agent 消息放行，第 31 条熔断
    for (let i = 0; i < 30; i++) {
      const token = i % 2 === 0 ? agentA.token : agentB.token;
      expect((await postMessage(slug, token, `msg-${i}`)).status).toBe(200);
    }
    const tripped = await postMessage(slug, agentA.token, "one too many");
    expect(tripped.status).toBe(409);
    const body = (await tripped.json()) as { error: { code: string } };
    expect(body.error.code).toBe("loop_guard");
  });

  it("status frames do not consume the message loop-guard quota (#466)", async () => {
    const agentA = await seedToken("agent", uniq("sa"));
    const agentB = await seedToken("agent", uniq("sb"));
    const slug = await createChannel(agentA.token);
    const enable = await api(`/api/channels/${slug}/loop-guard`, agentA.token, {
      method: "PUT",
      body: JSON.stringify({ enabled: true, limit: 30 }),
    });
    expect(enable.status).toBe(200);

    // status 是 presence 协调信息：即使达到消息阈值数量，也不应消耗熔断额度。
    for (let i = 0; i < 30; i++) {
      const token = i % 2 === 0 ? agentA.token : agentB.token;
      const res = await api(`/api/channels/${slug}/messages`, token, {
        method: "POST",
        body: JSON.stringify({ kind: "status", state: "blocked", note: `streak ${i}`, mentions: [] }),
      });
      expect(res.status).toBe(200);
    }
    expect((await postMessage(slug, agentA.token, "first real message")).status).toBe(200);

    // 只有真实 agent message 会累计：再发送 29 条后，第 31 条 message 才熔断。
    for (let i = 1; i < 30; i++) {
      const token = i % 2 === 0 ? agentA.token : agentB.token;
      expect((await postMessage(slug, token, `msg-${i}`)).status).toBe(200);
    }
    const tripped = await postMessage(slug, agentA.token, "one message too many");
    expect(tripped.status).toBe(409);
    expect(((await tripped.json()) as { error: { code: string } }).error.code).toBe("loop_guard");
  });

  it("owners can keep an already disabled guard off", async () => {
    const human = await seedToken("human", uniq("human"));
    const slug = await createChannel(human.token);

    const off = await api(`/api/channels/${slug}/loop-guard`, human.token, {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ enabled: false, limit: null });
  });
});
