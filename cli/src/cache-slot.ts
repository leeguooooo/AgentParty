import { createHash } from "node:crypto";
import { join } from "node:path";
import { agentpartyHome, readConfigWithSource, workspaceId } from "./config";

function safeChannel(channel: string): string {
  return channel.replace(/[^a-zA-Z0-9._-]/g, "_") || "channel";
}

export function cacheSlotPath(kind: "health" | "statusline", channel: string, cwd: string): string {
  const { source } = readConfigWithSource(cwd);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ channel, kind: source.kind, path: source.path, token: source.token_fingerprint }))
    .digest("hex")
    .slice(0, 16);
  return join(agentpartyHome(), "state", workspaceId(cwd), "slots", `${kind}-${safeChannel(channel)}-${fingerprint}.json`);
}
