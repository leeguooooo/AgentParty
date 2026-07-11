import type { SocketStatus } from "./ws";

// A successful websocket fallback means the timeline can replay even when the
// initial REST page failed. Do not leave a stale error banner over live data.
export function historyFallbackRecovered(status: SocketStatus): boolean {
  return status === "open";
}
