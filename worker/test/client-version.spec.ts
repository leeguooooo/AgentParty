import type { PresenceEntry } from "@agentparty/shared";
import { describe, expect, it } from "vitest";
import { WsClient, api, createChannel, seedToken } from "./helpers";

async function fetchPresence(slug: string, token: string): Promise<PresenceEntry[]> {
  const res = await api(`/api/channels/${slug}/presence`, token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { presence: PresenceEntry[] }).presence;
}

async function sendStatus(ws: WsClient, note: string): Promise<void> {
  ws.send({ type: "send", kind: "status", state: "working", note });
  await ws.nextOfType("sent");
  await ws.nextOfType("status");
}

describe("CLI client version presence (issue #192)", () => {
  it("keeps legacy hello without a version backward compatible", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await ws.nextOfType("welcome");

    ws.send({ type: "hello", since: 0 });
    await sendStatus(ws, "legacy client");

    const entry = (await fetchPresence(slug, agent.token)).find((item) => item.name === agent.name);
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("client_version");
    ws.close();
  });

  it("accepts the 64-character boundary and ignores malformed or overlong versions", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await ws.nextOfType("welcome");
    const maxVersion = `1.0.0-${"a".repeat(58)}`;
    expect(maxVersion).toHaveLength(64);

    ws.send({ type: "hello", since: 0, client_version: maxVersion });
    await sendStatus(ws, "version boundary");
    expect((await fetchPresence(slug, agent.token)).find((item) => item.name === agent.name)).toMatchObject({
      client_version: maxVersion,
    });

    for (const client_version of ["", " 1.2.3", "1.2.3\n", "1/2/3", "x".repeat(65), 123]) {
      ws.send({ type: "hello", since: 0, client_version });
      await sendStatus(ws, `invalid ${String(client_version).slice(0, 8)}`);
    }
    expect((await fetchPresence(slug, agent.token)).find((item) => item.name === agent.name)).toMatchObject({
      client_version: maxVersion,
    });
    ws.close();
  });

  it("broadcasts, serializes, and updates the version when the same identity reconnects", async () => {
    const agent = await seedToken("agent");
    const observer = await seedToken("human");
    const slug = await createChannel(agent.token);
    const watcher = await WsClient.open(slug, observer.token);
    await watcher.nextOfType("welcome");

    const first = await WsClient.open(slug, agent.token);
    await first.nextOfType("welcome");
    first.send({ type: "hello", since: 0, client_version: "0.2.89" });
    expect(await watcher.nextOfType("presence")).toMatchObject({
      name: agent.name,
      client_version: "0.2.89",
    });
    first.close();
    for (;;) {
      const frame = await watcher.nextOfType("presence");
      if (frame.name === agent.name && frame.state === "offline") break;
    }

    const second = await WsClient.open(slug, agent.token);
    await second.nextOfType("welcome");
    second.send({ type: "hello", since: 0, client_version: "0.2.90-beta.1" });
    expect(await watcher.nextOfType("presence")).toMatchObject({
      name: agent.name,
      client_version: "0.2.90-beta.1",
    });

    const restEntry = (await fetchPresence(slug, agent.token)).find((item) => item.name === agent.name);
    expect(restEntry).toMatchObject({ client_version: "0.2.90-beta.1" });

    const reader = await WsClient.open(slug, observer.token);
    const welcome = await reader.nextOfType("welcome");
    expect(welcome.presence).toContainEqual(
      expect.objectContaining({ name: agent.name, client_version: "0.2.90-beta.1" }),
    );

    reader.close();
    second.close();
    watcher.close();
  });
});
