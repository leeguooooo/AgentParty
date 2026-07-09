import { describe, expect, it } from "vitest";
import { api, createChannel, postMessage, seedToken, uniq } from "./helpers";

describe("channel squads", () => {
  it("creates, lists, updates, deletes, and validates task squad assignees", async () => {
    const owner = `owner-${uniq("squad")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner });
    const agentA = await seedToken("agent", uniq("agent-a"), { owner });
    const agentB = await seedToken("agent", uniq("agent-b"), { owner });
    const slug = await createChannel(human.token);

    const created = await api(`/api/channels/${slug}/squads`, human.token, {
      method: "POST",
      body: JSON.stringify({
        name: "frontend",
        title: "Frontend",
        leader: agentA.name,
        members: [agentA.name, agentB.name],
      }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      type: "squad",
      channel: slug,
      name: "frontend",
      title: "Frontend",
      leader: agentA.name,
      members: [agentA.name, agentB.name],
    });

    const listed = await api(`/api/channels/${slug}/squads`, human.token);
    expect(listed.status).toBe(200);
    expect((await listed.json()) as { squads: unknown[] }).toMatchObject({
      squads: [{ name: "frontend", members: [agentA.name, agentB.name] }],
    });

    const assigned = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({
        title: "Fix mobile layout",
        assignee: { name: "frontend", kind: "squad" },
      }),
    });
    expect(assigned.status).toBe(201);
    expect(await assigned.json()).toMatchObject({
      state: "assigned",
      assignee: { name: "frontend", kind: "squad" },
    });

    const missingSquad = await api(`/api/channels/${slug}/tasks`, human.token, {
      method: "POST",
      body: JSON.stringify({
        title: "Fix backend",
        assignee: { name: "backend", kind: "squad" },
      }),
    });
    expect(missingSquad.status).toBe(404);

    const mention = await postMessage(slug, human.token, "@frontend please take this");
    expect(mention.status).toBe(200);
    const history = await api(`/api/channels/${slug}/messages?since=0&limit=20`, human.token);
    expect(history.status).toBe(200);
    const messages = ((await history.json()) as { messages: { body: string; mentions: string[] }[] }).messages;
    const routed = messages.find((message) => message.body === "@frontend please take this");
    expect(routed?.mentions).toEqual(expect.arrayContaining(["frontend", agentA.name]));

    const updated = await api(`/api/channels/${slug}/squads/frontend`, human.token, {
      method: "PATCH",
      body: JSON.stringify({
        leader: agentB.name,
        members: [agentB.name],
        description: "Owns web UI polish",
      }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      leader: agentB.name,
      members: [agentB.name],
      description: "Owns web UI polish",
    });

    const deleted = await api(`/api/channels/${slug}/squads/frontend`, human.token, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ ok: true, squad: { name: "frontend" } });
    expect((await api(`/api/channels/${slug}/squads/frontend`, human.token)).status).toBe(404);
  });

  it("enforces channel access and readonly write restrictions", async () => {
    const owner = `owner-${uniq("squad-acl")}@example.com`;
    const outsider = `outsider-${uniq("squad-acl")}@example.com`;
    const human = await seedToken("human", uniq("human"), { owner });
    const readonly = await seedToken("readonly", uniq("ro"), { owner });
    const otherHuman = await seedToken("human", uniq("other"), { owner: outsider });
    const agent = await seedToken("agent", uniq("agent"), { owner });
    const slug = await createChannel(human.token);

    expect((await api(`/api/channels/${slug}/squads`, readonly.token, {
      method: "POST",
      body: JSON.stringify({ name: "qa", members: [agent.name] }),
    })).status).toBe(403);

    expect((await api(`/api/channels/${slug}/squads`, otherHuman.token)).status).toBe(403);
  });
});
