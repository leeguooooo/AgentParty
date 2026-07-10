import { refreshDesktopSession, type DesktopCredentialVault } from "./desktopCredentials";
import { runSingleFlight } from "./desktopPairing";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function initialTokenForRuntime(desktop: boolean, readBrowserToken: () => string | null): string | null {
  return desktop ? null : readBrowserToken();
}

export function restoreDesktopAccess(
  vault: DesktopCredentialVault,
  allowedOrigins: readonly string[],
  fetcher: Fetcher = fetch,
): Promise<string | null> {
  return runSingleFlight("desktop-startup-refresh", () => refreshDesktopSession(vault, allowedOrigins, fetcher));
}
