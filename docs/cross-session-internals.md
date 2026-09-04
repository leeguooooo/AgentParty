# Cross-session: gate, hook, and acceptance internals

中文版：[cross-session-internals.zh.md](cross-session-internals.zh.md)

The evidence rules behind `party bridge claude`. Read
[Attach live Claude sessions](../README.md#attach-live-claude-sessions) first — this page is the
fail-closed specification, not a getting-started guide.

## Discovery, permits, and the send barrier

The preflight does not require another session to be online; live peer discovery still happens inside
the bridged session through `party_channel_peers`, Claude's fresh `ListAgents` result, and an immediate
`party_channel_peer_check` of the exact ephemeral candidate before `SendMessage`.
The confirmed result must return `send_to` equal to that exact fresh `ListAgents` address; the
acceptance verifier binds the hint, candidate, confirmed `send_to`, and actual recipient as one chain.
If one peers result binds the same `candidate_ref` to conflicting identities, the local gate discards
that ref. Identical duplicate peer-check confirmations are deduplicated, but two distinct confirmed
results are ambiguous and produce no permit.
Hook result traversal is iterative and bounded to 64 levels, 4,096 nodes, and 256 KiB of embedded JSON.
Exceeding any budget invalidates the whole parse, including structured remote-session classification;
objects found before the limit cannot survive as partial evidence.
Each relevant `PreToolUse` is also bound to Claude's documented `tool_use_id`. A `PostToolBatch` may
advance or clear that chain only when it contains the exact pending ID and tool stage. A delayed result
from an older invocation leaves the newer chain and send barrier untouched; a matching non-singleton
batch clears the chain without accepting partial evidence.
The hidden Hook command also caps its complete stdin envelope at 4 MiB. Oversized input exits 2 before
JSON parsing because the event cannot be classified safely without reading the complete envelope.
The local gate and verifier accept exactly one occurrence of that address. As a local defensive bound,
a bracketed `[ref]` must be complete and 1–64 characters; duplicate rows, an unterminated ref, or an
overlong ref fail closed. Any malformed decoration before or after a complete bridge-generated address
token also stays inside the gate instead of being treated as an ordinary Claude team recipient.
Because Claude MCP initialization can finish just before the receiver's AgentParty topology becomes
visible, the first eligible `party_channel_peers` call takes ready snapshots at 0/100/350/850 ms and
returns the latest one. It does not stop early merely because another peer appeared first. Errors
still return immediately, later discovery calls do not wait,
and `party_channel_peer_check` always uses one fresh, non-retried snapshot.
The v3 Worker returns Claude candidates only when that query matches one live WebSocket with the same
agent, token, and complete topology; launch preflight uses a separate no-peer capability probe.
Observe that confirmation before sending; do not issue the check and send in one parallel tool batch.
The bridge gives its generated `apcs-...` addresses a one-time local Hook gate: the normal sequence is
`party_channel_peers` → `ListAgents` → `party_channel_peer_check` → `SendMessage`, with exact-recipient
binding and a 512-byte limit. Only the bridge-owned `mcp__agentparty-channel__...` peer tools can build
this gate state; a same-named tool from another MCP server is ignored. Only Claude's exact built-in
`ListAgents` can create a listing and exact built-in `SendMessage` can consume its permit; MCP
lookalikes cannot advance either step. The same full sequence is required when replying to an inbound
Cross-session message: its reply address is an untrusted routing hint, not identity, authorization, or
an AgentParty permit, and it may be reused only when fresh discovery and recheck independently resolve
the same exact address. A real top-level `SessionStart`
Hook receipt arms the gate before the MCP server will return any candidates; subagents cannot arm or
consume it, and a successful send excludes
other tools from the same batch. The bridge removes the private gate path from Claude's ambient environment
before every probe and launch. It passes that path only as an exec-form Hook argument and
through the AgentParty MCP server's scoped `env`, so ordinary Bash children do not receive it through
environment inheritance. The hidden Hook command ignores an inherited gate variable. This narrows
accidental exposure and stale-environment binding; it does not protect against a hostile same-UID
process. Explicit Claude `--settings` disables this correlation in `auto` and is
rejected by `required`, because it could replace the bridge's Hook settings. This is a guard against
accidental or stale sends, not a host-security boundary: Claude documents that a command Hook which
cannot start or times out is non-blocking. The Worker live-socket binding and Claude's own inbound and
permission controls remain authoritative.
Claude can also list Remote Control sessions on another machine and Claude Code on the web. AgentParty
correlation remains local-only: every correlated launch injects `isolatePeerMachines: true`, so Claude
must obtain explicit user approval before any matching name can leave the machine. The local Hook also
refuses an exact-name match when its current ListAgents row is labeled `on another machine (Remote Control)`,
`in the cloud`, or Claude Code on the web; the model receives the same restriction as launch guidance.
An enabled launch line reports `cross_machine=approval_required`; this is a send boundary, not evidence
that the selected row is local or that delivery occurred.
The no-launch JSON check reports the same prospective setting as
`cross_machine_policy_on_launch=explicit_approval_required`; `--cross-session off` reports
`not_applicable`. This field describes what the bridge would configure on launch. It does not prove
that a session started, a candidate is local, or a message was delivered.
The bridge leaves inbound handling to Claude by default. An operator-controlled acceptance run can pair
`--cross-session required` with
`--cross-session-inbound accept`; the bridge merges that value into its own per-launch Hook settings so
callers never need a conflicting raw Claude `--settings`. Claude still applies a stricter managed,
project, or local `hold`/`refuse` policy. Only one text-only main-session inbound user event observed
after the receiver's unique `system/init`, with the same `session_id`, proves delivery; a missing or
different session ID, duplicate marker, `tool_result`, replayed prompt, malformed `isReplay`, or event with a non-null
`agent_id` or `parent_tool_use_id` does not.
`required` is for acceptance checks and operator-controlled launches. Cross-session needs macOS or
Linux and Claude Code 2.1.224+. The raw Claude Channel capability begins at 2.1.80, but the complete
Marketplace Plugin shell used here requires Claude Code 2.1.154+ because its manifest depends on
`defaultEnabled`, `channels`, and strict Plugin validation. Organization policy must also permit
development Channels. `party claude` and `party bridge claude` fail before model launch on an older
Plugin shell instead of treating raw Channel support as full Plugin compatibility.
Claude does not offer Cross-session on Bedrock, Claude Platform on AWS, Google Cloud's Agent
Platform, or Microsoft Foundry. The bridge reports `reason=unsupported_provider` when the inherited
provider variables or `claude auth status` reveal one of those providers. A resolved `apiProvider`
has precedence because Claude has already applied settings; inherited provider variables are only a
fallback when that field is absent. The bridge also follows Claude's
documented environment semantics for feature-flag opt-outs and reports
`reason=feature_flag_evaluation_disabled`: any non-empty `DISABLE_TELEMETRY` or
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` value disables evaluation, including `0` and `false`,
while `DO_NOT_TRACK` and `DISABLE_GROWTHBOOK` disable it only when set to `1` or `true`.
Parent-visible feature-flag values degrade conservatively because settings and remote managed policy
can still change the effective session environment after this preflight. A real top-level
`SessionStart` arm receipt and Claude's `/list-agents`
result remain the authoritative availability evidence.
Every bridge launch first verifies `claude auth status` with the same working directory and
environment that the child will inherit. A confirmed logged-out state or an unreadable auth result
stops before Channel access and before spawning Claude; use `claude auth login`, then retry.
The verifier's `claude --version` and `claude auth status` subprocesses each have a 10-second
deadline covering both process exit and complete stdout/stderr drain. On timeout it terminates the
detached process group, so a stuck wrapper cannot leave a Claude descendant or block JSON preflight output.
`--check --json` runs the single-identity launch preflight without starting Claude. Its result reports
Claude login, Channel access, runtime comparison, and local gate creation separately. Its additive
`blockers` array lists every independently observed obstacle, even when the compatibility `status` and
`reason` retain only the primary one. An HTTP 404 from the runtime capability probe is
`worker_upgrade_required`; other probe failures remain `runtime_comparison_unavailable`. An empty array
is launch-prerequisite evidence, not live delivery proof. When available,
`claude_api_provider` records the sanitized provider resolved by Claude, and
`cross_session_conflict_variables` lists conflicting environment variable names without exposing their
values. A failed built-in Channel probe also reports the optional stable subphase
`channel_probe_phase=authentication|identity|presence|identity_binding`; injected legacy probes that
raise an untyped error leave it absent. Failed built-in endpoint probes also report the number of
endpoint calls made as `channel_probe_attempts` for identity/Presence or `runtime_probe_attempts` for
runtime capability. One means a terminal failure was not retried; three means both bounded retries
were exhausted. Missing means there is no built-in endpoint-attempt evidence, not zero attempts.
The built-in identity, Presence, and runtime-capability HTTP
probes retry only 429 and 5xx responses after 150/500 ms; all attempts share the original five-second
deadline. The repeated capability probe remains comparison-only: it returns no peers and never
publishes topology or candidates. Other HTTP failures and injected probes remain one-shot. These
diagnostic fields are optional additions to the v1 schema.
The result always keeps
`session_start_armed=false`, `peer_presence_checked=false`, and `delivery_verified=false`: those facts
exist only after a real bridged session starts and a peer exchange succeeds. In `auto`, a missing
Cross-session prerequisite exits successfully when the durable Channel can still launch; `required`
returns nonzero for the same condition.
The `SessionStart` Hook writes no stdout, because Claude treats that output as model context. The
parent bridge watches the private arm file and emits a structured receipt as soon as the top-level
session arms, while Claude is still running. A normal launch prints it on bridge stderr. If Claude
exits without arming, `required` returns nonzero and `auto` reports `cross_session=session_start_unarmed`.
The full two-agent verifier instead gives the
bridge a nonexistent path inside its private directory: the bridge removes that path from every Claude
probe and child environment, creates the file exclusively with mode 0600, and writes the receipt there.
The verifier accepts arming only when each receipt's generated address and session ID match that
process's launch line and unique `system/init.session_id`; its final evidence
reports `receiver_session_start_armed=true` and `sender_session_start_armed=true` separately from MCP
initialization and marker delivery. It also requires `distinct_claude_session_ids=true` and
`distinct_bridge_addresses=true`; two receipts from one session or one generated address cannot be
presented as a two-session run.
For the native Claude transport alone, run
`bun scripts/verify-claude-cross-session.ts --preflight-only` first. It runs only the bounded
`claude --version` and `claude auth status` probes, emits
`agentparty.claude-cross-session-native-preflight.v1`, and exits before either `claude -p` model
session can start. The report keeps `model_calls_started=false` and `delivery_verified=false`, while
its additive `blockers` distinguishes verified logout, an unavailable auth probe, an unsupported
provider, disabled feature-flag evaluation, an old Claude version, and an unsupported platform.
Its status/exit mappings match the corresponding full verifier diagnostics. A `ready` result proves
only these local static prerequisites; it says nothing about Claude registration, native delivery,
AgentParty topology, or the deployed Worker.
Unknown or duplicate preflight arguments return the same schema with `status=invalid_request`,
`error_code=invalid_arguments`, and exit 9 before either Claude probe. Unexpected failures return
`internal_error` and exit 1; neither path echoes the rejected argument or raw exception text.
The full native command now keeps the acceptance v1 schema for every non-help outcome. It reports
`failure_phase=request|preflight|receiver_startup|execution|evidence|internal` with a stable
`error_code`; a prerequisite that changes after an earlier preflight is embedded as a fresh
`preflight` object and still keeps `model_calls_started=false`. Receiver or execution diagnostics
stay in the reported artifact directory rather than stdout/stderr. Evidence failure remains distinct
from a process failure, and only a complete live run reports `delivery_verified=true`.
Installed `party` builds include the complete two-agent verifier:

```sh
party bridge claude --verify --channel dev \
  --receiver-config /path/to/receiver.json \
  --sender-config /path/to/sender.json \
  --receiver-cwd /path/to/receiver-worktree \
  --sender-cwd /path/to/sender-worktree \
  --preflight-only
```

Remove `--preflight-only` only when you intend to start two real Claude model sessions. The verifier
launches both sessions through the same `party` executable that owns the command; it does not depend
on a source checkout or a separately installed bridge. Every preflight result, including invalid input,
keeps `model_calls_started=false` and `delivery_verified=false`. Its additive
`blockers` array lists every independently known Marketplace lifecycle, authentication, provider,
feature-flag, and runtime prerequisite, so a missing Plugin, broken auth probe, unsupported provider,
and old Worker can be reported together. The nested `lifecycle` object uses the same Plugin-only
inspection as `party bridge claude --check`; any lifecycle blocker produces
`plugin_lifecycle_unavailable` with exit 11 before a model session can start.
During a full live run, the verifier also polls Channel presence for at most 10 seconds per side.
It requires `receiver_lifecycle_activity_observed=true` and
`sender_lifecycle_activity_observed=true`, bound to the exact live daemon identity and an activity
timestamp after that process launched. Old activity, an offline row, a watch/observer connection, or
another agent cannot substitute. These checks prove the Marketplace Hook actually reached Channel
presence; install and manifest checks alone do not.
`claude_auth_status` distinguishes a verified `logged_out` result from `unavailable`; only the former
means `claude auth login` is the right fix. The established `ready`, `claude_auth_required`,
`worker_upgrade_required`, and `runtime_peer_unavailable` status/exit mappings keep their compatibility
meaning. An empty array means only that these static prerequisites are ready, not that registration or
delivery has been proved. Receiver and sender AgentParty checks are independent:
`receiver_identity`/`sender_identity` and `receiver_channel_access`/`sender_channel_access` remain
machine-readable even when a token is revoked. In that case the primary status is
`agentparty_unavailable`, each affected side gets its own blocker and HTTP status, and dependent checks
say `not_checked` instead of pretending the endpoint was unavailable.
The two cwd flags are optional and default independently to the verifier's current directory. When they
are present, each bridge child starts in its own canonical directory. Before model calls, the verifier
derives the strongest expected relation: `same_worktree`, `same_workspace`, or
`same_local_installation`. Both outbound evidence chains must report that exact relation and its matching
coordination action; the JSON result exposes it as `expected_topology_relation`. The verifier knows it
started both child processes locally, but the topology relation itself remains client-asserted and is
not an identity or authorization claim. Retained failure evidence redacts both cwd paths.
The verifier also reads the uncached `/api/health` deployment identity before model calls. Preflight
reports `worker_deployment_status` plus the exact version, 40-character commit, and deployment time;
on a remote server, missing or malformed metadata adds `worker_deployment_unavailable` and maps to
`worker_upgrade_required`. A successful remote v2 acceptance embeds the same `worker_deployment`
object, so the round-trip evidence identifies the Worker build it exercised. Loopback development may
continue as `worker_deployment_status=development_unversioned`, which is explicitly not release proof.
Startup validation uses the same v1 JSON schema. Invalid arguments, channel names, configs, or server
pairing return `invalid_request` with a stable `error_code` and exit 9. Unsupported local platforms,
missing Claude, old Claude versions, or unavailable runtime-topology inputs return
`environment_unavailable` and exit 10. Unexpected failures return only `internal_error` and exit 1;
the JSON does not echo config paths, tokens, or raw exception text.
The full AgentParty verifier uses its v2 acceptance schema for every non-help outcome. It runs the
same complete static preflight before starting either model and, on failure, embeds that fresh result
with `model_calls_started=false`. Stable
`failure_phase=request|preflight|receiver_startup|execution|evidence|internal` and `error_code` fields
separate invalid input, Worker/auth/topology prerequisites, bridge startup, process execution, and
incomplete evidence. Raw bridge output is written only to token/path-redacted artifacts. Only the
complete two-direction gated chain reports `delivery_verified=true`.
Worker deployment now fails before migration/deploy unless it has a runtime-smoke agent token
(`AGENTPARTY_RUNTIME_SMOKE_TOKEN`, falling back to an agent-valued `AGENTPARTY_SMOKE_TOKEN`). After
checking the secret exists, a credentials-only preflight verifies `/api/me` resolves to a named agent
and that its selected channel is accessible; this happens before any target migration or deployment
and also confirms the release runtime has a WebSocket client. It deliberately reports
`protocol_checked=false`. After deployment, the same credentials run an
authenticated live-topology smoke before any write-path smoke. It opens two temporary WebSockets with
the same random `node_ref` but different workspace/worktree refs, waits for each topology `hello` to
cross an application-queue ping/pong barrier, and then requires the exact v3 `caller_binding=live_socket`
projection with one uniquely addressable `same_local_installation` Claude candidate. The command waits
for both bounded close handshakes before reporting `sockets_closed=true`. A transient 409 caller-binding
conflict is retried twice with bounded backoff; a final 409 includes `matches=N`, distinguishing a missing
caller (`0`) from duplicate live callers (`2+`). The response must contain none of the four request-side topology refs. The
smoke sends no Channel or Claude message, so it proves deployed Worker
binding/comparison—not Cross-session delivery. Use `smoke-runtime-peers.mjs --capability-only` only
when the weaker empty-peer endpoint diagnostic is specifically needed.
Local deployment also refuses staged, modified, or untracked Worker/shared/web inputs, so the
commit exposed by `/api/health` identifies the code and assets Wrangler actually packaged. Changes
outside those deployment inputs, such as CLI work or documentation, do not block a Worker release.
The v2 acceptance result also requires the receiver to observe the first marker, independently rerun
`party_channel_peers` → `ListAgents` → `party_channel_peer_check` → `SendMessage` for the sender, and
send a distinct reply marker that the sender observes as same-session inbound text. Observing either
marker without its outbound gated chain is insufficient. Each direction must also contain the unique,
non-error `SendMessage` result for that exact send.
Because both headless sessions receive a message, the verifier launches both with bridge-owned
`--cross-session-inbound accept`; a `-p` session cannot service an approval dialog if its default
inbound policy holds the message.
The verifier does not guess fixed sleep durations. Each session waits inside one Bash tool call on a
private 0600 signal file; the harness creates that file only after observing the other session's
matching direct singleton `SendMessage` tool result. Claude then reads the queued message at the next
tool boundary, matching Claude's documented busy-session behavior. The result includes
`timing_barriers_intact=true`; a pre-created or unwritable signal fails acceptance. The stream evidence
independently requires the receiver wait result before the first inbound marker and the sender wait
result before the reply marker. A signal file or a matching marker cannot substitute for those two
ordered tool boundaries.
Both bridge exits share one 180-second deadline. A non-zero exit stops the peer's isolated process
group immediately; a zero exit may legitimately arrive first while the other side finishes. After
both bridge leaders exit, the verifier terminates any pipe-holding descendants before draining the
evidence streams.
Receiver Claude/MCP initialization, bridge launch-address discovery, and a receipt matching that
address plus the unique `system/init.session_id` share one 20-second readiness deadline. If the
receiver exits before all three signals arrive, acceptance fails before spawning the sender.
It accepts each outbound tool chain only from events after that session's unique `system/init` carrying the
same `session_id`. Exact-one tool-use counts still cover the full stream: a missing or foreign-session
event cannot fill a step, and a foreign-session duplicate invalidates the run.
Every accepted step must also be a direct, top-level, singleton `tool_use` or `tool_result` block in
Claude's stream envelope, with no unrelated tool call between steps. Nested lookalikes, subagent child
events, and sibling results from a parallel batch cannot supply evidence. The live Hook applies the
same fail-closed rule: any non-null `agent_id` is a child, and a malformed sibling still makes the batch
non-singleton instead of being filtered away. It binds each relevant `PreToolUse` and `PostToolBatch`
result by the exact documented `tool_use_id`; a delayed result cannot advance or clear a newer chain.
Every peers, ListAgents, peer-check, SendMessage, and wait result must also be the only non-error result
for its exact tool-use ID across the complete stream; a duplicate in a foreign or child session
invalidates that stage.
Its command wrapper also converts any private gate-state
exception during `PreToolUse` to Claude's blocking exit 2; that path never falls through to the CLI's
generic, non-blocking exit 1. Syntactically valid JSON scalars, arrays, empty objects, and unknown Hook
events are malformed envelopes and also exit 2 instead of falling through as no-ops. After a new
`SessionStart` re-arms the launch, delayed `PreToolUse` or
`PostToolBatch` events from the previous session cannot read, clear, or consume the new session's chain.
All three state transitions share the consume lock and recheck the armed session while holding it, so a
re-arm between an optimistic check and lock acquisition cannot revive the previous session's event.

## Identity inside a Claude session

`party` resolves its identity config in this order; `party whoami` prints the winning step as
`config-resolved-by`, `party doctor` as `resolved-by`, and `whoami --json` as `config.resolution`:

1. `explicit env` — `AGENTPARTY_CONFIG` (or the global `--config` flag). Fail-closed: when that file and
   its durable mirror are both unreadable, no other source is substituted.
2. `claude session registry` — only inside a Claude Code process tree (Claude sets `CLAUDECODE` for
   every child). `party` first reads Claude's own `CLAUDE_CODE_SESSION_ID` and
   `CLAUDE_CODE_MESSAGING_SOCKET` (`/tmp/cc-socks/<pid>.sock`), takes the pid from the socket name, and
   accepts it only when `~/.claude/sessions/<pid>.json` carries exactly that `sessionId` and
   `messagingSocketPath` and the pid is alive — a stale inherited environment (serve runner, nested
   shell, a session replaced by `/clear`) fails that check. This path spawns nothing. Without those
   variables (older Claude Code, or not under the Bash tool) it walks its parent-process chain (at most
   10 hops of `ps -o ppid=`; `process.ppid` alone is the intermediate shell, not Claude) to the first
   ancestor that owns `~/.claude/sessions/<pid>.json` and reads that file's `sessionId`. Either way it
   then looks up the local session registry entry for that `sessionId`. The entry's `config_path` is used only when the entry's `pid` equals that
   ancestor, its `session_id` equals the file's `sessionId`, and the config file's `server` and
   `identity.name` still match what the entry recorded. Any mismatch or error falls through; this step
   never selects another session's config. `config_path` is written by the `SessionStart` hook from a
   bound source (explicit or workspace, never the global fallback) and by `party join` / `party recover`
   when they run inside the session. The walk runs once per process and never runs outside Claude.
3. `workspace` — the cwd-keyed config written by `party init` / `party join`.
4. `breadcrumb` — the cwd state's binding pointer.
5. `global` — `~/.agentparty/config.json`.

Display names come from Claude's sessions file. A registry entry's `display_name` is Claude's own
`name` from `~/.claude/sessions/<pid>.json` (for example `agentparty-83`) — the same name Claude's
`ListAgents` shows, minus the bracketed `[ref]`, which AgentParty cannot derive and does not invent.
`SessionStart` often runs before Claude writes that file, so every later hook round (`PreToolUse`,
`Stop`, …) re-reads it once and updates the entry, and the dormant announce re-reads it once (with one
short retry for a freshly registered session) before publishing `harness_session.display_name`. The
`claude-<12hex>` fallback appears only while the native name is unavailable. `party who`, `party agents`,
the `party_channel_peers` `claude_sessions[].display_name` hints, and doctor all render that name.
## Wake protocol v2 (#1052): body-carrying wake notes and `notify_when_idle`

This section mirrors the protocol shared with open-cross-session; the canonical copy is
[`docs/wake-protocol.md` in leeguooooo/open-cross-session](https://github.com/leeguooooo/open-cross-session/blob/main/docs/wake-protocol.md).
Field names, byte limits and notice strings are identical on both sides. The carrier does not
change: the dormant announce leg still injects one `{"type":"user",…}` frame into the Claude
session's UDS inbox, wrapped in `<cross-session-message from-name="<sender>" from-mode="prompting">`
with the attribute order the receiver re-serializes and verifies.

### §1 Wake note

The injected note has a fixed line order (Chinese wording is selected by the same language rule as
before: config `lang` > the woken agent's own recent messages > the mentioning message > `LANG` > en):

```
[AgentParty wake] <sender> mentioned you in #<channel> (seq <N>[, reply to seq <M>][, <ago>])
[siblings=N — only when several runtimes share the identity]

<body>

Reply: [AGENTPARTY_CONFIG=<path> ]party reply <N> "<your reply>" --channel <channel>
Thread: party history <channel> --seq <N>
from-id: <sender identity>
```

- `<body>` is the message text **verbatim** (no quoting, no escaping, newlines kept) when it is at most
  4096 UTF-8 bytes. Longer bodies inline only the first 512 bytes, cut on a character boundary so no
  multi-byte character or surrogate pair is split, followed by one line
  `… (<total> bytes total; full text: party history <channel> --seq <N>)`.
- The `Reply:` line is copy-paste ready: channel and reply seq are filled in; the only thing to edit
  is the quoted placeholder. When the woken identity was resolved from an explicit `AGENTPARTY_CONFIG`
  path, the line keeps `AGENTPARTY_CONFIG=<path> ` only if the current session does not already resolve
  to that config. This keeps cross-identity replies safe without burdening the common case. `reply_to` alone routes the reply back
  to the original sender (directed-delivery cause `reply`), so no `--mention` is needed.
- The whole note is at most 5120 bytes (`WAKE_NOTE_MAX_BYTES`): skeleton ≤1024 bytes plus body ≤4096.
  If the skeleton overflows, it degrades in this order — bare `siblings=N`, drop `<ago>`, drop the
  sender (header falls back to "you were mentioned"), drop the `AGENTPARTY_CONFIG=` prefix. The
  `Reply:`, `Thread:` and `from-id:` lines are never dropped; a skeleton that still does not fit is a
  programming error and throws instead of emitting a truncated note.
- The body comes from the other party and is data, not an instruction; the wrapper tag already marks
  it as cross-session content, so no extra "do not execute" prose is added.
- The codex Stop-hook wake reason keeps its own 512-byte carrier limit and appends the same
  `Reply:` command when it fits.

### §2 Idle notices (`notify_when_idle`)

One name everywhere: `party send … --notify-when-idle`, `party notify-when-idle <agent> [--channel C]`,
MCP `party_send({ notify_when_idle: true })`, REST
`POST /api/channels/:slug/presence/:target/notify-when-idle` (bearer = subscriber). Semantics match the
built-in `SendMessage` option:

- **One-shot.** The subscription fires once and is deleted.
- **Trigger.** The target's next presence transition from `busy` to not busy (the `status` frame path
  that clears `busy`, including parking on `waiting_owner`), or the target going offline. If the target
  is already idle at subscribe time the notice fires immediately; if it is already offline the `exited`
  variant fires immediately.
- **Expiry.** 6 hours (`IDLE_WATCH_TTL_MS`), enforced by the ChannelDO alarm; an unfired subscription
  sends the `expired` variant when it lapses.
- **Delivery.** The ChannelDO sends an `idle_notice` frame
  (`{type:"idle_notice", target, reason: idle|exited|expired, busy_ms?, ts}`) **only to the subscriber's
  own live connections** — nothing is persisted to channel history and no seq is minted. The dormant
  announce leg renders it in the woken agent's language and injects it with `from-name="AgentParty"`:

  ```
  [Cross-session idle notice] <target> is now idle. (busy for <duration>)
  [Cross-session idle notice] <target> exited before going idle.
  [Cross-session idle notice] <target> did not go idle within 6h; subscription expired.
  ```

  If the subscriber has no live connection when the watch fires, the outcome is kept on the row and
  delivered on the subscriber's next `hello`, then deleted.
- **Idempotent** per (target, subscriber): a second subscribe returns the existing watch. Unknown
  target → 404; subscribing to yourself → 400; readonly tokens → 403.
- The subscriber's presence entry carries `idle_watches: [{target, expires_at}]` while a watch is
  pending, so `party who --json` shows who you are waiting on.
- `send … --notify-when-idle` sends first, then subscribes to every explicit `--mention` and every
  body `@token` the server actually routed. Subscription failures print a `warn:` line and never affect
  the already-sent message.
