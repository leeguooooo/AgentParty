import { parseAuthConfigPayload, type AuthProviderConfig } from "./oidc";
import { snapshotDesktopStorage } from "./desktopStorage";

const CUSTOM_PROFILES_KEY = "ap_server_profiles_v1";
const ACTIVE_ORIGIN_KEY = "ap_active_server_origin_v1";

export interface ServerProfileStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type ServerProfileMutationHandler = (storage: ServerProfileStorage) => void;

const snapshotServerProfileMutation: ServerProfileMutationHandler = (storage) => {
  void snapshotDesktopStorage(storage as Storage);
};

export interface ServerProfile {
  id: string;
  label: string;
  origin: string;
  kind: "official" | "custom";
}

export interface ServerProbeResult {
  origin: string;
  providers: AuthProviderConfig[];
}

export const LEEGUOOOOO_SERVER_ORIGIN = "https://agentparty.leeguoo.com";
export const XDREAMSTART_SERVER_ORIGIN = "https://agentparty.pwtk-dev.work";

export const OFFICIAL_SERVER_PROFILES: readonly ServerProfile[] = [
  {
    id: "official:prod",
    label: "leeguooooo",
    origin: LEEGUOOOOO_SERVER_ORIGIN,
    kind: "official",
  },
  {
    id: "official:test",
    label: "xdreamstart",
    origin: XDREAMSTART_SERVER_ORIGIN,
    kind: "official",
  },
];

export function isLeeguoooooDeployment(origin: string): boolean {
  return normalizeServerOrigin(origin) === LEEGUOOOOO_SERVER_ORIGIN;
}

// 约定只在私网内解析的域名后缀（RFC 6762 .local、ICANN 保留的 .internal、RFC 8375 home.arpa，
// 以及企业内网常用的 .lan / .intranet）。
const PRIVATE_HOST_SUFFIXES = [".local", ".internal", ".lan", ".home.arpa", ".intranet"];

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets as [number, number];
  return (
    a === 127 || // 回环
    a === 10 || // 10/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    (a === 169 && b === 254) || // 169.254/16 链路本地
    (a === 100 && b >= 64 && b <= 127) // 100.64/10 CGNAT（Tailscale 等）
  );
}

function isPrivateIpv6(host: string): boolean {
  if (host === "::1") return true;
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped !== null) {
    const octets = parseIpv4(mapped[1]!);
    return octets !== null && isPrivateIpv4(octets);
  }
  const first = host.split(":")[0] ?? "";
  if (!/^[0-9a-f]{1,4}$/.test(first)) return false;
  const seg = Number.parseInt(first, 16);
  return (seg & 0xfe00) === 0xfc00 || (seg & 0xffc0) === 0xfe80; // ULA fc00::/7、链路本地 fe80::/10
}

/**
 * 明文 http 的准入判定：只放行「流量出不了私网」的主机——回环、RFC1918、链路本地、CGNAT、
 * IPv6 ULA / 链路本地、内网域名后缀、无点单标签主机名。公网域名 / 公网 IP 仍然必须 https。
 * 内网私有部署（docs/self-host-intranet.md）从桌面端接入靠的就是这条。
 * 与桌面壳 desktop/src-tauri/src/private_network.rs 是同一条规则，改一处要改两处。
 */
export function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host.length === 0) return false;
  if (host === "localhost") return true;
  const ipv4 = parseIpv4(host);
  if (ipv4 !== null) return isPrivateIpv4(ipv4);
  if (host.includes(":")) return isPrivateIpv6(host);
  if (!host.includes(".")) return true; // 无点单标签主机名只能由内网 DNS / hosts 解析
  return PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export function normalizeServerOrigin(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isPrivateNetworkHost(url.hostname))) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function defaultStorage(): ServerProfileStorage {
  return localStorage;
}

function normalizeLabel(label: string): string | null {
  const value = label.trim().replace(/\s+/g, " ");
  return value.length > 0 && value.length <= 80 ? value : null;
}

function readCustomProfiles(storage: ServerProfileStorage): ServerProfile[] {
  try {
    const raw = JSON.parse(storage.getItem(CUSTOM_PROFILES_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    const seen = new Set(OFFICIAL_SERVER_PROFILES.map((profile) => profile.origin));
    const profiles: ServerProfile[] = [];
    for (const item of raw) {
      if (typeof item !== "object" || item === null) continue;
      const candidate = item as { label?: unknown; origin?: unknown };
      if (typeof candidate.label !== "string" || typeof candidate.origin !== "string") continue;
      const label = normalizeLabel(candidate.label);
      const origin = normalizeServerOrigin(candidate.origin);
      if (label === null || origin === null || seen.has(origin)) continue;
      seen.add(origin);
      profiles.push({ id: `custom:${origin}`, label, origin, kind: "custom" });
    }
    return profiles;
  } catch {
    return [];
  }
}

export function loadServerProfiles(storage: ServerProfileStorage = defaultStorage()): ServerProfile[] {
  return [...OFFICIAL_SERVER_PROFILES, ...readCustomProfiles(storage)];
}

export function addCustomServerProfile(
  storage: ServerProfileStorage = defaultStorage(),
  input: { label: string; origin: string },
  onMutation: ServerProfileMutationHandler = snapshotServerProfileMutation,
): ServerProfile[] {
  const label = normalizeLabel(input.label);
  const origin = normalizeServerOrigin(input.origin);
  if (label === null || origin === null) throw new Error("invalid server profile");
  const profiles = loadServerProfiles(storage);
  const official = OFFICIAL_SERVER_PROFILES.find((profile) => profile.origin === origin);
  if (official !== undefined) return profiles;
  const custom = profiles.filter((profile) => profile.kind === "custom" && profile.origin !== origin);
  custom.push({ id: `custom:${origin}`, label, origin, kind: "custom" });
  storage.setItem(CUSTOM_PROFILES_KEY, JSON.stringify(custom.map(({ label: nextLabel, origin: nextOrigin }) => ({
    label: nextLabel,
    origin: nextOrigin,
  }))));
  onMutation(storage);
  return [...OFFICIAL_SERVER_PROFILES, ...custom];
}

export function loadActiveServerOrigin(storage: ServerProfileStorage = defaultStorage()): string {
  const profiles = loadServerProfiles(storage);
  const stored = normalizeServerOrigin(storage.getItem(ACTIVE_ORIGIN_KEY) ?? "");
  return profiles.some((profile) => profile.origin === stored)
    ? stored ?? OFFICIAL_SERVER_PROFILES[0]!.origin
    : OFFICIAL_SERVER_PROFILES[0]!.origin;
}

export function saveActiveServerOrigin(
  storage: ServerProfileStorage = defaultStorage(),
  input: string,
  onMutation: ServerProfileMutationHandler = snapshotServerProfileMutation,
): string {
  const origin = normalizeServerOrigin(input);
  if (origin === null || !loadServerProfiles(storage).some((profile) => profile.origin === origin)) {
    throw new Error("server profile is not registered");
  }
  storage.setItem(ACTIVE_ORIGIN_KEY, origin);
  onMutation(storage);
  return origin;
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function fetchWithoutCrossOriginRedirect(
  origin: string,
  path: string,
  fetcher: Fetcher,
): Promise<Response> {
  let target = `${origin}${path}`;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetcher(target, { redirect: "manual", headers: { accept: "application/json" } });
    if (response.type === "opaqueredirect") throw new Error("server redirect could not be verified");
    if (response.status < 300 || response.status >= 400) return response;
    const locationHeader = response.headers.get("location");
    if (locationHeader === null) throw new Error("server redirect is invalid");
    const next = new URL(locationHeader, target);
    if (next.origin !== origin) throw new Error("server redirect changed origin");
    target = next.toString();
  }
  throw new Error("server redirected too many times");
}

export async function probeServerProfile(input: string, fetcher: Fetcher = fetch): Promise<ServerProbeResult> {
  const origin = normalizeServerOrigin(input);
  if (origin === null) throw new Error("server origin is invalid");
  const health = await fetchWithoutCrossOriginRedirect(origin, "/api/health", fetcher);
  if (!health.ok) throw new Error(`server health check failed (${health.status})`);
  const config = await fetchWithoutCrossOriginRedirect(origin, "/api/config", fetcher);
  if (!config.ok) throw new Error(`server config check failed (${config.status})`);
  const auth = parseAuthConfigPayload(await config.json());
  return { origin, providers: auth.providers };
}
