import type { PresenceEntry } from "@agentparty/shared";
import { describe, expect, it } from "vitest";
import { WsClient, api, createChannel, seedToken } from "./helpers";

async function fetchPresence(slug: string, token: string): Promise<PresenceEntry[]> {
  const res = await api(`/api/channels/${slug}/presence`, token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { presence: PresenceEntry[] }).presence;
}

async function sendStatus(ws: WsClient, frame: Record<string, unknown>): Promise<void> {
  ws.send({ type: "send", kind: "status", state: "working", note: "n", mentions: [], ...frame });
  await ws.nextOfType("sent");
  await ws.nextOfType("status");
}

describe("presence busy + queue depth (issue #103)", () => {
  it("reflects busy=true and queue_depth from a status frame in the presence snapshot", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "hello", since: 0 });

    await sendStatus(ws, { state: "working", busy: true, queue_depth: 3 });

    const entry = (await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name);
    expect(entry).toMatchObject({ busy: true, queue_depth: 3 });
    ws.close();
  });

  it("clears busy when a later status omits it (serve goes idle)", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "hello", since: 0 });

    await sendStatus(ws, { state: "working", busy: true, queue_depth: 2 });
    await sendStatus(ws, { state: "waiting", busy: false });

    const entry = (await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name);
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("busy");
    expect(entry).not.toHaveProperty("queue_depth");
    ws.close();
  });

  it("omits busy/queue_depth entirely for a plain status (backward compatible)", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "hello", since: 0 });

    await sendStatus(ws, { state: "working" });

    const entry = (await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name);
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("busy");
    expect(entry).not.toHaveProperty("queue_depth");
    ws.close();
  });

  it("broadcasts busy on the presence frame to other readers", async () => {
    const agent = await seedToken("agent");
    const observer = await seedToken("human");
    const slug = await createChannel(agent.token);
    const watcher = await WsClient.open(slug, observer.token);
    await watcher.nextOfType("welcome");

    const ws = await WsClient.open(slug, agent.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "hello", since: 0 });
    ws.send({ type: "send", kind: "status", state: "working", note: "busy", mentions: [], busy: true, queue_depth: 5 });

    for (;;) {
      const frame = await watcher.nextOfType("presence");
      if (frame.name === agent.name && frame.state === "working") {
        expect(frame).toMatchObject({ busy: true, queue_depth: 5 });
        break;
      }
    }
    ws.close();
    watcher.close();
  });

  it("rejects a malformed queue_depth (negative / non-integer)", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "hello", since: 0 });

    ws.send({ type: "send", kind: "status", state: "working", note: "bad", mentions: [], queue_depth: -1 });
    const err = await ws.nextOfType("error");
    expect(err.code).toBe("bad_request");
    ws.close();
  });
});
