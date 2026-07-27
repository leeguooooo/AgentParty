import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  agentpartyHome,
  readConfigWithSource,
  workspaceId,
  type ConfigSourceInfo,
} from "./config";

function safeChannel(channel: string): string {
  return channel.replace(/[^a-zA-Z0-9._-]/g, "_") || "channel";
}

export type CacheSlotKind = "health" | "statusline" | "upgrade-hint";

export function cacheSlotFileName(
  kind: CacheSlotKind,
  channel: string,
  source: Pick<ConfigSourceInfo, "kind" | "path" | "token_fingerprint">,
): string {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ channel, kind: source.kind, path: source.path, token: source.token_fingerprint }))
    .digest("hex")
    .slice(0, 16);
  return `${kind}-${safeChannel(channel)}-${fingerprint}.json`;
}

export function cacheSlotPath(kind: CacheSlotKind, channel: string, cwd: string): string {
  const { source } = readConfigWithSource(cwd);
  return join(agentpartyHome(), "state", workspaceId(cwd), "slots", cacheSlotFileName(kind, channel, source));
}
