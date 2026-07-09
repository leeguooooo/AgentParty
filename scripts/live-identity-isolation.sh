#!/usr/bin/env bash
# Verify AgentParty CLI identity/config isolation with two agent principals.
#
# Default mode runs against an in-process mock server and never posts to a real
# channel. Live mode requires an explicit non-production channel plus two tokens:
#
#   AGENTPARTY_LIVE=1 \
#   AGENTPARTY_SERVER=https://your-agentparty.example \
#   AGENTPARTY_CHANNEL=tmp-your-slug \
#   AGENTPARTY_TOKEN_A=ap_... \
#   AGENTPARTY_TOKEN_B=ap_... \
#   scripts/live-identity-isolation.sh
set -euo pipefail

PARTY_BIN="${PARTY_BIN:-$(command -v party || true)}"
if [[ -z "$PARTY_BIN" ]]; then
  echo "FAIL party binary not found; install party first" >&2
  exit 1
fi

RUN_ID="${RUN_ID:-$(date +%s)-$$}"
MODE="mock"
if [[ "${AGENTPARTY_LIVE:-0}" == "1" ]]; then
  MODE="live"
fi

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/agentparty-live-identity.XXXXXX")"
HOME_DIR="$WORKDIR/home"
mkdir -p "$HOME_DIR"
MOCK_PID=""
SERVER=""

cleanup() {
  local code=$?
  if [[ -n "$MOCK_PID" ]]; then
    kill "$MOCK_PID" >/dev/null 2>&1 || true
    wait "$MOCK_PID" >/dev/null 2>&1 || true
  fi
  if [[ "${KEEP_ARTIFACTS:-0}" == "1" ]]; then
    echo "artifacts kept at $WORKDIR" >&2
  else
    rm -rf "$WORKDIR"
  fi
  exit "$code"
}
trap cleanup EXIT

log() {
  printf '%s\n' "$*"
}

fail() {
  log "FAIL $*"
  return 1
}

slugify() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-48
}

CHANNEL="${AGENTPARTY_CHANNEL:-ap-id-${RUN_ID}}"
CHANNEL="$(slugify "$CHANNEL")"
if [[ -z "$CHANNEL" ]]; then
  CHANNEL="ap-id-${RUN_ID}"
fi

TOKEN_A="${AGENTPARTY_TOKEN_A:-ap_mock_a_${RUN_ID}}"
TOKEN_B="${AGENTPARTY_TOKEN_B:-ap_mock_b_${RUN_ID}}"
NAME_A="${AGENTPARTY_NAME_A:-apt-a-${RUN_ID}}"
NAME_B="${AGENTPARTY_NAME_B:-apt-b-${RUN_ID}}"

start_mock_server() {
  local server_js="$WORKDIR/mock-server.mjs"
  local port_file="$WORKDIR/mock-port"
  cat >"$server_js" <<'JS'
const tokenA = process.env.MOCK_TOKEN_A;
const tokenB = process.env.MOCK_TOKEN_B;
const nameA = process.env.MOCK_NAME_A;
const nameB = process.env.MOCK_NAME_B;
const portFile = process.env.MOCK_PORT_FILE;
const messages = [];
const sockets = new Set();

function tokenFrom(req) {
  const auth = req.headers.get("authorization") || "";
  return auth.replace(/^Bearer\s+/i, "");
}

function identity(token) {
  if (token === tokenA) return { name: nameA, kind: "agent", role: "agent", email: null, owner: null };
  if (token === tokenB) return { name: nameB, kind: "agent", role: "agent", email: null, owner: null };
  return null;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function channelInfo(slug) {
  return {
    slug,
    title: slug,
    kind: "temp",
    mode: "party",
    visibility: "private",
    archived_at: null,
  };
}

function msgFrame(sender, body) {
  const seq = messages.length + 1;
  const frame = {
    type: "msg",
    seq,
    sender: { name: sender.name, kind: sender.kind },
    kind: body.kind || "message",
    body: body.body || "",
    mentions: Array.isArray(body.mentions) ? body.mentions : [],
    reply_to: Number.isInteger(body.reply_to) ? body.reply_to : null,
    state: body.state || null,
    note: body.note || null,
    ts: Date.now(),
  };
  messages.push(frame);
  for (const ws of sockets) {
    if (ws.data?.slug === ws.data?.slug) ws.send(JSON.stringify(frame));
  }
  return frame;
}

const server = Bun.serve({
  port: 0,
  fetch(req, server) {
    const url = new URL(req.url);
    const token = tokenFrom(req);
    const who = identity(token);
    if (!who) return json({ error: { code: "unauthorized", message: "invalid token" } }, 401);

    const wsMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/ws$/);
    if (wsMatch && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const ok = server.upgrade(req, { data: { slug: decodeURIComponent(wsMatch[1]), who } });
      return ok ? undefined : new Response("upgrade failed", { status: 400 });
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      return json(who);
    }
    if (req.method === "GET" && url.pathname === "/api/channels") {
      return json([channelInfo("mock")]);
    }
    if (req.method === "POST" && url.pathname === "/api/channels") {
      return json({ ok: true }, 201);
    }

    const msgMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/messages$/);
    if (msgMatch && req.method === "GET") {
      const since = Number(url.searchParams.get("since") || "0");
      return json({ messages: messages.filter((m) => m.seq > since) });
    }
    if (msgMatch && req.method === "POST") {
      return req.json().then((body) => {
        const frame = msgFrame(who, body || {});
        return json({ seq: frame.seq });
      });
    }

    return json({ error: { code: "not_found", message: "not found" } }, 404);
  },
  websocket: {
    open(ws) {
      sockets.add(ws);
    },
    message(ws, raw) {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (frame.type === "hello") {
        const since = Number(frame.since || 0);
        ws.send(JSON.stringify({
          type: "welcome",
          channel: ws.data.slug,
          self: ws.data.who.name,
          role: "agent",
          participants: [
            { name: nameA, kind: "agent" },
            { name: nameB, kind: "agent" },
          ],
          last_seq: messages.length,
          presence: [],
        }));
        for (const msg of messages) {
          if (msg.seq > since) ws.send(JSON.stringify(msg));
        }
      } else if (frame.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      } else if (frame.type === "send") {
        const msg = msgFrame(ws.data.who, frame);
        ws.send(JSON.stringify({ type: "sent", seq: msg.seq }));
      }
    },
    close(ws) {
      sockets.delete(ws);
    },
  },
});

await Bun.write(portFile, String(server.port));
JS

  MOCK_TOKEN_A="$TOKEN_A" \
  MOCK_TOKEN_B="$TOKEN_B" \
  MOCK_NAME_A="$NAME_A" \
  MOCK_NAME_B="$NAME_B" \
  MOCK_PORT_FILE="$port_file" \
  bun "$server_js" &
  MOCK_PID=$!

  for _ in $(seq 1 50); do
    if [[ -s "$port_file" ]]; then
      SERVER="http://127.0.0.1:$(cat "$port_file")"
      return 0
    fi
    sleep 0.1
  done
  fail "mock server did not start"
}

if [[ "$MODE" == "live" ]]; then
  SERVER="${AGENTPARTY_SERVER:-}"
  if [[ -z "$SERVER" ]]; then
    fail "live mode requires AGENTPARTY_SERVER"
  fi
  if [[ -z "${AGENTPARTY_CHANNEL:-}" ]]; then
    fail "live mode requires AGENTPARTY_CHANNEL; do not use production agentparty"
  fi
  if [[ "$CHANNEL" == "agentparty" ]]; then
    fail "refusing to test against production channel: agentparty"
  fi
  if [[ -z "${AGENTPARTY_TOKEN_A:-}" || -z "${AGENTPARTY_TOKEN_B:-}" ]]; then
    fail "live mode requires AGENTPARTY_TOKEN_A and AGENTPARTY_TOKEN_B"
  fi
else
  start_mock_server
fi

CONFIG_A="$WORKDIR/a/config.json"
CONFIG_B="$WORKDIR/b/config.json"
CONFIG_A_W1="$WORKDIR/a-w1/config.json"
CONFIG_B_W1="$WORKDIR/b-w1/config.json"
CONFIG_A_W2="$WORKDIR/a-w2/config.json"
CONFIG_B_W2="$WORKDIR/b-w2/config.json"

party_version="$("$PARTY_BIN" --version 2>/dev/null || true)"
log "mode=$MODE party_version=${party_version:-unknown} server=$SERVER channel=$CHANNEL"

run_agent() {
  local config="$1"
  shift
  HOME="$HOME_DIR" AGENTPARTY_CONFIG="$config" "$PARTY_BIN" "$@"
}

init_agent() {
  local config="$1"
  local token="$2"
  local label="$3"
  local init_out="$WORKDIR/init-$label.out"
  run_agent "$config" init --server "$SERVER" --token "$token" --channel "$CHANNEL" >"$init_out" 2>&1 || {
    sed "s/$token/[redacted]/g" "$init_out" >&2
    fail "init failed for $label"
  }
}

init_agent "$CONFIG_A" "$TOKEN_A" "a"
init_agent "$CONFIG_B" "$TOKEN_B" "b"

if [[ "$MODE" == "live" ]]; then
  NAME_A="$(run_agent "$CONFIG_A" whoami | sed -E 's/^logged in as ([^ ]+) .*/\1/')"
  NAME_B="$(run_agent "$CONFIG_B" whoami | sed -E 's/^logged in as ([^ ]+) .*/\1/')"
  log "live identities: A=$NAME_A B=$NAME_B"
fi

BODY_A1="identity-a-before-reinit-${RUN_ID}"
BODY_A2="identity-a-after-b-reinit-${RUN_ID}"
BODY_B1="identity-b-${RUN_ID}"

run_agent "$CONFIG_A" send "$BODY_A1" --channel "$CHANNEL" --mention "$NAME_B" >/dev/null
init_agent "$CONFIG_B" "$TOKEN_B" "b-reinit"
run_agent "$CONFIG_A" send "$BODY_A2" --channel "$CHANNEL" --mention "$NAME_B" >/dev/null
run_agent "$CONFIG_B" send "$BODY_B1" --channel "$CHANNEL" --mention "$NAME_A" >/dev/null

HISTORY="$WORKDIR/history.txt"
run_agent "$CONFIG_A" history "$CHANNEL" --limit 80 >"$HISTORY"
sed -n '1,120p' "$HISTORY"

assert_history_sender() {
  local body="$1"
  local expected="$2"
  if grep -F "$body" "$HISTORY" | grep -F "$expected(agent):" >/dev/null; then
    log "ok history sender: $body -> $expected"
  else
    log "FAIL history sender: $body did not come from $expected"
    return 1
  fi
}

failures=0
assert_history_sender "$BODY_A1" "$NAME_A" || failures=$((failures + 1))
assert_history_sender "$BODY_A2" "$NAME_A" || failures=$((failures + 1))
assert_history_sender "$BODY_B1" "$NAME_B" || failures=$((failures + 1))

watch_pair() {
  local suffix="$1"
  local sender_config="$2"
  local sender_name="$3"
  local target_name="$4"
  local body="mention-${target_name}-from-${sender_name}-${RUN_ID}-${suffix}"
  local a_out="$WORKDIR/watch-a-${suffix}.out"
  local b_out="$WORKDIR/watch-b-${suffix}.out"
  local a_code=0
  local b_code=0

  init_agent "$CONFIG_A_W1" "$TOKEN_A" "a-watch-$suffix"
  init_agent "$CONFIG_B_W1" "$TOKEN_B" "b-watch-$suffix"
  run_agent "$CONFIG_A_W1" send "cursor-prime-a-${RUN_ID}-${suffix}" --channel "$CHANNEL" >/dev/null
  run_agent "$CONFIG_B_W1" send "cursor-prime-b-${RUN_ID}-${suffix}" --channel "$CHANNEL" >/dev/null

  set +e
  run_agent "$CONFIG_A_W1" watch "$CHANNEL" --mentions-only --timeout 5 >"$a_out" 2>&1 &
  local a_pid=$!
  run_agent "$CONFIG_B_W1" watch "$CHANNEL" --mentions-only --timeout 5 >"$b_out" 2>&1 &
  local b_pid=$!
  set -e

  sleep 0.6
  run_agent "$sender_config" send "$body" --channel "$CHANNEL" --mention "$target_name" >/dev/null

  set +e
  wait "$a_pid"; a_code=$?
  wait "$b_pid"; b_code=$?
  set -e

  log "--- watch A ($suffix, exit=$a_code) ---"
  sed -n '1,80p' "$a_out"
  log "--- watch B ($suffix, exit=$b_code) ---"
  sed -n '1,80p' "$b_out"

  if [[ "$target_name" == "$NAME_A" ]]; then
    grep -F "$body" "$a_out" >/dev/null || { log "FAIL mention delivery: A did not receive $body"; return 1; }
    grep -F "$body" "$b_out" >/dev/null && { log "FAIL mention delivery: B also received $body"; return 1; }
  else
    grep -F "$body" "$b_out" >/dev/null || { log "FAIL mention delivery: B did not receive $body"; return 1; }
    grep -F "$body" "$a_out" >/dev/null && { log "FAIL mention delivery: A also received $body"; return 1; }
  fi
  log "ok mention delivery: only $target_name received $body"
}

watch_pair "to-b" "$CONFIG_A" "$NAME_A" "$NAME_B" || failures=$((failures + 1))

# Use separate config files for the second watch pair so cursors do not hide the
# target message. The function uses W1 names internally; swap paths here.
CONFIG_A_W1="$CONFIG_A_W2"
CONFIG_B_W1="$CONFIG_B_W2"
watch_pair "to-a" "$CONFIG_B" "$NAME_B" "$NAME_A" || failures=$((failures + 1))

if [[ "$failures" -gt 0 ]]; then
  log "FAIL identity isolation checks failed ($failures failure(s))"
  exit 1
fi

log "PASS identity isolation checks passed"
