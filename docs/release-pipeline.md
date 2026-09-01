# Release pipeline

Maintainer material: how a `v*` tag turns into a published Release, and what gates it.
Nothing here is needed to install or use AgentParty.

## Plugin install verification

Maintainers can exercise the real local add/install/enable/cache-copy path without a model call:

```sh
bun scripts/verify-agentparty-plugin-install.ts
bun scripts/verify-agentparty-plugin-install.ts --claude-package-version 2.1.154
```

Required CI runs both strict validation and this isolated install flow with Claude 2.1.154 and
2.1.232. The version flag accepts only an exact stable semver and expands to a fixed
`bunx @anthropic-ai/claude-code@VERSION` launcher; it cannot carry arbitrary model-launch arguments.
Acceptance also requires the executable's leading semantic version to equal the request and reports
`claude_version_matches_request=true`; a cache or wrapper resolving another version fails closed.
On a `v*` tag, Worker deployment and GitHub Release start concurrently, but publication is now gated:
the release job polls `worker-deploy.yml` for the newest run bound to the exact tag and 40-character
commit SHA, and proceeds only after the whole workflow—including authenticated runtime-peers v3 live
smoke—completes successfully. A missing, failed, cancelled, or 30-minute-stalled deploy prevents any
Release upload; an older successful deploy cannot satisfy the gate.
Worker deployment identity is the exact `version + commit`; `deployed_at` remains audit metadata, not
a correctness key. An idempotent redeploy or custom-domain propagation may expose another timestamp
for the same build. After identity matches, the authenticated two-socket runtime smoke proves that the
live endpoint actually serves v3, so relaxing timestamp equality does not weaken protocol acceptance.

## Skipping checks the same commit already passed

A `v*` tag points at the commit that just ran the full gate on `main`, so the tag run reuses that
verdict instead of running the same checks twice. The `prior-green` job accepts evidence only from a
run of this workflow on the **same commit SHA** that was a `push` on `main` whose aggregate
`full check` job succeeded; a pull-request run does not count, because a PR may take the CLI-only
fast path where non-CLI checks are skipped. Anything else — no evidence, an API error, a red main —
makes every check run normally.

Only the *steps* are skipped; each job still reports success, so the `needs` graph and every job
conclusion are unchanged. `version-contract` never skips: it validates the tag itself, which is new
information the `main` run cannot produce.

`scripts/release.sh` therefore waits for `main`'s `full check` on the release commit before pushing
the tag. A red `main` means no tag is pushed at all. If the verdict cannot be read — API failure,
timeout, or an origin that is not GitHub — the tag is pushed anyway and the tag run simply runs every
check itself.
