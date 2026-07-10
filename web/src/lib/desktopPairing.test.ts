// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { beforeEach, describe, expect, test } from "bun:test";
import {
  __resetDesktopPairingSingleFlightsForTests,
  createDesktopPairing,
  createDesktopPairingSecrets,
  exchangeDesktopPairingToken,
  normalizePairingCode,
  parsePairDeepLink,
  pkceChallenge,
  pollDesktopPairing,
  reducePairingState,
  resolveAllowedVerificationUrl,
  runSingleFlight,
  type DesktopPairingState,
} from "./desktopPairing";

describe("desktop pairing PKCE", () => {
  test("matches the RFC 7636 S256 vector", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

    expect(await pkceChallenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("creates independent verifier and device secret from 32 random bytes each", async () => {
    let next = 0;
    const secrets = await createDesktopPairingSecrets((length) => {
      expect(length).toBe(32);
      const bytes = new Uint8Array(length);
      bytes.fill(next++ === 0 ? 0x11 : 0x22);
      return bytes;
    });

    expect(secrets.codeVerifier).toHaveLength(43);
    expect(secrets.deviceSecret).toHaveLength(43);
    expect(secrets.codeVerifier).not.toBe(secrets.deviceSecret);
    expect(secrets.codeChallenge).toBe(await pkceChallenge(secrets.codeVerifier));
    expect(secrets.deviceChallenge).toBe(await pkceChallenge(secrets.deviceSecret));
  });
});

describe("pairing short codes and deep links", () => {
  test("normalizes manually entered codes to XXXXX-XXXXX", () => {
    expect(normalizePairingCode(" ab12c - de34f ")).toBe("AB12C-DE34F");
    expect(normalizePairingCode("ab12cde34f")).toBe("AB12C-DE34F");
    expect(normalizePairingCode("AB12C-DE34")).toBeNull();
    expect(normalizePairingCode("AB12C-DE34!")).toBeNull();
  });

  test("accepts navigation-only pair links for an allowlisted server", () => {
    expect(parsePairDeepLink(
      "agentparty://pair/ab12c-de34f?server=https%3A%2F%2Fagentparty.leeguoo.com",
      ["https://agentparty.leeguoo.com"],
    )).toEqual({
      userCode: "AB12C-DE34F",
      serverOrigin: "https://agentparty.leeguoo.com",
    });
  });

  test("rejects unknown servers, malformed routes, and links carrying credentials", () => {
    const allowlist = ["https://agentparty.leeguoo.com"];
    expect(parsePairDeepLink("https://agentparty.leeguoo.com/pair/AB12C-DE34F", allowlist)).toBeNull();
    expect(parsePairDeepLink("agentparty://other/AB12C-DE34F", allowlist)).toBeNull();
    expect(parsePairDeepLink("agentparty://pair/AB12C-DE34F?server=https://evil.example", allowlist)).toBeNull();
    expect(parsePairDeepLink("agentparty://pair/AB12C-DE34F?token=secret", allowlist)).toBeNull();
    expect(parsePairDeepLink("agentparty://pair/AB12C-DE34F?code_verifier=secret", allowlist)).toBeNull();
    expect(parsePairDeepLink("agentparty://pair/AB12C-DE34F?device_secret=secret", allowlist)).toBeNull();
  });
});

describe("desktop pairing state machine", () => {
  const pending: DesktopPairingState = { phase: "pending", intervalSeconds: 3, error: null };

  test("tracks pending and server slow-down without losing the pairing", () => {
    expect(reducePairingState(pending, { type: "authorization_pending" })).toEqual(pending);
    expect(reducePairingState(pending, { type: "slow_down", retryAfterSeconds: 8 })).toEqual({
      phase: "slow_down",
      intervalSeconds: 8,
      error: null,
    });
  });

  test("models approval, denial, expiry, and local cancellation as terminal states", () => {
    expect(reducePairingState(pending, { type: "approved" }).phase).toBe("approved");
    expect(reducePairingState(pending, { type: "denied" }).phase).toBe("denied");
    expect(reducePairingState(pending, { type: "expired" }).phase).toBe("expired");
    expect(reducePairingState(pending, { type: "cancel" }).phase).toBe("cancelled");
  });
});

describe("desktop pairing HTTP contract", () => {
  test("creates a pairing with S256 code and device challenges", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const response = await createDesktopPairing(
      "https://agentparty.leeguoo.com",
      {
        codeVerifier: "code-verifier",
        codeChallenge: "code-challenge",
        deviceSecret: "device-secret",
        deviceChallenge: "device-challenge",
      },
      { name: "Leo's Mac", platform: "macos", appVersion: "0.2.85" },
      async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({
          pairing_id: "pair-1",
          device_code: "device-code",
          user_code: "AB12C-DE34F",
          verification_uri: "https://agentparty.leeguoo.com/pair",
          verification_uri_complete: "https://agentparty.leeguoo.com/pair?code=AB12C-DE34F",
          expires_in: 300,
          interval: 3,
        }), { status: 201, headers: { "content-type": "application/json" } });
      },
    );

    expect(calls[0]?.url).toBe("https://agentparty.leeguoo.com/api/desktop/pairings");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      code_challenge: "code-challenge",
      code_challenge_method: "S256",
      device_secret_challenge: "device-challenge",
      device: { name: "Leo's Mac", platform: "macos", app_version: "0.2.85" },
    });
    expect(response.interval).toBe(3);
    expect(response.expires_in).toBe(300);
  });

  test("maps every frozen polling status without exposing response bodies as errors", async () => {
    const statuses = [202, 429, 403, 410] as const;
    const expected = ["authorization_pending", "slow_down", "denied", "expired"];
    for (const [index, status] of statuses.entries()) {
      const result = await exchangeDesktopPairingToken(
        "https://agentparty.leeguoo.com",
        "device-code",
        "code-verifier",
        async (_url, init) => {
          expect(JSON.parse(String(init?.body))).toEqual({
            device_code: "device-code",
            code_verifier: "code-verifier",
          });
          return new Response(JSON.stringify({ error: "must-not-leak" }), {
            status,
            headers: status === 429 ? { "retry-after": "9" } : undefined,
          });
        },
      );
      expect(result.type).toBe(expected[index]);
      if (result.type === "slow_down") expect(result.retryAfterSeconds).toBe(9);
    }
  });

  test("returns approved tokens only for HTTP 200", async () => {
    const result = await exchangeDesktopPairingToken(
      "https://agentparty.leeguoo.com",
      "device-code",
      "code-verifier",
      async () => new Response(JSON.stringify({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 600,
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );

    expect(result).toEqual({
      type: "approved",
      tokens: { access_token: "access", refresh_token: "refresh", expires_in: 600 },
    });
  });

  test("opens only an allowlisted HTTP(S) verification URL", () => {
    const allowlist = ["https://agentparty.leeguoo.com"];
    expect(resolveAllowedVerificationUrl(
      "https://agentparty.leeguoo.com/pair?code=AB12C-DE34F",
      allowlist,
    )).toBe("https://agentparty.leeguoo.com/pair?code=AB12C-DE34F");
    expect(resolveAllowedVerificationUrl("https://evil.example/pair", allowlist)).toBeNull();
    expect(resolveAllowedVerificationUrl("javascript:alert(1)", allowlist)).toBeNull();
    expect(resolveAllowedVerificationUrl("https://agentparty.leeguoo.com@evil.example/pair", allowlist)).toBeNull();
  });
});

describe("desktop pairing polling loop", () => {
  test("waits at the advertised interval and honors 429 slow-down before approval", async () => {
    const waits: number[] = [];
    const events: string[] = [];
    const responses = [
      { type: "authorization_pending" as const },
      { type: "slow_down" as const, retryAfterSeconds: 9 },
      {
        type: "approved" as const,
        tokens: { access_token: "access", refresh_token: "refresh", expires_in: 600 },
      },
    ];
    const result = await pollDesktopPairing({
      intervalSeconds: 3,
      expiresInSeconds: 300,
      signal: new AbortController().signal,
      wait: async (seconds) => { waits.push(seconds); },
      exchange: async () => responses.shift() ?? { type: "expired" },
      onEvent: (event) => { events.push(event.type); },
    });

    expect(result.type).toBe("approved");
    expect(waits).toEqual([3, 3, 9]);
    expect(events).toEqual(["authorization_pending", "slow_down", "approved"]);
  });

  test("stops locally cancelled polling before another token request", async () => {
    const controller = new AbortController();
    let exchanges = 0;
    const result = await pollDesktopPairing({
      intervalSeconds: 3,
      expiresInSeconds: 300,
      signal: controller.signal,
      wait: async () => { controller.abort(); },
      exchange: async () => {
        exchanges += 1;
        return { type: "authorization_pending" };
      },
      onEvent: () => {},
    });

    expect(result).toEqual({ type: "cancelled" });
    expect(exchanges).toBe(0);
  });

  test("recovers a lost successful response with the same device proof", async () => {
    const requestBodies: string[] = [];
    const waits: number[] = [];
    const events: string[] = [];
    const recoveredTokens = {
      access_token: "recovered-access",
      refresh_token: "recovered-refresh",
      expires_in: 600,
      session_id: "session-1",
    };
    let exchanges = 0;
    const exchange = () => exchangeDesktopPairingToken(
      "https://agentparty.leeguoo.com",
      "same-device-code",
      "same-code-verifier",
      async (_input, init) => {
        exchanges += 1;
        requestBodies.push(String(init?.body));
        if (exchanges === 1) {
          // The server committed this exchange, but the response was lost in transit.
          throw new TypeError("network connection closed after commit");
        }
        return new Response(JSON.stringify(recoveredTokens), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );

    const result = await pollDesktopPairing({
      intervalSeconds: 3,
      expiresInSeconds: 300,
      signal: new AbortController().signal,
      wait: async (seconds) => { waits.push(seconds); },
      exchange,
      onEvent: (event) => { events.push(event.type); },
    });

    expect(result).toEqual({ type: "approved", tokens: recoveredTokens });
    expect(exchanges).toBe(2);
    expect(waits).toEqual([3, 3]);
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toBe(requestBodies[1]);
    expect(JSON.parse(requestBodies[0]!)).toEqual({
      device_code: "same-device-code",
      code_verifier: "same-code-verifier",
    });
    expect(events).toEqual(["approved"]);
  });

  test("keeps retrying transient exchange failures through the 60 second recovery window", async () => {
    let now = 0;
    let exchanges = 0;
    const result = await pollDesktopPairing({
      intervalSeconds: 3,
      expiresInSeconds: 61,
      signal: new AbortController().signal,
      wait: async (seconds) => { now += seconds * 1000; },
      exchange: () => exchangeDesktopPairingToken(
        "https://agentparty.leeguoo.com",
        "same-device-code",
        "same-code-verifier",
        async () => {
          exchanges += 1;
          if (exchanges < 20) throw new TypeError("transient network failure");
          return new Response(JSON.stringify({
            access_token: "access",
            refresh_token: "refresh",
            expires_in: 600,
          }), { status: 200 });
        },
      ),
      onEvent: () => {},
      now: () => now,
    });

    expect(now).toBe(60_000);
    expect(exchanges).toBe(20);
    expect(result.type).toBe("approved");
  });

  test("honors abort during a transient exchange failure", async () => {
    const controller = new AbortController();
    let exchanges = 0;
    const result = await pollDesktopPairing({
      intervalSeconds: 3,
      expiresInSeconds: 300,
      signal: controller.signal,
      wait: async () => {},
      exchange: (signal) => exchangeDesktopPairingToken(
        "https://agentparty.leeguoo.com",
        "device-code",
        "code-verifier",
        async () => {
          exchanges += 1;
          controller.abort();
          throw new DOMException("aborted", "AbortError");
        },
        signal,
      ),
      onEvent: () => {},
    });

    expect(result).toEqual({ type: "cancelled" });
    expect(exchanges).toBe(1);
  });

  test("does not retry terminal or invalid 4xx exchange responses", async () => {
    for (const [status, expected] of [[403, "denied"], [410, "expired"]] as const) {
      let exchanges = 0;
      const result = await pollDesktopPairing({
        intervalSeconds: 3,
        expiresInSeconds: 300,
        signal: new AbortController().signal,
        wait: async () => {},
        exchange: () => exchangeDesktopPairingToken(
          "https://agentparty.leeguoo.com",
          "device-code",
          "code-verifier",
          async () => {
            exchanges += 1;
            return new Response(null, { status });
          },
        ),
        onEvent: () => {},
      });
      expect(result.type).toBe(expected);
      expect(exchanges).toBe(1);
    }

    let invalidProofExchanges = 0;
    await expect(pollDesktopPairing({
      intervalSeconds: 3,
      expiresInSeconds: 300,
      signal: new AbortController().signal,
      wait: async () => {},
      exchange: () => exchangeDesktopPairingToken(
        "https://agentparty.leeguoo.com",
        "device-code",
        "bad-verifier",
        async () => {
          invalidProofExchanges += 1;
          return new Response(null, { status: 400 });
        },
      ),
      onEvent: () => {},
    })).rejects.toThrow("failed (400)");
    expect(invalidProofExchanges).toBe(1);
  });
});

describe("StrictMode single-flight", () => {
  beforeEach(() => __resetDesktopPairingSingleFlightsForTests());

  test("shares one startup operation across duplicate effects and clears after settlement", async () => {
    let calls = 0;
    let release!: (value: number) => void;
    const operation = () => {
      calls += 1;
      return new Promise<number>((resolve) => { release = resolve; });
    };

    const first = runSingleFlight("desktop-startup", operation);
    const second = runSingleFlight("desktop-startup", operation);
    expect(calls).toBe(1);
    expect(first).toBe(second);
    release(7);
    expect(await second).toBe(7);

    expect(await runSingleFlight("desktop-startup", async () => 9)).toBe(9);
    expect(calls).toBe(1);
  });
});
