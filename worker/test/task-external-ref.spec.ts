// #141 task external_ref 幂等键：同一 (channel, external_ref) 重复 create 不再重复建行。
// 同根因参照 #98（消息幂等键），这里是 task 面的复现。
import { describe, expect, it } from "vitest";
import { api, createChannel, seedToken, uniq } from "./helpers";

describe("channel task external_ref idempotency (#141)", () => {
  it("returns the existing task with 200 on a second create with the same external_ref (no duplicate row)", async () => {
    const human = await seedToken("human", uniq("human"));
    const slug = await createChannel(human.token);
    const ref = `gh:leeguooooo/agentparty#${uniq("ref")}`;

    const first = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "sync issue #96", external_ref: ref }),
    });
    expect(first.status).toBe(201);
    const firstTask = (await first.json()) as { id: number; external_ref: string | null };
    expect(firstTask.external_ref).toBe(ref);

    // 重跑同步：同一 external_ref 再 create 一次——不同 title，模拟重试请求体可能略有出入。
    const second = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "sync issue #96 (retry)", external_ref: ref }),
    });
    expect(second.status).toBe(200);
    const secondTask = (await second.json()) as { id: number; external_ref: string | null };
    expect(secondTask.id).toBe(firstTask.id);
    expect(secondTask.external_ref).toBe(ref);

    const listed = await api(`/api/channels/${slug}/tasks`, human.token);
    const tasks = ((await listed.json()) as { tasks: { id: number }[] }).tasks;
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.id).toBe(firstTask.id);
  });

  it("creates distinct tasks for distinct external_ref values", async () => {
    const human = await seedToken("human", uniq("human"));
    const slug = await createChannel(human.token);

    const a = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "issue A", external_ref: `gh:org/repo#${uniq("a")}` }),
    });
    const b = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "issue B", external_ref: `gh:org/repo#${uniq("b")}` }),
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const aId = ((await a.json()) as { id: number }).id;
    const bId = ((await b.json()) as { id: number }).id;
    expect(aId).not.toBe(bId);

    const listed = await api(`/api/channels/${slug}/tasks`, human.token);
    expect(((await listed.json()) as { tasks: { id: number }[] }).tasks.length).toBe(2);
  });

  it("does not falsely dedup tasks with absent/null external_ref (NULLs are distinct)", async () => {
    const human = await seedToken("human", uniq("human"));
    const slug = await createChannel(human.token);

    const a = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "no ref A" }),
    });
    const b = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "no ref B", external_ref: null }),
    });
    const c = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "no ref C" }),
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(c.status).toBe(201);
    const aTask = (await a.json()) as { id: number; external_ref: string | null };
    const bTask = (await b.json()) as { id: number; external_ref: string | null };
    const cTask = (await c.json()) as { id: number; external_ref: string | null };
    expect(aTask.external_ref).toBe(null);
    expect(bTask.external_ref).toBe(null);
    expect(cTask.external_ref).toBe(null);
    expect(new Set([aTask.id, bTask.id, cTask.id]).size).toBe(3);

    const listed = await api(`/api/channels/${slug}/tasks`, human.token);
    expect(((await listed.json()) as { tasks: { id: number }[] }).tasks.length).toBe(3);
  });

  it("scopes external_ref uniqueness per channel: same ref in two channels does not collide", async () => {
    const human = await seedToken("human", uniq("human"));
    const slugA = await createChannel(human.token);
    const slugB = await createChannel(human.token);
    const ref = `gh:leeguooooo/agentparty#${uniq("scoped")}`;

    const a = await api(`/api/channels/${slugA}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "A", external_ref: ref }),
    });
    const b = await api(`/api/channels/${slugB}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "B", external_ref: ref }),
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it("rejects invalid external_ref: empty string and over-length", async () => {
    const human = await seedToken("human", uniq("human"));
    const slug = await createChannel(human.token);

    const empty = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "bad", external_ref: "" }),
    });
    expect(empty.status).toBe(400);

    const tooLong = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "bad", external_ref: "x".repeat(600) }),
    });
    expect(tooLong.status).toBe(400);

    const wrongType = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "bad", external_ref: 5 }),
    });
    expect(wrongType.status).toBe(400);
  });
});
