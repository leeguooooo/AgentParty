// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { beforeEach, describe, expect, test } from "bun:test";
import { __resetDesktopPairingSingleFlightsForTests } from "./desktopPairing";
import type { DesktopCredentialVault } from "./desktopCredentials";
import { initialTokenForRuntime, restoreDesktopAccess } from "./desktopAuth";

describe("desktop app authentication integration", () => {
  beforeEach(() => __resetDesktopPairingSingleFlightsForTests());

  test("never reads the browser token store in desktop mode", () => {
    let browserReads = 0;
    expect(initialTokenForRuntime(true, () => {
      browserReads += 1;
      return "browser-token";
    })).toBeNull();
    expect(browserReads).toBe(0);

    expect(initialTokenForRuntime(false, () => "browser-token")).toBe("browser-token");
  });

  test("deduplicates StrictMode startup refresh calls", async () => {
    let reads = 0;
    let requests = 0;
    const vault: DesktopCredentialVault = {
      read: async () => {
        reads += 1;
        return {
          refreshToken: "refresh",
          deviceSecret: "device-secret",
          serverOrigin: "https://agentparty.leeguoo.com",
          sessionId: "session-1",
        };
      },
      write: async () => {},
      delete: async () => {},
    };
    const fetcher = async () => {
      requests += 1;
      await Promise.resolve();
      return new Response(JSON.stringify({
        access_token: "access",
        refresh_token: "refresh-next",
        expires_in: 600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const first = restoreDesktopAccess(vault, "https://agentparty.leeguoo.com", fetcher);
    const second = restoreDesktopAccess(vault, "https://agentparty.leeguoo.com", fetcher);
    expect(first).toBe(second);
    expect(await second).toBe("access");
    expect(reads).toBe(1);
    expect(requests).toBe(1);
  });
});
