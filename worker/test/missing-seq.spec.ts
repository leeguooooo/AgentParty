import { describe, expect, it } from "vitest";
import { api, createChannel, postMessage, seedToken, uniq } from "./helpers";

// #785: revision/review endpoints looked up the target message with `.one()`,
// which throws on an empty result set. For a non-existent seq this surfaced as
// a 500 that leaked the internal SQL error + stack to the client, instead of a
// clean 404 (the dead `if (!row)` guard could never run). These tests pin the
// intended behaviour: a missing seq is a client 404, never a 500, and the body
// never carries an internal stack.

const MISSING_SEQ = 999999;

async function scopedFixture() {
  const acct = `${uniq("acct")}@leeguoo.com`;
  const owner = await seedToken("agent", uniq("owner"), { owner: acct });
  const slug = await createChannel(owner.token);
  const writer = await seedToken("agent", uniq("writer"), { owner: acct, channelScope: slug });
  return { slug, owner, writer };
}

async function expectNotFound(res: Response) {
  expect(res.status).toBe(404);
  const raw = await res.text();
  const parsed = JSON.parse(raw) as { error?: { code?: string } };
  expect(parsed.error?.code).toBe("not_found");
  // Must not leak internal implementation details (bundle path / SQL / stack).
  expect(raw).not.toMatch(/index\.js|\bat \w+.*\(|SqlStorage|SQLITE/i);
}

describe("missing seq returns 404 not 500 (#785)", () => {
  it("retract of a non-existent seq → 404", async () => {
    const { slug, writer } = await scopedFixture();
    const res = await api(`/api/channels/${slug}/messages/${MISSING_SEQ}/retract`, writer.token, { method: "POST" });
    await expectNotFound(res);
  });

  it("edit of a non-existent seq → 404", async () => {
    const { slug, writer } = await scopedFixture();
    const res = await api(`/api/channels/${slug}/messages/${MISSING_SEQ}/edit`, writer.token, {
      method: "POST",
      body: JSON.stringify({ body: "does not matter" }),
    });
    await expectNotFound(res);
  });

  it("supersede of a non-existent seq → 404", async () => {
    const { slug, writer } = await scopedFixture();
    const res = await api(`/api/channels/${slug}/messages/${MISSING_SEQ}/supersede`, writer.token, {
      method: "POST",
      body: JSON.stringify({ body: "does not matter" }),
    });
    await expectNotFound(res);
  });

  it("review of a non-existent seq → 404", async () => {
    const { slug, writer } = await scopedFixture();
    const res = await api(`/api/channels/${slug}/messages/${MISSING_SEQ}/review`, writer.token, {
      method: "POST",
      body: JSON.stringify({ action: "approve" }),
    });
    await expectNotFound(res);
  });

  it("completion send that replaces a non-existent seq → 400 (not 500)", async () => {
    const acct = `${uniq("acct")}@leeguoo.com`;
    const owner = await seedToken("agent", uniq("owner"), { owner: acct });
    const slug = await createChannel(owner.token);
    const writer = await seedToken("agent", uniq("writer"), { owner: acct, channelScope: slug });
    const gate = await api(`/api/channels/${slug}/completion-gate`, owner.token, {
      method: "PUT",
      body: JSON.stringify({ gate: "reviewer", policy: "sender" }),
    });
    expect(gate.status).toBe(200);
    const kickoff = await postMessage(slug, writer.token, "please do the work");
    const kickoffSeq = ((await kickoff.json()) as { seq: number }).seq;

    const res = await api(`/api/channels/${slug}/messages`, writer.token, {
      method: "POST",
      body: JSON.stringify({
        kind: "message",
        body: "final synthesis",
        mentions: [],
        reply_to: kickoffSeq,
        completion_artifact: {
          kind: "final_synthesis",
          kickoff_seq: kickoffSeq,
          replies_count: 1,
          timeout: false,
          related_issues: [],
          related_prs: [],
        },
        replaces: MISSING_SEQ,
      }),
    });

    expect(res.status).toBe(400);
    const raw = await res.text();
    const parsed = JSON.parse(raw) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe("bad_request");
    expect(raw).not.toMatch(/index\.js|\bat \w+.*\(|SqlStorage|SQLITE/i);
  });
});
