import { normalizePairingCode } from "./desktopPairing";
import { normalizeServerOrigin } from "./serverProfiles";

const PENDING_PAIR_CODE_KEY = "ap_pending_pair_code";
const PENDING_PAIR_ROUTE_KEY = "ap_pending_pair_route";
const PENDING_PAIR_SERVER_KEY = "ap_pending_pair_server";

export interface PendingPairingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PendingPairing {
  code: string | null;
  routePending: boolean;
  serverOrigin: string | null;
}

export function readPendingPairing(storage: PendingPairingStorage = sessionStorage): PendingPairing {
  return {
    code: normalizePairingCode(storage.getItem(PENDING_PAIR_CODE_KEY) ?? ""),
    routePending: storage.getItem(PENDING_PAIR_ROUTE_KEY) === "1",
    serverOrigin: normalizeServerOrigin(storage.getItem(PENDING_PAIR_SERVER_KEY) ?? ""),
  };
}

export function rememberPendingPairing(
  storage: PendingPairingStorage = sessionStorage,
  input: { code?: string | null; serverOrigin?: string | null },
): PendingPairing {
  storage.setItem(PENDING_PAIR_ROUTE_KEY, "1");
  if (input.code !== undefined) {
    const code = normalizePairingCode(input.code ?? "");
    if (code === null) storage.removeItem(PENDING_PAIR_CODE_KEY);
    else storage.setItem(PENDING_PAIR_CODE_KEY, code);
  }
  if (input.serverOrigin !== undefined) {
    const origin = normalizeServerOrigin(input.serverOrigin ?? "");
    if (origin === null) storage.removeItem(PENDING_PAIR_SERVER_KEY);
    else storage.setItem(PENDING_PAIR_SERVER_KEY, origin);
  }
  return readPendingPairing(storage);
}

export function clearPendingPairing(storage: PendingPairingStorage = sessionStorage): void {
  storage.removeItem(PENDING_PAIR_ROUTE_KEY);
  storage.removeItem(PENDING_PAIR_CODE_KEY);
  storage.removeItem(PENDING_PAIR_SERVER_KEY);
}
