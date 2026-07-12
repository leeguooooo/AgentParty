# Grok Pool Gateway

`grok-pool-gateway` is a loopback-only OpenAI-compatible gateway for Grok credentials that the operator owns or is explicitly authorized to use. Clients keep one local Base URL while the gateway can make at most one credential fallback before returning a stable `503 pool_exhausted` error.

It is an independent local process. It does not change AgentParty Worker, Web, TaskRun leases, identities, permissions, workspaces, or runtime-level model fallback.

## Security boundaries

- The server always binds `127.0.0.1`. `GROK_POOL_HOST` is optional, but any value other than `127.0.0.1` is rejected.
- The credential file must be local, outside Git or under the ignored `.secrets/` directory. It is never uploaded.
- `/health` and `/v1/chat/completions` require the same `GROK_POOL_CLIENT_TOKEN` bearer token.
- Client `Authorization` is discarded and replaced with the selected upstream token.
- Logs and health data contain only safe credential IDs, state, status classification, cooldown deadline, and counts. They never contain tokens, request bodies, or upstream error bodies.
- There is no remote credential upload API, public-forum scanner, account registration, verification bypass, or credential trading support.

## Configuration

Copy the placeholder examples into the ignored `.secrets/` directory:

```bash
mkdir -p .secrets
cp docs/examples/grok-pool.credentials.example.json .secrets/grok-pool.credentials.json
cp docs/examples/grok-pool.authorized-sources.example.json .secrets/grok-pool.authorized-sources.json
chmod 600 .secrets/grok-pool.credentials.json .secrets/grok-pool.authorized-sources.json
```

Credential file schema:

```json
[
  { "id": "operator-primary", "token": "<AUTHORIZED_GROK_TOKEN>" },
  { "id": "operator-backup", "token": "<AUTHORIZED_GROK_BACKUP_TOKEN>" }
]
```

Required environment:

```bash
export GROK_POOL_CREDENTIALS_FILE="$PWD/.secrets/grok-pool.credentials.json"
export GROK_POOL_CLIENT_TOKEN="<LOCAL_CLIENT_TOKEN>"
export GROK_POOL_BASE_URL="https://<AUTHORIZED_GROK_OPENAI_COMPATIBLE_ORIGIN>"
```

Optional environment:

| Variable | Default | Constraint |
|---|---:|---|
| `GROK_POOL_PORT` | `8789` | positive TCP port |
| `GROK_POOL_HOST` | `127.0.0.1` | must remain `127.0.0.1` |
| `GROK_POOL_COOLDOWN_SECONDS` | `60` | `1..600` |
| `GROK_POOL_TRANSIENT_COOLDOWN_SECONDS` | `5` | `1..600` |
| `GROK_POOL_TIMEOUT_SECONDS` | `120` | `1..600` |

Start the process:

```bash
bun run scripts/grok-pool-server.ts
```

Use `http://127.0.0.1:8789/v1` as the OpenAI-compatible Base URL.

## AgentParty-compatible local smoke

This smoke uses the same OpenAI-compatible request shape as AgentParty clients. Run it only when the configured credentials and upstream are operator-owned or registered as explicitly authorized:

```bash
curl --fail-with-body --silent --show-error \
  http://127.0.0.1:8789/v1/chat/completions \
  -H "Authorization: Bearer ${GROK_POOL_CLIENT_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"model":"<AUTHORIZED_GROK_MODEL>","stream":false,"messages":[{"role":"user","content":"Reply with exactly: GROK_POOL_SMOKE_OK"}]}'
```

Automated tests use local HTTP fixtures and fake tokens only. A real smoke is optional and operator-initiated.

## Failure matrix

| Upstream result | Credential state | Request behavior |
|---|---|---|
| any `2xx` | remains `healthy` | response status, headers, body, and SSE stream pass through |
| `401/403` containing `personal-team-blocked:spending-limit` | `exhausted` | try one fallback before any success response |
| other `401/403` | `revoked` | try one fallback before any success response |
| `429` | `cooldown` for the configured rate-limit period | try one fallback; lazily becomes healthy after deadline |
| `5xx`, timeout, or network error | `cooldown` for the transient period | try one fallback |
| client abort | unchanged | abort current fetch; do not fallback |
| no candidate or both attempts fail | unchanged beyond classified failures | return `503` with `error.code=pool_exhausted` |
| successful SSE followed by downstream/upstream interruption | remains as recorded at initial success | never replay |

## Authorized replenish

The manifest must register a stable source ID and exact topic and attachment URLs. There is no wildcard site scan. The command downloads only the registered attachment into the configured staging directory, validates ZIP magic and limits, rejects path traversal, validates every credential JSON, deduplicates, and atomically replaces the target directory. Staging is cleaned on success and failure.

```bash
python3 scripts/linuxdo_grok_replenish.py replenish \
  .secrets/grok-pool.authorized-sources.json \
  <REGISTERED_SOURCE_ID>
```

An optional `--attachment-url` must exactly equal the URL already registered in the manifest. V1 accepts ZIP archives only; HTML/challenge pages, mislabeled files, 7z/tar archives, invalid JSON, excessive compressed/extracted size, excessive file count, and unsafe paths fail closed without modifying the target directory.

The older manual local-copy flow remains available for an already extracted directory:

```bash
python3 scripts/linuxdo_grok_replenish.py import-local \
  <AUTHORIZED_EXTRACTED_DIRECTORY> \
  <TARGET_CREDENTIAL_DIRECTORY> \
  --authorized
```

## Health

```bash
curl --fail-with-body --silent --show-error \
  http://127.0.0.1:8789/health \
  -H "Authorization: Bearer ${GROK_POOL_CLIENT_TOKEN}"
```

The response contains `ok` and per-safe-ID state/counts only. Runtime health state is intentionally in memory and resets on restart.
