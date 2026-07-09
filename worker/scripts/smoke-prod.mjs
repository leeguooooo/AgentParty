const rawBase = process.env.AGENTPARTY_SMOKE_BASE;
const token = process.env.AGENTPARTY_SMOKE_TOKEN;
const writeToken = process.env.AGENTPARTY_SMOKE_WRITE_TOKEN;

if (!rawBase) {
  console.error("AGENTPARTY_SMOKE_BASE is required.");
  process.exit(1);
}

const base = rawBase.replace(/\/+$/, "");

if (!token) {
  console.error("AGENTPARTY_SMOKE_TOKEN is required.");
  process.exit(1);
}

if (!writeToken) {
  console.error("AGENTPARTY_SMOKE_WRITE_TOKEN is required; use a disposable human/agent token.");
  process.exit(1);
}

function route(path) {
  return path.startsWith("/") ? path : `/${path}`;
}

async function readJson(label, path, init = {}, expected = 200) {
  const res = await fetch(`${base}${route(path)}`, init);
  const text = await res.text();
  if (res.status !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return text === "" ? null : JSON.parse(text);
  } catch {
    throw new Error(`${label}: response is not JSON`);
  }
}

async function readText(label, path, init = {}, expected = 200) {
  const res = await fetch(`${base}${route(path)}`, init);
  const text = await res.text();
  if (res.status !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${res.status}: ${text.slice(0, 300)}`);
  }
  return text;
}

function requireField(obj, field, label) {
  if (!(field in obj)) throw new Error(`${label}: missing ${field}`);
}

async function main() {
  let cleanupSlug = null;
  let primaryError = null;
  try {
    await readJson("health", "/api/health");
    await readJson("openapi", "/openapi.json");
    await readJson("unauthenticated channels", "/api/channels", {}, 401);
    await readJson("query token does not authorize rest", `/api/channels?t=${encodeURIComponent(token)}`, {}, 401);

    const homeHtml = await readText("home html", "/");
    if (!homeHtml.includes("AgentParty") || !homeHtml.includes("/assets/")) {
      throw new Error("home html: missing expected app shell or assets");
    }
    const assetPath = homeHtml.match(/(?:src|href)="([^"]*\/assets\/[^"]+)"/)?.[1];
    if (!assetPath) {
      throw new Error("home html: no asset reference found");
    }
    await readText("first app asset", assetPath);

    const authHeaders = { authorization: `Bearer ${token}` };
    const writeHeaders = { authorization: `Bearer ${writeToken}`, "content-type": "application/json" };
    let channelsBody = await readJson("authenticated channels", "/api/channels", {
      headers: authHeaders,
    });
    if (!Array.isArray(channelsBody.channels)) {
      throw new Error("authenticated channels: missing channels array");
    }

    for (const [i, channel] of channelsBody.channels.entries()) {
      for (const field of ["slug", "kind", "mode", "archived_at", "last_message", "presence"]) {
        requireField(channel, field, `channel[${i}]`);
      }
      if (!Array.isArray(channel.presence)) {
        throw new Error(`channel[${i}]: presence is not an array`);
      }
    }

    cleanupSlug = `smoke-${Date.now().toString(36)}`;
    await readJson(
      "create smoke channel",
      "/api/channels",
      {
        method: "POST",
        headers: writeHeaders,
        body: JSON.stringify({ slug: cleanupSlug, title: "production smoke", kind: "temp" }),
      },
      201,
    );
    await readJson(
      "post smoke message",
      `/api/channels/${encodeURIComponent(cleanupSlug)}/messages`,
      {
        method: "POST",
        headers: writeHeaders,
        body: JSON.stringify({ kind: "message", body: "production smoke", mentions: [], reply_to: null }),
      },
    );
    channelsBody = await readJson("authenticated channels after smoke create", "/api/channels", {
      headers: authHeaders,
    });
    const first = channelsBody.channels.find((channel) => channel.slug === cleanupSlug);
    if (first === undefined) {
      throw new Error("authenticated channels: smoke channel creation did not become visible");
    }

    const channelHtml = await readText("channel html", `/c/${encodeURIComponent(first.slug)}`);
    if (!channelHtml.includes("AgentParty") || !channelHtml.includes("/assets/")) {
      throw new Error("channel html: missing expected app shell or assets");
    }
    const historyBody = await readJson(
      "channel history",
      `/api/channels/${encodeURIComponent(first.slug)}/messages?limit=1`,
      { headers: authHeaders },
    );
    if (!Array.isArray(historyBody.messages)) {
      throw new Error("channel history: missing messages array");
    }
    if (historyBody.messages.length === 0) {
      throw new Error("channel history: smoke message did not become visible");
    }

    await readJson(
      "archive smoke channel",
      `/api/channels/${encodeURIComponent(cleanupSlug)}/archive`,
      { method: "POST", headers: { authorization: `Bearer ${writeToken}` } },
    );
    await readJson(
      "post archived smoke channel",
      `/api/channels/${encodeURIComponent(cleanupSlug)}/messages`,
      {
        method: "POST",
        headers: writeHeaders,
        body: JSON.stringify({ kind: "message", body: "should fail after archive", mentions: [], reply_to: null }),
      },
      410,
    );
    const archivedSlug = cleanupSlug;
    cleanupSlug = null;

    console.log(
      JSON.stringify({
        ok: true,
        base,
        channelCount: channelsBody.channels.length,
        historyChecked: true,
        assetChecked: assetPath,
        createdChannel: archivedSlug,
        writeChecked: true,
        archiveChecked: true,
      }),
    );
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    if (cleanupSlug !== null) {
      try {
        await readJson(
          "cleanup archive smoke channel",
          `/api/channels/${encodeURIComponent(cleanupSlug)}/archive`,
          { method: "POST", headers: { authorization: `Bearer ${writeToken}` } },
        );
      } catch (err) {
        console.error(`cleanup failed for ${cleanupSlug}: ${err.message}`);
        if (primaryError === null) throw err;
      }
    }
  }
}

await main();
