import { isAbsolute, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createGrokPool, type PoolCredential, type PoolEvent } from "./grok-pool-gateway";

const LOOPBACK = "127.0.0.1";
const MAX_DURATION_SECONDS = 600;

export interface GrokPoolConfig {
  credentials: PoolCredential[];
  clientToken: string;
  baseUrl: string;
  host: typeof LOOPBACK;
  port: number;
  cooldownMs: number;
  transientCooldownMs: number;
  timeoutMs: number;
}

export interface StartGrokPoolServerOptions {
  env?: Record<string, string | undefined>;
  port?: number;
  logger?: (event: PoolEvent) => void;
}

export interface RunningGrokPoolServer {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  config: GrokPoolConfig;
  stop(): void;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value: string | undefined, name: string, fallback: number, max: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  if (parsed > max) throw new Error(`${name} must not exceed 10 minutes`);
  return parsed;
}

function isVersionControlled(path: string): boolean {
  const absolute = resolve(path);
  const result = spawnSync("git", ["ls-files", "--error-unmatch", absolute], {
    cwd: process.cwd(),
    stdio: "ignore",
  });
  if (result.status === 0) return true;
  const relativeResult = spawnSync("git", ["ls-files", "--error-unmatch", path], {
    cwd: process.cwd(),
    stdio: "ignore",
  });
  return relativeResult.status === 0;
}

function parseCredentials(value: unknown): PoolCredential[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("credential pool must be a non-empty JSON array");
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`credential at index ${index} must be an object`);
    const id = "id" in entry && typeof entry.id === "string" ? entry.id.trim() : "";
    const token = "token" in entry && typeof entry.token === "string" ? entry.token : "";
    if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`credential at index ${index} has an invalid safe id`);
    if (seen.has(id)) throw new Error(`duplicate credential id: ${id}`);
    if (!token.trim()) throw new Error(`credential ${id} has an invalid token`);
    seen.add(id);
    return { id, secret: token };
  });
}

export async function loadGrokPoolConfig(env: Record<string, string | undefined> = process.env): Promise<GrokPoolConfig> {
  const credentialsFile = required(env, "GROK_POOL_CREDENTIALS_FILE");
  if (isVersionControlled(credentialsFile)) throw new Error("GROK_POOL_CREDENTIALS_FILE must not be version controlled");
  const host = env.GROK_POOL_HOST?.trim() || LOOPBACK;
  if (host !== LOOPBACK) throw new Error(`GROK_POOL_HOST must be ${LOOPBACK}`);
  const port = positiveInteger(env.GROK_POOL_PORT, "GROK_POOL_PORT", 8789, 65_535);
  const cooldownSeconds = positiveInteger(env.GROK_POOL_COOLDOWN_SECONDS, "GROK_POOL_COOLDOWN_SECONDS", 60, MAX_DURATION_SECONDS);
  const transientSeconds = positiveInteger(env.GROK_POOL_TRANSIENT_COOLDOWN_SECONDS, "GROK_POOL_TRANSIENT_COOLDOWN_SECONDS", 5, MAX_DURATION_SECONDS);
  const timeoutSeconds = positiveInteger(env.GROK_POOL_TIMEOUT_SECONDS, "GROK_POOL_TIMEOUT_SECONDS", 120, MAX_DURATION_SECONDS);
  let payload: unknown;
  try {
    payload = JSON.parse(await readFile(isAbsolute(credentialsFile) ? credentialsFile : resolve(credentialsFile), "utf8"));
  } catch {
    throw new Error("unable to read valid credential JSON from GROK_POOL_CREDENTIALS_FILE");
  }
  const baseUrl = required(env, "GROK_POOL_BASE_URL").replace(/\/+$/, "");
  const upstream = new URL(baseUrl);
  if (!/^https?:$/.test(upstream.protocol)) throw new Error("GROK_POOL_BASE_URL must use http or https");
  return {
    credentials: parseCredentials(payload),
    clientToken: required(env, "GROK_POOL_CLIENT_TOKEN"),
    baseUrl,
    host: LOOPBACK,
    port,
    cooldownMs: cooldownSeconds * 1_000,
    transientCooldownMs: transientSeconds * 1_000,
    timeoutMs: timeoutSeconds * 1_000,
  };
}

function authorized(request: Request, token: string): boolean {
  return request.headers.get("authorization") === `Bearer ${token}`;
}

function unauthorized(): Response {
  return Response.json({ error: { code: "unauthorized", message: "Valid pool client authorization is required" } }, { status: 401 });
}

function upstreamRequest(config: GrokPoolConfig, incoming: Request, credential: PoolCredential): Request {
  const headers = new Headers(incoming.headers);
  headers.set("authorization", `Bearer ${credential.secret}`);
  headers.delete("host");
  headers.delete("content-length");
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const signal = AbortSignal.any([incoming.signal, timeout]);
  return new Request(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: incoming.body,
    signal,
    duplex: "half",
  } as RequestInit);
}

async function bufferRequest(request: Request): Promise<{ signal: AbortSignal; clone(): Request }> {
  const body = await request.arrayBuffer();
  const headers = new Headers(request.headers);
  return {
    signal: request.signal,
    clone: () => new Request(request.url, {
      method: request.method,
      headers,
      body: body.slice(0),
      signal: request.signal,
    }),
  };
}

export async function startGrokPoolServer(options: StartGrokPoolServerOptions = {}): Promise<RunningGrokPoolServer> {
  const config = await loadGrokPoolConfig(options.env ?? process.env);
  const pool = createGrokPool({
    credentials: config.credentials,
    cooldownMs: config.cooldownMs,
    transientCooldownMs: config.transientCooldownMs,
    logger: options.logger,
  });
  const server = Bun.serve({
    hostname: config.host,
    port: options.port ?? config.port,
    async fetch(request) {
      const url = new URL(request.url);
      if (!authorized(request, config.clientToken)) return unauthorized();
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true, credentials: pool.snapshot() });
      }
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
      }
      const replayable = await bufferRequest(request);
      return pool.handle(replayable, (credential, cloned) => fetch(upstreamRequest(config, cloned, credential)));
    },
  });
  return {
    server,
    url: `http://${config.host}:${server.port}`,
    config,
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const running = await startGrokPoolServer({ logger: (event) => console.log(JSON.stringify(event)) });
  console.log(JSON.stringify({ event: "grok_pool_started", url: running.url }));
  const shutdown = () => {
    running.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
