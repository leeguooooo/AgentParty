import { isAllowlistedServerOrigin } from "./desktopPairing";

export interface DesktopTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  session_id?: string | null;
  token_type?: string;
}

export interface DesktopCredential {
  refreshToken: string;
  deviceSecret: string;
  serverOrigin: string;
  sessionId: string | null;
}

export interface DesktopCredentialVault {
  read(): Promise<DesktopCredential | null>;
  write(credential: DesktopCredential): Promise<void>;
  delete(): Promise<void>;
}

export type DesktopInvoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function parseCredential(raw: string | null): DesktopCredential | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<DesktopCredential>;
    if (
      typeof value.refreshToken !== "string" ||
      typeof value.deviceSecret !== "string" ||
      typeof value.serverOrigin !== "string" ||
      (value.sessionId !== null && typeof value.sessionId !== "string")
    ) {
      throw new Error("invalid credential shape");
    }
    return {
      refreshToken: value.refreshToken,
      deviceSecret: value.deviceSecret,
      serverOrigin: value.serverOrigin,
      sessionId: value.sessionId ?? null,
    };
  } catch {
    throw new Error("desktop credential is invalid");
  }
}

export function createInvokeCredentialVault(invoke: DesktopInvoker): DesktopCredentialVault {
  return {
    async read() {
      return parseCredential(await invoke<string | null>("desktop_credential_read"));
    },
    async write(credential) {
      await invoke<null>("desktop_credential_write", { credential: JSON.stringify(credential) });
    },
    async delete() {
      await invoke<null>("desktop_credential_delete");
    },
  };
}

export const desktopCredentialVault: DesktopCredentialVault = createInvokeCredentialVault(async <T>(command: string, args?: Record<string, unknown>) => {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<T>(command, args);
});

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function credentialFromTokens(
  tokens: DesktopTokenResponse,
  deviceSecret: string,
  serverOrigin: string,
): DesktopCredential {
  if (!tokens.access_token || !tokens.refresh_token) throw new Error("desktop token response is incomplete");
  return {
    refreshToken: tokens.refresh_token,
    deviceSecret,
    serverOrigin,
    sessionId: tokens.session_id ?? null,
  };
}

export async function finishDesktopPairing(
  tokens: DesktopTokenResponse,
  deviceSecret: string,
  serverOrigin: string,
  vault: DesktopCredentialVault,
): Promise<string> {
  await vault.write(credentialFromTokens(tokens, deviceSecret, serverOrigin));
  return tokens.access_token;
}

async function readTokenResponse(response: Response, operation: string): Promise<DesktopTokenResponse> {
  if (!response.ok) throw new Error(`${operation} failed (${response.status})`);
  const tokens = (await response.json()) as DesktopTokenResponse;
  if (!tokens.access_token || !tokens.refresh_token) throw new Error(`${operation} returned incomplete tokens`);
  return tokens;
}

export async function refreshDesktopSession(
  vault: DesktopCredentialVault,
  allowedOrigins: readonly string[],
  fetcher: Fetcher = fetch,
): Promise<string | null> {
  const credential = await vault.read();
  if (credential === null) return null;
  if (!isAllowlistedServerOrigin(credential.serverOrigin, allowedOrigins)) {
    throw new Error("stored desktop server is not allowed");
  }
  const response = await fetcher(`${credential.serverOrigin}/api/desktop/sessions/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      refresh_token: credential.refreshToken,
      device_secret: credential.deviceSecret,
    }),
  });
  const tokens = await readTokenResponse(response, "desktop session refresh");
  await vault.write(credentialFromTokens(tokens, credential.deviceSecret, credential.serverOrigin));
  return tokens.access_token;
}

export interface DesktopLogoutResult {
  revoked: boolean;
  removedOnly: boolean;
}

export async function logoutDesktopSession(
  vault: DesktopCredentialVault,
  fetcher: Fetcher = fetch,
  allowedOrigins?: readonly string[],
): Promise<DesktopLogoutResult> {
  const credential = await vault.read();
  if (credential === null) return { revoked: false, removedOnly: false };
  let revoked = false;
  try {
    if (allowedOrigins !== undefined && !isAllowlistedServerOrigin(credential.serverOrigin, allowedOrigins)) {
      return { revoked: false, removedOnly: true };
    }
    const response = await fetcher(`${credential.serverOrigin}/api/desktop/sessions/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        refresh_token: credential.refreshToken,
        device_secret: credential.deviceSecret,
      }),
    });
    revoked = response.ok;
  } catch {
    revoked = false;
  } finally {
    await vault.delete();
  }
  return { revoked, removedOnly: !revoked };
}
