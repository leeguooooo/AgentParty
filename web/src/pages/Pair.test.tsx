// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleProvider } from "../i18n/locale";
import { PairStrings } from "../i18n/strings/Pair";
import {
  decideDesktopPairing,
  extractPairingCodeAndSanitizeUrl,
  inspectDesktopPairing,
  PairHumanRequiredAction,
  PairingReview,
  PairPage,
  type PairingInspection,
} from "./Pair";

const inspection: PairingInspection = {
  pairing_id: "pair-1",
  user_code: "AB12C-DE34F",
  device: {
    name: "Leo's Mac",
    platform: "macos",
    app_version: "0.2.85",
  },
  expires_at: "2026-07-10T12:00:00Z",
};

describe("pair URL handling", () => {
  test("reads and normalizes the code while removing it from the address immediately", () => {
    expect(extractPairingCodeAndSanitizeUrl(
      "https://agentparty.leeguoo.com/pair?code=ab12c-de34f&lang=zh#review",
    )).toEqual({
      userCode: "AB12C-DE34F",
      sanitizedPath: "/pair?lang=zh#review",
    });
  });

  test("removes an invalid code too", () => {
    expect(extractPairingCodeAndSanitizeUrl(
      "https://agentparty.leeguoo.com/pair?user_code=not-valid",
    )).toEqual({ userCode: null, sanitizedPath: "/pair" });
  });
});

describe("pairing approval HTTP contract", () => {
  test("inspects a normalized short code with a human bearer", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await inspectDesktopPairing("https://party.example.com", "human-token", "ab12cde34f", async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        pairing_id: inspection.pairing_id,
        device: inspection.device,
        expires_in: 300,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    expect(result).toEqual({
      pairing_id: inspection.pairing_id,
      user_code: inspection.user_code,
      device: inspection.device,
      expires_in: 300,
    });
    expect(calls[0]?.url).toBe("https://party.example.com/api/desktop/pairings/inspect");
    expect(calls[0]?.init?.headers).toEqual({
      authorization: "Bearer human-token",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ user_code: "AB12C-DE34F" });
  });

  test("sends an explicit approve or deny decision with both pairing identifiers", async () => {
    for (const decision of ["approve", "deny"] as const) {
      let body: unknown;
      await decideDesktopPairing("https://party.example.com", "human-token", inspection, decision, async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(null, { status: 204 });
      });
      expect(body).toEqual({
        pairing_id: "pair-1",
        user_code: "AB12C-DE34F",
        decision,
      });
    }
  });
});

describe("PairPage", () => {
  test("registers complete independent English and Chinese copy", () => {
    const keys = [
      "Pair.title",
      "Pair.code.label",
      "Pair.inspect",
      "Pair.inspect.useHuman",
      "Pair.approve",
      "Pair.deny",
      "Pair.device.name",
      "Pair.status.approved",
      "Pair.status.denied",
    ];
    for (const locale of ["en", "zh"] as const) {
      for (const key of keys) expect(PairStrings[locale][key]).toBeTruthy();
    }
  });

  test("renders a keyboard and mobile friendly manual-code form", () => {
    const html = renderToStaticMarkup(
      <LocaleProvider>
        <PairPage serverOrigin="https://party.example.com" token="human-token" initialCode={null} />
      </LocaleProvider>,
    );
    expect(html).toContain('action="/pair"');
    expect(html).toContain('inputMode="text"');
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain('maxLength="11"');
    expect(html).toContain("XXXXX-XXXXX");
  });

  test("shows inspectable device metadata and separate approve and deny commands", () => {
    const html = renderToStaticMarkup(
      <LocaleProvider>
        <PairingReview inspection={inspection} pending={false} onDecision={() => {}} />
      </LocaleProvider>,
    );
    expect(html).toContain("Leo&#x27;s Mac");
    expect(html).toContain("macos");
    expect(html).toContain("0.2.85");
    expect(html).toContain("Approve this device");
    expect(html).toContain("Reject");
    expect(html).toContain('class="d-btn pair-deny"');
  });

  test("renders an explicit human-account switch for a rejected non-human token", () => {
    const html = renderToStaticMarkup(
      <LocaleProvider>
        <PairHumanRequiredAction code="AB12C-DE34F" onRequireHuman={() => {}} />
      </LocaleProvider>,
    );
    expect(html).toContain("Switch to a human account");
    expect(html).toContain('class="d-btn pair-human-login"');
  });
});
