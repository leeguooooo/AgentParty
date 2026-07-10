import { describe, expect, it } from "vitest";
import { api, createChannel, seedToken, uniq } from "./helpers";

describe("channel task ledger", () => {
  it("creates, lists, filters, and updates channel-scoped tasks", async () => {
    const owner = `owner-${uniq("task")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner });
    const agent = await seedToken("agent", uniq("agent"), { owner });
    const slug = await createChannel(human.token);

    const fromAgent = await api(`/api/channels/${slug}/tasks`, agent.token, {
      method: "POST",
      body: JSON.stringify({
        title: "Investigate broken login",
        labels: ["bug", "frontend"],
        anchor_seqs: [1, 2],
        priority: 3,
      }),
    });
    expect(fromAgent.status).toBe(201);
    const agentTask = (await fromAgent.json()) as { id: number; state: string; labels: string[]; anchor_seqs: number[]; priority: number };
    expect(agentTask).toMatchObject({
      type: "task",
      channel: slug,
      state: "triage",
      labels: ["bug", "frontend"],
      anchor_seqs: [1, 2],
      priority: 3,
    });

    const fromHuman = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({
        title: "Ship docs",
        assignee: { name: agent.name, kind: "agent" },
      }),
    });
    expect(fromHuman.status).toBe(201);
    const humanTask = (await fromHuman.json()) as { id: number; state: string; assignee: { name: string; kind: string } };
    expect(humanTask).toMatchObject({
      state: "assigned",
      assignee: { name: agent.name, kind: "agent" },
    });

    const listed = await api(`/api/channels/${slug}/tasks`, human.token);
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { tasks: { id: number }[] };
    expect(listedBody.tasks.map((task) => task.id).sort((a, b) => a - b)).toEqual([agentTask.id, humanTask.id].sort((a, b) => a - b));

    const triage = await api(`/api/channels/${slug}/tasks?state=triage`, human.token);
    expect(triage.status).toBe(200);
    expect(((await triage.json()) as { tasks: { id: number }[] }).tasks.map((task) => task.id)).toEqual([agentTask.id]);

    const patched = await api(`/api/channels/${slug}/tasks/${agentTask.id}`, human.token, {
      method: "PATCH",
      body: JSON.stringify({
        state: "in_progress",
        assignee: { name: agent.name, kind: "agent" },
      }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      id: agentTask.id,
      state: "in_progress",
      assignee: { name: agent.name, kind: "agent" },
    });

    const summary = await api(`/api/channels/${slug}/tasks/summary`, agent.token);
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({
      type: "task_summary",
      channel: slug,
      total: 2,
      open: 2,
      assigned: 1,
      in_progress: 1,
      done: 0,
      mine: 2,
    });
  });

  it("enforces channel access and readonly write restrictions", async () => {
    const owner = `owner-${uniq("task-acl")}@example.com`;
    const outsider = `outsider-${uniq("task-acl")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner });
    const readonly = await seedToken("readonly", uniq("ro"), { owner });
    const otherHuman = await seedToken("human", uniq("other"), { owner: outsider });
    const slug = await createChannel(human.token);

    expect((await api(`/api/channels/${slug}/tasks`, readonly.token, {
      method: "POST",
      body: JSON.stringify({ title: "read only cannot write" }),
    })).status).toBe(403);

    expect((await api(`/api/channels/${slug}/tasks`, otherHuman.token)).status).toBe(403);
  });

  it("round-trips scope and blocked_reason; enforces scope/blocked_reason validation (#204)", async () => {
    const owner = `owner-${uniq("scope")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner });
    const agent = await seedToken("agent", uniq("agent"), { owner });
    const slug = await createChannel(human.token);

    // create 带 scope（含重复项，服务端去重）+ blocked_reason
    const created = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({
        title: "scoped task",
        assignee: { name: agent.name, kind: "agent" },
        scope: ["web/src", "cli/src", "web/src"],
        blocked_reason: "waiting on token",
      }),
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: number; scope: string[]; blocked_reason: string | null };
    expect(task.scope).toEqual(["web/src", "cli/src"]);
    expect(task.blocked_reason).toBe("waiting on token");

    // GET 单条往返一致
    const got = await api(`/api/channels/${slug}/tasks/${task.id}`, human.token);
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ scope: ["web/src", "cli/src"], blocked_reason: "waiting on token" });

    // 列表也带出 scope/blocked_reason
    const listed = await api(`/api/channels/${slug}/tasks`, human.token);
    const listedTask = ((await listed.json()) as { tasks: Array<{ id: number; scope: string[]; blocked_reason: string | null }> }).tasks.find((t) => t.id === task.id)!;
    expect(listedTask.scope).toEqual(["web/src", "cli/src"]);
    expect(listedTask.blocked_reason).toBe("waiting on token");

    // PATCH 改 scope、清空 blocked_reason（null）
    const patched = await api(`/api/channels/${slug}/tasks/${task.id}`, human.token, {
      method: "PATCH",
      body: JSON.stringify({ scope: ["worker/src"], blocked_reason: null }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ scope: ["worker/src"], blocked_reason: null });

    // PATCH 不带 scope → 保留原 scope（不被清空）
    const patched2 = await api(`/api/channels/${slug}/tasks/${task.id}`, human.token, {
      method: "PATCH",
      body: JSON.stringify({ state: "in_progress" }),
    });
    expect(await patched2.json()).toMatchObject({ scope: ["worker/src"] });

    // 非法 scope：含非字符串项 → 400
    expect((await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "bad", scope: [123] }),
    })).status).toBe(400);

    // 非法 scope：空字符串项 → 400
    expect((await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "bad", scope: [""] }),
    })).status).toBe(400);

    // 非法 blocked_reason：类型错误 → 400
    expect((await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "bad", blocked_reason: 5 }),
    })).status).toBe(400);

    // 省略时默认 scope=[]、blocked_reason=null
    const plain = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({ title: "plain" }),
    });
    expect(plain.status).toBe(201);
    expect(await plain.json()).toMatchObject({ scope: [], blocked_reason: null });
  });

});
