import type { DesktopTokenResponse } from "./desktopCredentials";

export interface DesktopPairingSecrets {
  codeVerifier: string;
  codeChallenge: string;
  deviceSecret: string;
  deviceChallenge: string;
}

export type DesktopPairingPhase =
  | "idle"
  | "creating"
  | "pending"
  | "slow_down"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled"
  | "error";

export interface DesktopPairingState {
  phase: DesktopPairingPhase;
  intervalSeconds: number;
  error: string | null;
}

export type DesktopPairingEvent =
  | { type: "start" }
  | { type: "created"; intervalSeconds: number }
  | { type: "authorization_pending" }
  | { type: "slow_down"; retryAfterSeconds?: number }
  | { type: "approved" }
  | { type: "denied" }
  | { type: "expired" }
  | { type: "cancel" }
  | { type: "fail"; message: string };

export interface PairDeepLink {
  userCode: string;
  serverOrigin: string | null;
}

export interface DesktopPairingResponse {
  pairing_id: string;
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: 300;
  interval: 3;
}

export interface DesktopDeviceMetadata {
  name: string;
  platform: string;
  appVersion: string;
}

export type DesktopTokenPollResult =
  | { type: "authorization_pending" }
  | { type: "slow_down"; retryAfterSeconds?: number }
  | { type: "denied" }
  | { type: "expired" }
  | { type: "approved"; tokens: DesktopTokenResponse };

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export async function createDesktopPairingSecrets(
  randomBytes: (length: number) => Uint8Array = (length) => crypto.getRandomValues(new Uint8Array(length)),
): Promise<DesktopPairingSecrets> {
  const codeVerifier = base64Url(randomBytes(32));
  const deviceSecret = base64Url(randomBytes(32));
  const [codeChallenge, deviceChallenge] = await Promise.all([
    pkceChallenge(codeVerifier),
    pkceChallenge(deviceSecret),
  ]);
  return { codeVerifier, codeChallenge, deviceSecret, deviceChallenge };
}

export function normalizePairingCode(input: string): string | null {
  const compact = input.trim().toUpperCase().replace(/[\s-]/g, "");
  if (!/^[A-Z0-9]{10}$/.test(compact)) return null;
  return `${compact.slice(0, 5)}-${compact.slice(5)}`;
}

function normalizeOrigin(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isAllowlistedServerOrigin(origin: string, allowedOrigins: readonly string[]): boolean {
  const normalized = normalizeOrigin(origin);
  return normalized !== null && allowedOrigins.some((allowed) => normalizeOrigin(allowed) === normalized);
}

export function parsePairDeepLink(input: string, allowedOrigins: readonly string[]): PairDeepLink | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "agentparty:" || url.hostname !== "pair" || url.username || url.password || url.hash) {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1) return null;
  const userCode = normalizePairingCode(segments[0] ?? "");
  if (userCode === null) return null;

  const allowedParameters = new Set(["server"]);
  for (const key of url.searchParams.keys()) {
    if (!allowedParameters.has(key)) return null;
  }
  const server = url.searchParams.get("server");
  if (server !== null && !isAllowlistedServerOrigin(server, allowedOrigins)) return null;
  return { userCode, serverOrigin: server === null ? null : normalizeOrigin(server) };
}

export function resolveAllowedVerificationUrl(
  input: string,
  allowedOrigins: readonly string[],
): string | null {
  try {
    const url = new URL(input);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
    if (!isAllowlistedServerOrigin(url.origin, allowedOrigins)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function createDesktopPairing(
  serverOrigin: string,
  secrets: DesktopPairingSecrets,
  device: DesktopDeviceMetadata,
  fetcher: Fetcher = fetch,
): Promise<DesktopPairingResponse> {
  const response = await fetcher(`${serverOrigin}/api/desktop/pairings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code_challenge: secrets.codeChallenge,
      code_challenge_method: "S256",
      device_secret_challenge: secrets.deviceChallenge,
      device: {
        name: device.name,
        platform: device.platform,
        app_version: device.appVersion,
      },
    }),
  });
  if (!response.ok) throw new Error(`desktop pairing creation failed (${response.status})`);
  const pairing = (await response.json()) as DesktopPairingResponse;
  if (
    !pairing.pairing_id ||
    !pairing.device_code ||
    normalizePairingCode(pairing.user_code) === null ||
    !pairing.verification_uri_complete ||
    pairing.expires_in !== 300 ||
    pairing.interval !== 3
  ) {
    throw new Error("desktop pairing response is invalid");
  }
  return { ...pairing, user_code: normalizePairingCode(pairing.user_code) ?? pairing.user_code };
}

export async function exchangeDesktopPairingToken(
  serverOrigin: string,
  deviceCode: string,
  codeVerifier: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<DesktopTokenPollResult> {
  let response: Response;
  try {
    response = await fetcher(`${serverOrigin}/api/desktop/pairings/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: deviceCode, code_verifier: codeVerifier }),
      signal,
    });
  } catch (cause) {
    throw new DesktopPairingExchangeNetworkError(cause);
  }
  switch (response.status) {
    case 202:
      return { type: "authorization_pending" };
    case 429: {
      const raw = response.headers.get("retry-after");
      const retryAfterSeconds = raw === null ? undefined : Number.parseInt(raw, 10);
      return Number.isFinite(retryAfterSeconds)
        ? { type: "slow_down", retryAfterSeconds }
        : { type: "slow_down" };
    }
    case 403:
      return { type: "denied" };
    case 410:
      return { type: "expired" };
    case 200: {
      const tokens = (await response.json()) as DesktopTokenResponse;
      if (!tokens.access_token || !tokens.refresh_token) {
        throw new Error("desktop token response is incomplete");
      }
      return { type: "approved", tokens };
    }
    default:
      throw new Error(`desktop pairing token exchange failed (${response.status})`);
  }
}

export class DesktopPairingExchangeNetworkError extends Error {
  constructor(cause: unknown) {
    super("desktop pairing token exchange network failed", { cause });
    this.name = "DesktopPairingExchangeNetworkError";
  }
}

export type DesktopPollingResult =
  | Extract<DesktopTokenPollResult, { type: "approved" | "denied" | "expired" }>
  | { type: "cancelled" };

interface DesktopPollingOptions {
  intervalSeconds: number;
  expiresInSeconds: number;
  signal: AbortSignal;
  wait(seconds: number, signal: AbortSignal): Promise<void>;
  exchange(signal: AbortSignal): Promise<DesktopTokenPollResult>;
  onEvent(event: DesktopTokenPollResult): void;
  now?: () => number;
}

export async function pollDesktopPairing(options: DesktopPollingOptions): Promise<DesktopPollingResult> {
  let intervalSeconds = Math.max(1, options.intervalSeconds);
  const now = options.now ?? Date.now;
  const pairingDeadline = now() + options.expiresInSeconds * 1000;
  let deadline = pairingDeadline;
  while (!options.signal.aborted) {
    if (now() >= deadline) return { type: "expired" };
    await options.wait(intervalSeconds, options.signal);
    if (options.signal.aborted) return { type: "cancelled" };
    if (now() >= deadline) return { type: "expired" };
    let result: DesktopTokenPollResult;
    try {
      result = await options.exchange(options.signal);
    } catch (cause) {
      if (options.signal.aborted) return { type: "cancelled" };
      if (cause instanceof DesktopPairingExchangeNetworkError) {
        // A request made before the pairing deadline may have committed even if its
        // response was lost. Keep one bounded server recovery window after expiry.
        deadline = Math.max(deadline, pairingDeadline + 60_000);
        continue;
      }
      throw cause;
    }
    options.onEvent(result);
    if (result.type === "approved" || result.type === "denied" || result.type === "expired") {
      return result;
    }
    if (result.type === "slow_down") {
      intervalSeconds = Math.max(intervalSeconds + 3, result.retryAfterSeconds ?? 0);
    }
  }
  return { type: "cancelled" };
}

export function reducePairingState(
  state: DesktopPairingState,
  event: DesktopPairingEvent,
): DesktopPairingState {
  switch (event.type) {
    case "start":
      return { phase: "creating", intervalSeconds: 3, error: null };
    case "created":
      return { phase: "pending", intervalSeconds: Math.max(1, event.intervalSeconds), error: null };
    case "authorization_pending":
      return state.phase === "slow_down" ? { ...state, phase: "pending" } : state;
    case "slow_down":
      return {
        phase: "slow_down",
        intervalSeconds: Math.max(state.intervalSeconds + 3, event.retryAfterSeconds ?? 0),
        error: null,
      };
    case "approved":
    case "denied":
    case "expired":
      return { ...state, phase: event.type, error: null };
    case "cancel":
      return { ...state, phase: "cancelled", error: null };
    case "fail":
      return { ...state, phase: "error", error: event.message };
  }
}

const singleFlights = new Map<string, Promise<unknown>>();

export function runSingleFlight<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const active = singleFlights.get(key) as Promise<T> | undefined;
  if (active !== undefined) return active;
  const promise = operation().finally(() => {
    if (singleFlights.get(key) === promise) singleFlights.delete(key);
  });
  singleFlights.set(key, promise);
  return promise;
}

export function __resetDesktopPairingSingleFlightsForTests(): void {
  singleFlights.clear();
}
