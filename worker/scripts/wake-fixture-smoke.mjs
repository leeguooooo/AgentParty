#!/usr/bin/env node

// Live #27 wake-contract fixture.
//
// This script deliberately does not edit production webhook config. It creates a
// random public temp channel, registers one disposable mentions-only webhook,
// sends one wake mention, and proves:
//   mention_delivered -> durable webhook delivery -> linked target resume.
//
// Required environment:
//   AGENTPARTY_FIXTURE_TESTER_TOKEN   write-capable unscoped token that can create temp channels
//   AGENTPARTY_FIXTURE_TARGET_TOKEN   write-capable unscoped token whose /api/me name is TARGET_NAME
//   AGENTPARTY_FIXTURE_TARGET_NAME    webhook/agent name to mention
//   AGENTPARTY_FIXTURE_WEBHOOK_URL    public HTTPS fixture endpoint, not localhost/private IP
//   AGENTPARTY_FIXTURE_WEBHOOK_SECRET bearer/HMAC secret registered on the webhook
//
// The fixture endpoint is expected to verify Authorization + x-agentparty-signature,
// read the webhook payload seq/channel, then post a target-authored linked ack:
//   POST /api/channels/:channel/messages
//   {kind:"status",state:"done",note:"fixture ack",mentions:[],summary_seq:<payload.seq>}
//
// Optional:
//   AGENTPARTY_FIXTURE_BASE=https://agentparty.leeguoo.com
//   AGENTPARTY_FIXTURE_TIMEOUT_MS=30000
//   AGENTPARTY_FIXTURE_KEEP_CHANNEL=1

const base = (process.env.AGENTPARTY_FIXTURE_BASE ?? "https://agentparty.leeguoo.com").replace(/\/+$/, "");
const testerToken = process.env.AGENTPARTY_FIXTURE_TESTER_TOKEN;
const targetToken = process.env.AGENTPARTY_FIXTURE_TARGET_TOKEN;
const webhookUrl = process.env.AGENTPARTY_FIXTURE_WEBHOOK_URL;
const webhookSecret = process.env.AGENTPARTY_FIXTURE_WEBHOOK_SECRET;
const targetName = process.env.AGENTPARTY_FIXTURE_TARGET_NAME;
const timeoutMs = Number(process.env.AGENTPARTY_FIXTURE_TIMEOUT_MS ?? "30000");
const keepChannel = process.env.AGENTPARTY_FIXTURE_KEEP_CHANNEL === "1";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function requireEnv(name, value) {
  if (!value) {
    console.error(`${name} is required.`);
    process.exit(1);
  }
}

requireEnv("AGENTPARTY_FIXTURE_TESTER_TOKEN", testerToken);
requireEnv("AGENTPARTY_FIXTURE_TARGET_TOKEN", targetToken);
requireEnv("AGENTPARTY_FIXTURE_WEBHOOK_URL", webhookUrl);
requireEnv("AGENTPARTY_FIXTURE_WEBHOOK_SECRET", webhookSecret);
requireEnv("AGENTPARTY_FIXTURE_TARGET_NAME", targetName);

if (!NAME_RE.test(targetName)) {
  console.error("AGENTPARTY_FIXTURE_TARGET_NAME must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}.");
  process.exit(1);
}

try {
  const url = new URL(webhookUrl);
  if (url.protocol !== "https:") throw new Error("webhook fixture URL must be https");
} catch (err) {
  console.error(`AGENTPARTY_FIXTURE_WEBHOOK_URL is invalid: ${err.message}`);
  process.exit(1);
}

if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error("AGENTPARTY_FIXTURE_TIMEOUT_MS must be a positive number.");
  process.exit(1);
}

function route(path) {
  return path.startsWith("/") ? path : `/${path}`;
}

async function requestJson(label, path, init = {}, expected = 200) {
  const res = await fetch(`${base}${route(path)}`, init);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${label}: response is not JSON: ${text.slice(0, 300)}`);
  }
  if (res.status !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${res.status}: ${text.slice(0, 300)}`);
  }
  return body;
}

function bearerJson(token) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function poll(label, fn) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() <= deadline) {
    last = await fn();
    if (last) return last;
    await sleep(500);
  }
  throw new Error(`${label}: timed out after ${timeoutMs}ms`);
}

function linkedAck(messages, target, mentionSeq) {
  return messages.find((msg) => {
    if (msg.seq <= mentionSeq) return false;
    if (msg.sender?.name !== target) return false;
    return msg.reply_to === mentionSeq || msg.status?.summary_seq === mentionSeq;
  });
}

async function main() {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const channel = `wake-fixture-${suffix}`.slice(0, 64);
  if (!SLUG_RE.test(channel)) throw new Error(`generated invalid channel slug: ${channel}`);

  let created = false;
  let webhookAdded = false;
  let primaryError = null;

  try {
    const targetMe = await requestJson("target whoami", "/api/me", { headers: bearerJson(targetToken) });
    if (targetMe.name !== targetName) {
      throw new Error(`target token identity is ${targetMe.name}; expected ${targetName}`);
    }
    if (targetMe.role === "readonly") {
      throw new Error("target token must be write-capable, not readonly");
    }

    await requestJson(
      "create fixture channel",
      "/api/channels",
      {
        method: "POST",
        headers: bearerJson(testerToken),
        body: JSON.stringify({
          slug: channel,
          title: "wake adapter live fixture",
          kind: "temp",
          visibility: "public",
        }),
      },
      201,
    );
    created = true;

    await requestJson(
      "publish target wake presence",
      `/api/channels/${encodeURIComponent(channel)}/messages`,
      {
        method: "POST",
        headers: bearerJson(targetToken),
        body: JSON.stringify({
          kind: "status",
          state: "waiting",
          note: "fixture webhook adapter online",
          mentions: [],
          residency: "webhook",
          wake: { kind: "webhook" },
        }),
      },
    );

    await requestJson(
      "register fixture webhook",
      `/api/channels/${encodeURIComponent(channel)}/webhooks`,
      {
        method: "POST",
        headers: bearerJson(testerToken),
        body: JSON.stringify({
          name: targetName,
          url: webhookUrl,
          secret: webhookSecret,
          filter: "mentions",
        }),
      },
      201,
    );
    webhookAdded = true;

    const mention = await requestJson(
      "send wake mention",
      `/api/channels/${encodeURIComponent(channel)}/messages`,
      {
        method: "POST",
        headers: bearerJson(testerToken),
        body: JSON.stringify({
          kind: "message",
          body: `@${targetName} wake fixture: reply or post status with summary_seq`,
          mentions: [targetName],
          reply_to: null,
        }),
      },
    );
    const mentionSeq = mention.seq;
    if (!Number.isInteger(mentionSeq) || mentionSeq <= 0) {
      throw new Error(`send wake mention: invalid seq ${mentionSeq}`);
    }

    const delivery = await poll("wake delivery ledger", async () => {
      const body = await requestJson(
        "wake deliveries",
        `/api/channels/${encodeURIComponent(channel)}/wake-deliveries?since=${mentionSeq}&target=${encodeURIComponent(targetName)}&limit=20`,
        { headers: bearerJson(testerToken) },
      );
      return body.deliveries?.find((row) => row.mention_seq === mentionSeq && row.target_name === targetName) ?? null;
    });
    if (delivery.result !== "ok") {
      throw new Error(`wake delivery failed: ${delivery.result} ${delivery.http_status ?? ""} ${delivery.error ?? ""}`.trim());
    }

    const ack = await poll("linked target ack", async () => {
      const body = await requestJson(
        "fixture history",
        `/api/channels/${encodeURIComponent(channel)}/messages?since=${mentionSeq}&limit=100`,
        { headers: bearerJson(testerToken) },
      );
      return linkedAck(body.messages ?? [], targetName, mentionSeq) ?? null;
    });

    const ackEvidence = ack.reply_to === mentionSeq ? "reply_to" : "status.summary_seq";
    const linkedDelivery = await poll("wake delivery resume link", async () => {
      const body = await requestJson(
        "wake deliveries after ack",
        `/api/channels/${encodeURIComponent(channel)}/wake-deliveries?since=${mentionSeq}&target=${encodeURIComponent(targetName)}&limit=20`,
        { headers: bearerJson(testerToken) },
      );
      return (
        body.deliveries?.find(
          (row) =>
            row.mention_seq === mentionSeq &&
            row.target_name === targetName &&
            (row.ack_seq === ack.seq || row.resume_seq === ack.seq),
        ) ?? null
      );
    });
    console.log(
      JSON.stringify({
        ok: true,
        base,
        channel,
        target: targetName,
        mention_seq: mentionSeq,
        wake_invoked: {
          ok: true,
          adapter: delivery.adapter_kind,
          attempt: delivery.attempt,
          http_status: delivery.http_status,
          ack_seq: linkedDelivery.ack_seq,
          resume_seq: linkedDelivery.resume_seq,
        },
        agent_resumed: {
          ok: true,
          seq: ack.seq,
          evidence: ackEvidence,
        },
        cleanup: keepChannel ? "kept" : "archived",
      }),
    );
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    if (!keepChannel && created) {
      if (webhookAdded) {
        try {
          await requestJson(
            "remove fixture webhook",
            `/api/channels/${encodeURIComponent(channel)}/webhooks/${encodeURIComponent(targetName)}`,
            { method: "DELETE", headers: bearerJson(testerToken) },
          );
        } catch (err) {
          console.error(`cleanup warning: remove fixture webhook failed: ${err.message}`);
        }
      }
      try {
        await requestJson(
          "archive fixture channel",
          `/api/channels/${encodeURIComponent(channel)}/archive`,
          { method: "POST", headers: bearerJson(testerToken) },
        );
      } catch (err) {
        console.error(`cleanup warning: archive fixture channel failed: ${err.message}`);
        if (primaryError === null) throw err;
      }
    }
  }
}

await main();
