# Claude plugin: launcher, opt-ins, and verifiers

中文版：[claude-plugin.zh.md](claude-plugin.zh.md)

How `party claude` and the Marketplace plugin actually behave. The README only covers installing
them; this page is the contract.

Start here: [Install](../README.md#install) · [Attach live Claude sessions](../README.md#attach-live-claude-sessions)

## What the shell arms, and what it refuses

The Claude shell bundles the Skill, generic MCP tools, a durable channel MCP, and lifecycle hooks
that publish working/tool/waiting/idle activity. A conditional Stop guard gives an execution already
delivered to Claude one continuation to produce its linked reply. Channel events can wake an open idle session; they
cannot revive a closed process, so always-on use still needs a background Claude process or persistent
terminal. Cross-session correlation still uses the per-launch private Hook and MCP injected by
`party bridge claude`. The Codex shell keeps only the generic Skill and MCP entry.
If Stop is blocked for an unfinished linked reply, presence stays `working`; `idle` is published only
when Stop is actually allowed, so the continuation is not shown as a finished agent.
The bundled launcher does not assume that Claude inherited an interactive shell PATH. It resolves
`party` from PATH, `~/.local/bin`, Homebrew, or the desktop sidecar. If no runtime exists, it prints
the install plus `/reload-plugins` recovery steps and never downloads a binary from an MCP or hook startup.
The Channel MCP stays dormant during ordinary Claude launches: it neither connects to AgentParty nor
claims the durable-listener lock until `party claude` supplies the one-shot opt-in. The launcher first
runs a no-model preflight: the plugin must be enabled, the current credential must identify an agent,
the channel must be accessible, and the same identity/channel cannot already have a listener. It refuses
to open a Claude session that would look active without actually listening. Choose one entry
point per launch: use `party claude <channel>` for the ordinary durable Channel, or
`party bridge claude <channel>` when Cross-session is required. Do not
stack the plugin Channel onto the same bridged launch.
Channel and lifecycle activation use separate opt-ins. `party claude` arms both; `party bridge
claude` arms the Marketplace lifecycle hooks only while retaining its bridge-owned Channel MCP.
An ordinary Claude launch arms neither, so it cannot overwrite the active listener's tool/waiting
presence or inherit another session's unfinished Stop debt.
Each detached activity publish binds its throttle marker to a random attempt ID. Spawn, auth, or
REST failure releases only that attempt so the next Hook retries immediately; a late older failure
cannot invalidate a newer successful marker.
Activity follows Claude's dedicated `PermissionRequest`, `Elicitation`, tool-failure, compaction,
and turn-failure events instead of relying only on notification text. Entering or leaving a wait and
ending a turn bypass the ordinary 15-second publish throttle, while repeated notifications in the
same wait remain throttled. `party who` carries interactive activity even when there is no serve
`current_task`. This telemetry is deliberately not a transcript: it exposes phase and tool name only,
never prompt text or tool arguments; exact work remains the linked Channel seq or an explicitly declared scope.
The bridge now treats that lifecycle shell as a real launch prerequisite: `party bridge claude`
refuses a missing, disabled, version-mismatched, or invalid Plugin instead of opening a
Cross-session-capable session with no activity visibility or Stop guard. `--check --json` reports the
Plugin-only result under `lifecycle` alongside auth, Channel, runtime-topology, and gate evidence, and
always declares `model_calls_started=false`. When this prerequisite is the primary failure, the
top-level reason is `plugin_lifecycle_unavailable`, while `lifecycle.blockers` retains the exact cause.

## Readiness audit and acceptance verifiers

Run the user-side, no-model readiness audit with:

```sh
party doctor claude-plugin --channel <channel> --json
```

It checks plugin installation and enablement, the cached bundle and launcher, AgentParty auth and
channel access, and whether the server actually observes a durable listener for this identity.
`identity_not_agent`, `plugin_missing`, `listener_not_observed`, and `listener_deaf` are separate failures.
If the listener is healthy but no recent Hook activity is visible, the report adds an
`activity_not_observed` warning instead of conflating message reception with lifecycle visibility.
For an observed listener it also reports `channel.topology_visibility`. `observed` means the Worker
compared this read-only diagnostic topology with at least one live runtime of the same identity;
`topology_not_observed` and `topology_unavailable` are warnings, not reception blockers. They mean
same-installation/workspace/worktree coordination hints are unavailable even though Channel delivery
may still work. The diagnostic never creates or repairs the private installation secret.

To prove the durable Marketplace Channel itself still receives work while Claude is busy, use the
separate busy-session verifier:

```sh
party claude --verify --channel dev \
  --receiver-config /path/to/receiver.json \
  --sender-config /path/to/sender.json \
  --receiver-cwd /path/to/receiver-worktree \
  --preflight-only
```

`--preflight-only` makes no model call or Channel write. Replace it with explicit `--live` only when
one real Claude model session and durable test messages are authorized; the source and reply remain
in Channel history and audit. Full acceptance launches the receiver through `party claude`, observes its live Bash
activity, persists a durable mention while Bash is running, and requires exactly one plugin-scoped
`party_channel_claim → party_channel_accept → party_channel_reply` chain plus one exact linked reply.
Its evidence separates `busy_activity_observed_before_send`, `source_message_persisted`,
`linked_reply_persisted`, `claim_accept_reply_chain_observed`, and `delivery_terminal_settled`.
The last flag requires the plugin reply tool result to name the exact persisted reply seq and source
seq; that MCP result is emitted only after the Worker accepts the authoritative terminal delivery
state. This proves busy durable Channel
reception; the Cross-session verifier proves a different transport and cannot substitute.
Preflight reports Plugin, Claude auth/version, both identities, both channel-access checks, identity
conflict, an existing receiver listener, and Worker support for both `directed_delivery v1` and
`delivery_recovery v1` together. The capability probe opens one bounded socket, reads welcome, and
closes without registering an adapter, claiming, acknowledging, or sending work. Any blocker keeps
`model_calls_started=false` and `channel_writes_started=false`. Full mode refuses to send the mention unless busy Bash activity was
first observed; that failure is `busy_activity_not_observed`, with redacted process evidence only in
the returned artifact directory.
Failure reports set `model_calls_started=true` only after one unique Claude `system/init` is observed.
No launcher spawn is false; a spawned launcher without conclusive stream initialization is `unknown`,
not an invented model-call claim.
If live execution fails after the Channel write begins, the verifier recovers a lost POST response by
polling briefly for one exact sender/body marker. No match is retried because the Worker commit may
lag the client timeout; multiple matches fail closed instead of guessing. It then retries source retraction and verifies the returned message is
`[retracted]`. Worker retract atomically terminal-fails the active delivery tree as
`source_retracted`, preventing replay after the private journal is deleted. Reports expose
`source_cleanup=not_needed|retracted|not_found_or_unconfirmed|failed` and preserve a known source seq
for manual cleanup when automatic retraction cannot be proved.
The last two states also set `cleanup_required=true` and expose only the non-secret
`cleanup_search_marker`. Use the sender identity to run `party search <marker> --channel <channel>`,
confirm one exact source, then `party retract <seq> --channel <channel>`; token and config paths never
enter the report.
