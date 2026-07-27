import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { ChannelDO } from "../src/do";
import {
  api,
  completeCapabilityHello,
  createChannel,
  postMessage,
  seedToken,
  uniq,
  WsClient,
} from "./helpers";

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("participant authority WebSocket hot path", () => {
  it("scopes token authority queries to identities attached to this ChannelDO", async () => {
    const participant = await seedToken("agent", uniq("resident"), {
      owner: `${uniq("account")}@example.com`,
    });
    const slug = await createChannel(participant.token);
    const originalPrepare = env.DB.prepare.bind(env.DB);
    const authorityQueries: string[] = [];
    const ownershipQueries: string[] = [];
    const ownershipBindings: unknown[][] = [];
    const prepare = vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
      if (query.includes("SELECT name, owner, hash") && query.includes("FROM tokens")) {
        authorityQueries.push(query);
      }
      const statement = originalPrepare(query);
      if (
        query.includes("SELECT participant_name AS name, account") &&
        query.includes("FROM channel_participant_bindings")
      ) {
        ownershipQueries.push(query);
        const originalBind = statement.bind.bind(statement);
        vi.spyOn(statement, "bind").mockImplementation((...values: unknown[]) => {
          ownershipBindings.push(values);
          return originalBind(...values);
        });
      }
      return statement;
    });
    let socket: WsClient | null = null;

    try {
      socket = await WsClient.open(slug, participant.token);
      await socket.nextOfType("welcome");
      expect(authorityQueries).toHaveLength(1);
      expect(authorityQueries[0]).toContain(
        "hash IN (SELECT CAST(value AS TEXT) FROM json_each(?))",
      );
      expect(ownershipQueries).toHaveLength(1);
      expect(ownershipQueries[0]).toContain(
        "participant_name COLLATE NOCASE IN",
      );
      expect(ownershipQueries[0]).toContain(
        "name COLLATE NOCASE IN",
      );
      expect(ownershipBindings).toHaveLength(1);
      const [channelSlug, bindingNames, tokenNames, tokenScope] = ownershipBindings[0];
      expect(channelSlug).toBe(slug);
      expect(bindingNames).toBe(tokenNames);
      expect(JSON.parse(String(bindingNames))).toContain(participant.name);
      expect(tokenScope).toBe(slug);
    } finally {
      prepare.mockRestore();
      socket?.close();
    }
  });

  it("matches token ownership when an authority name differs only by case", async () => {
    const owner = `${uniq("case-owner")}@example.com`;
    const name = uniq("CaseSensitiveAgent");
    await seedToken("agent", name, { owner });

    const row = await env.DB.prepare(
      `SELECT name, owner
         FROM tokens
        WHERE owner IS NOT NULL
          AND name COLLATE NOCASE IN (
            SELECT CAST(value AS TEXT) FROM json_each(?)
          )`,
    )
      .bind(JSON.stringify([name.toUpperCase()]))
      .first<{ name: string; owner: string }>();

    expect(row).toEqual({ name, owner });
  });

  it("keeps same-owner delivery resources when a live connection uses a rotated token", async () => {
    const owner = `${uniq("rotated-owner")}@example.com`;
    const sender = await seedToken("human", uniq("sender"), {
      owner: `${uniq("sender-owner")}@example.com`,
    });
    const target = await seedToken("agent", uniq("rotated-agent"), { owner });
    const slug = await createChannel(sender.token);
    await env.DB.prepare("UPDATE channels SET visibility = 'public' WHERE slug = ?").bind(slug).run();
    const stale = await WsClient.open(slug, target.token);
    await stale.nextOfType("welcome");
    let replacement: WsClient | null = null;

    try {
      const sent = await api(`/api/channels/${slug}/messages`, sender.token, {
        method: "POST",
        body: JSON.stringify({
          kind: "message",
          body: `@${target.name} keep queued work`,
          mentions: [target.name],
          reply_to: null,
        }),
      });
      expect(sent.status).toBe(200);

      const replacementToken = `ap_${crypto.randomUUID().replaceAll("-", "")}`;
      await env.DB.prepare("UPDATE tokens SET hash = ? WHERE name = ?")
        .bind(await sha256Hex(replacementToken), target.name)
        .run();
      replacement = await WsClient.open(slug, replacementToken);
      expect(await replacement.next(10_000)).toMatchObject({ type: "welcome" });

      const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
      const deliveries = await runInDurableObject(stub, async (_instance: ChannelDO, state) =>
        state.storage.sql
          .exec(
            "SELECT target_name, target_owner, state FROM directed_deliveries WHERE target_name = ?",
            target.name,
          )
          .toArray(),
      );
      expect(deliveries).toEqual([
        {
          target_name: target.name,
          target_owner: owner,
          state: "queued",
        },
      ]);
    } finally {
      stale.close();
      replacement?.close();
    }
  });

  it("reuses a fresh channel snapshot and reports D1 outages as temporary", async () => {
    const participant = await seedToken("human", uniq("participant"), {
      owner: `${uniq("account")}@example.com`,
    });
    const slug = await createChannel(participant.token);
    expect((await postMessage(slug, participant.token, "one")).status).toBe(200);
    expect((await postMessage(slug, participant.token, "two")).status).toBe(200);

    const socket = await WsClient.open(slug, participant.token);
    await completeCapabilityHello(socket);
    await socket.nextOfType("msg");

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO) => {
      (instance as unknown as { participantAuthorityRefreshedAt: number })
        .participantAuthorityRefreshedAt = Date.now();
    });

    const originalPrepare = env.DB.prepare.bind(env.DB);
    let reconcileQueries = 0;
    let failAuthority = false;
    const prepare = vi.spyOn(env.DB, "prepare").mockImplementation((query: string) => {
      if (
        query.includes("SELECT principal_type, principal, removed_at") &&
        query.includes("FROM channel_participant_removals")
      ) {
        reconcileQueries += 1;
        if (failAuthority) throw new Error("D1 unavailable");
      }
      return originalPrepare(query);
    });

    try {
      socket.send({ type: "seen", seq: 1 });
      await socket.nextOfType("read_cursor");
      expect(reconcileQueries).toBe(0);

      await runInDurableObject(stub, async (instance: ChannelDO) => {
        (instance as unknown as { participantAuthorityRefreshedAt: number })
          .participantAuthorityRefreshedAt = 0;
      });
      failAuthority = true;
      socket.send({ type: "seen", seq: 2 });
      const error = await socket.nextOfType("error");
      expect(error).toMatchObject({
        code: "unavailable",
        message: "participant authorization is temporarily unavailable",
      });
      expect(reconcileQueries).toBe(1);
    } finally {
      prepare.mockRestore();
      socket.close();
    }
  });
});
