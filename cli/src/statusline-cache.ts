import type { MsgFrame } from "@agentparty/shared";
import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentpartyHome, readConfig, readState, workspaceId, type CachedIdentity } from "./config";
import type { Identity } from "./rest";

export interface StatuslineIdentity {
  name: string;
  kind: string;
  role: string;
}

export interface StatuslineLastMessage {
  from: string;
  ts: number;
  preview: string;
}

export interface StatuslineListener {
  mode: "watch" | "serve";
  pid: number;
  heartbeat_ts: number;
  /** True when `party watch --mentions-only` — the listener hears only
   * messages that @-mention this agent. Status bars used to recover this by
   * forking `ps` and grepping the listener's argv; carry it in the contract
   * instead. Omitted (not false) when the listener hears everything. */
  mentions_only?: true;
}

export interface StatuslineCache {
  v: 1;
  channel?: string;
  server?: string;
  identity?: StatuslineIdentity;
  unread?: number;
  tasks?: {
    mine_active: number;
    mine_total: number;
  };
  last_message?: StatuslineLastMessage;
  listener?: StatuslineListener;
  updated_at: number;
}

export type StatuslinePatch = Partial<Omit<StatuslineCache, "v" | "updated_at" | "last_message" | "listener">> & {
  last_message?: StatuslineLastMessage | null;
  listener?: StatuslineListener | null;
};

const PREVIEW_MAX = 48;

export function statuslineCachePath(cwd: string = process.cwd()): string {
  return join(agentpartyHome(), "state", workspaceId(cwd), "statusline.json");
}

export function readStatuslineCache(cwd: string = process.cwd()): StatuslineCache | null {
  try {
    const body = JSON.parse(readFileSync(statuslineCachePath(cwd), "utf8")) as StatuslineCache;
    return body.v === 1 ? body : null;
  } catch {
    return null;
  }
}

export function statuslineIdentity(identity: CachedIdentity | Identity | undefined | null): StatuslineIdentity | undefined {
  if (!identity) return undefined;
  return {
    name: identity.name,
    kind: identity.kind,
    role: identity.role,
  };
}

export function cachedIdentity(identity: Identity, now: number = Date.now()): CachedIdentity {
  return {
    name: identity.name,
    email: identity.email,
    kind: identity.kind,
    role: identity.role,
    owner: identity.owner,
    channel_scope: identity.channel_scope ?? null,
    verified_at: now,
  };
}

export function localStatuslineBase(channel?: string | null): StatuslinePatch {
  const cfg = readConfig();
  return {
    ...(channel ? { channel } : {}),
    ...(cfg?.server ? { server: cfg.server } : {}),
    ...(cfg?.identity ? { identity: statuslineIdentity(cfg.identity) } : {}),
  };
}

export function statuslinePreview(text: string, max: number = PREVIEW_MAX): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return compact.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

export function lastMessageFromFrame(frame: MsgFrame): StatuslineLastMessage {
  return {
    from: frame.sender.name,
    ts: frame.ts,
    preview: statuslinePreview(frame.kind === "message" ? frame.body : (frame.note ?? frame.body)),
  };
}

export function unreadFromCursor(latestSeq: number | undefined | null, channel?: string | null): number | undefined {
  if (typeof latestSeq !== "number" || latestSeq <= 0 || !channel) return undefined;
  const state = readState();
  const cursor = state?.channel === channel ? state.cursor : 0;
  return Math.max(0, latestSeq - cursor);
}

export function writeStatuslineCache(patch: StatuslinePatch, cwd: string = process.cwd(), now: number = Date.now()): StatuslineCache {
  const prev = readStatuslineCache(cwd);
  const { last_message, listener, ...rest } = patch;
  const next: StatuslineCache = {
    ...(prev ?? { v: 1 }),
    ...rest,
    v: 1,
    updated_at: now,
  };
  if ("last_message" in patch) {
    if (last_message === null) delete next.last_message;
    else if (last_message !== undefined) next.last_message = last_message;
  }
  if ("listener" in patch) {
    if (listener === null) delete next.listener;
    else if (listener !== undefined) next.listener = listener;
  }

  const path = statuslineCachePath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${now}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  return next;
}

export function clearStatuslineListener(cwd: string = process.cwd()): StatuslineCache {
  return writeStatuslineCache({ listener: null }, cwd);
}

export function heartbeatPatch(
  mode: StatuslineListener["mode"],
  now: number = Date.now(),
  opts: { mentionsOnly?: boolean } = {},
): { listener: StatuslineListener } {
  return {
    listener: {
      mode,
      pid: process.pid,
      heartbeat_ts: now,
      ...(opts.mentionsOnly ? { mentions_only: true as const } : {}),
    },
  };
}
